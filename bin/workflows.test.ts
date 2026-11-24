import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { gzipSync } from "node:zlib";

// The workflows are read as text, without a YAML parser: every lookup asserts that it found what
// it reads, so a reshaped file fails here instead of passing vacuously.

const ROOT = path.join(import.meta.dirname, "..");
const WORKFLOWS = ".github/workflows";
const CI_FILE = `${WORKFLOWS}/ci.yml`;
const PUBLISH_FILE = `${WORKFLOWS}/publish.yml`;
const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):\s*$/;
// A step's first line, also a bare "-" whose keys start on the next line.
const STEP_START = /^ {6}-(?:\s|$)/;
const PACKAGE_FILES = [
  "package/LICENSE",
  "package/README.md",
  "package/THIRD_PARTY_NOTICES.md",
  "package/foxleash.mjs",
  "package/package.json",
];
const CLEAN_MANIFEST = '{"name":"foxleash","version":"1.2.3"}';
const ADDON_ID = "foxleash@mattiasw.com";

// owner/repo[/path]@<40-hex commit> # v<version>. The owner is a GitHub account name and no
// segment is only dots, so neither a local action (./...), which the runner takes as a path
// whatever follows, nor a path the runner joins its way out of the action's directory can pass.
const PINNED =
  /^\s*(?:-\s+)?uses:\s+[A-Za-z0-9][A-Za-z0-9-]*(?:\/(?!\.+[/@])[A-Za-z0-9_.-]+)+@[0-9a-f]{40} # v\d+(?:\.\d+)*\s*$/;
const SCOPE = /^[a-z][a-z-]*: (?:read|write|none)$/;
// YAML's whitespace is space and tab; trim() also strips Unicode spaces, which YAML reads as
// content, so a # after one starts no comment.
const COMMENT = /^[ \t]*#/;

// Listed rather than globbed: a glob skips dot-named files and matches the extension's case.
const FILES = readdirSync(path.join(ROOT, WORKFLOWS))
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort()
  .map((name) => `${WORKFLOWS}/${name}`);

describe("the workflows run with a token they declare and actions pinned by commit", () => {
  test("the workflow files include ci.yml", () => {
    assert.ok(
      FILES.includes(CI_FILE),
      `no ci.yml found in ${WORKFLOWS} (found ${JSON.stringify(FILES)}), so the other checks may be running on nothing`,
    );
  });

  test("every workflow breaks lines only where these checks split them", () => {
    const offenders = FILES.filter((file) => hasOtherLineBreak(read(file)));
    assert.deepEqual(
      offenders,
      [],
      "break lines with \\n or \\r\\n only: YAML also breaks at a lone \\r, U+0085, U+2028 or U+2029, which these checks read as part of one line, so a line after a comment there would go unchecked",
    );
  });

  test("every workflow declares its own token permissions", () => {
    const offenders = FILES.filter((file) => !ownsPermissions(read(file)));
    assert.deepEqual(
      offenders,
      [],
      "each workflow needs exactly one top-level permissions: key, either permissions: {} or a block listing its scopes, so it does not run with the repository's default token",
    );
  });

  test("ci.yml's default token may only read contents", () => {
    const scopes = topLevelPermissions(read(CI_FILE));
    assert.ok(scopes !== undefined, `${CI_FILE} has no top-level permissions: block`);
    assert.deepEqual(
      scopes,
      ["contents: read"],
      `${CI_FILE}'s top-level permissions must be exactly contents: read; a job that needs more says so in its own block`,
    );
  });

  test("every action is named by a commit, with its release tag in a comment", () => {
    const offenders = FILES.flatMap((file) =>
      unpinnedUses(read(file)).map((line) => `${file}:${line}`),
    );
    assert.deepEqual(
      offenders,
      [],
      "name each action by the commit its release tag points to, with the tag in a comment: uses: owner/repo@<40-hex commit> # v1.2.3",
    );
  });

  test("ci.yml uses actions, so the pin check reads something", () => {
    assert.ok(
      usesLines(read(CI_FILE)).length > 0,
      `${CI_FILE} has no uses: line this test can see`,
    );
  });
});

describe("publish.yml publishes only from a published release, with the identity token only where no project code runs", () => {
  const source = read(PUBLISH_FILE);
  const jobs = jobBlocks(source);
  const publish = jobs.get("publish") ?? [];
  const build = jobs.get("build") ?? [];

  test("the workflow files include publish.yml", () => {
    assert.ok(FILES.includes(PUBLISH_FILE), `no publish.yml found in ${WORKFLOWS}`);
  });

  test("its only trigger is a published release", () => {
    const keys = source
      .split("\n")
      .filter((line) => /^(?:\?\s+)?["']?on["']?\s*(?::|$)/.test(line));
    assert.equal(keys.length, 1, "publish.yml needs exactly one top-level on: key");
    assert.deepEqual(topLevelBlock(source, "on"), ["release:", "types: [published]"]);
  });

  test("its top-level keys are exactly these, so no env: or other default reaches its jobs", () => {
    assert.deepEqual(
      source
        .split("\n")
        .filter((line) => line.trim() !== "" && !COMMENT.test(line) && !/^[ \t]/.test(line))
        .map((line) => line.replace(/\s+$/, "")),
      ["name: Publish npm package", "on:", "permissions: {}", "concurrency:", "defaults:", "jobs:"],
    );
  });

  test("its top-level permissions are empty, so each job declares its own", () => {
    assert.ok(
      source.split("\n").some((line) => /^permissions:\s*\{\}\s*$/.test(line)),
      "publish.yml needs permissions: {} at the top level",
    );
    assert.equal(topLevelPermissions(source), undefined);
  });

  test("every script runs in bash with pipefail", () => {
    assert.deepEqual(topLevelBlock(source, "defaults"), ["run:", "shell: bash"]);
    assert.deepEqual(
      source.split("\n").filter((line) => /^\s+shell:/.test(line)),
      ["    shell: bash"],
      "no step may choose its own shell",
    );
  });

  test("its jobs are exactly build and publish", () => {
    assert.deepEqual([...jobs.keys()], ["build", "publish"]);
    assert.deepEqual(strayJobLines(source), [], "every job is a plain block under jobs:");
  });

  test("only publish holds the identity token, and every job declares its permissions once", () => {
    for (const [name, body] of jobs) {
      const keys = body.filter((line) =>
        /^ {4}(?:\?\s+)?["']?permissions["']?\s*(?::|$)/.test(line),
      );
      assert.equal(keys.length, 1, `job ${name} needs exactly one permissions: key`);
      const scopes = jobPermissions(body);
      assert.ok(scopes !== undefined, `job ${name}'s permissions must be {} or a block of scopes`);
      assert.ok(
        scopes.every((scope) => SCOPE.test(scope)),
        `job ${name}: ${JSON.stringify(scopes)}`,
      );
    }
    const holders = [...jobs]
      .filter(([, body]) => jobPermissions(body)?.includes("id-token: write"))
      .map(([name]) => name);
    assert.deepEqual(holders, ["publish"]);
    assert.deepEqual(jobPermissions(publish), ["id-token: write"]);
  });

  test("the build job may only read contents", () => {
    assert.deepEqual(jobPermissions(build), ["contents: read"]);
  });

  test("build checks the tag and AMO before it runs the gates, builds and packs", () => {
    assert.deepEqual(stepNames(build).map(withoutPin), [
      "- uses: actions/checkout@<pin>",
      "- uses: actions/setup-node@<pin>",
      "- run: npm ci",
      "- name: Check the tag",
      "- name: Wait until AMO serves the version publicly",
      "- run: npm run lint",
      "- run: npm run typecheck",
      "- run: npm test",
      "- run: npm run build -w @foxleash/server",
      "- name: Pack the package",
      "- uses: actions/upload-artifact@<pin>",
    ]);
  });

  test("publish needs build, runs in the npm environment and runs no checkout", () => {
    assert.equal(jobValue(publish, "environment"), "npm");
    assert.equal(jobValue(publish, "needs"), "build");
    const actions = usesLines(publish.join("\n")).map(([, line]) => line.trim());
    assert.equal(actions.length, 2, JSON.stringify(actions));
    assert.ok(
      actions.every((line) => /^- uses: actions\/(?:setup-node|download-artifact)@/.test(line)),
      `publish may use only setup-node and download-artifact: ${JSON.stringify(actions)}`,
    );
  });

  test("publish checks npm and the package before it publishes", () => {
    assert.deepEqual(stepNames(publish).map(withoutPin), [
      "- uses: actions/setup-node@<pin>",
      "- name: Check npm",
      "- uses: actions/download-artifact@<pin>",
      "- name: Check the package",
      "- name: Publish",
    ]);
  });

  test("publish is exactly these lines, so no step or setting runs project code or reaches the token unseen", () => {
    assert.deepEqual(publish.filter((line) => line.trim() !== "").map(withoutPin), [
      "    needs: build",
      "    runs-on: ubuntu-latest",
      "    timeout-minutes: 10",
      "    environment: npm",
      "    permissions:",
      "      id-token: write",
      "    steps:",
      "      - uses: actions/setup-node@<pin>",
      "        with:",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      "          node-version: ${{ needs.build.outputs.node-version }}",
      "          registry-url: https://registry.npmjs.org",
      "      - name: Check npm",
      "        run: |",
      "          NPM_VERSION=$(npm --version)",
      '          if ! [[ "$NPM_VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]] ||',
      "            ! printf '%s\\n' 11.5.1 \"$NPM_VERSION\" | sort -V -C; then",
      '            echo "::error::npm $NPM_VERSION is older than 11.5.1, the first npm with trusted publishing."',
      "            exit 1",
      "          fi",
      "      - uses: actions/download-artifact@<pin>",
      "        with:",
      "          name: npm-package",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      "          path: ${{ runner.temp }}/npm-package",
      "      - name: Check the package",
      "        env:",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      "          TAG: ${{ github.ref_name }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      "          VERSION: ${{ needs.build.outputs.version }}",
      "        run: |",
      '          if ! [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]] || [ "$TAG" != "v$VERSION" ]; then',
      "            echo \"::error::the build's version is not x.y.z, or the release's tag is not v and that version.\"",
      "            exit 1",
      "          fi",
      "          EXPECTED=$'package/LICENSE\\npackage/README.md\\npackage/THIRD_PARTY_NOTICES.md\\npackage/foxleash.mjs\\npackage/package.json'",
      "          check_tarball() {",
      "            shopt -s nullglob dotglob",
      '            local files=("$1"/*)',
      '            local tarball="$1/foxleash-$VERSION.tgz"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion
      '            if [ "${#files[@]}" -ne 1 ] || [ "${files[0]}" != "$tarball" ] || [ ! -f "$tarball" ] || [ -L "$tarball" ]; then',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion
      '              echo "::error::$1 must hold exactly one file, foxleash-$VERSION.tgz; it holds ${#files[@]}."',
      "              exit 1",
      "            fi",
      "            local entries",
      '            entries=$(tar --ignore-zeros -tzf "$tarball" | LC_ALL=C sort)',
      '            if [ "$entries" != "$EXPECTED" ]; then',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion
      "              echo \"Entries found: ${entries//$'\\n'/ }\"",
      '              echo "::error::foxleash-$VERSION.tgz must hold exactly the five package files, each once."',
      "              exit 1",
      "            fi",
      "            local listing line",
      '            listing=$(tar --ignore-zeros -tvzf "$tarball")',
      "            while IFS= read -r line; do",
      '              if [[ "$line" != -* ]]; then',
      '                echo "::error::every entry of foxleash-$VERSION.tgz must be a regular file."',
      "                exit 1",
      "              fi",
      '            done <<< "$listing"',
      "          }",
      '          check_tarball "$RUNNER_TEMP/npm-package"',
      '          UNPACKED="$RUNNER_TEMP/npm-unpacked"',
      '          mkdir "$UNPACKED"',
      '          tar --ignore-zeros -xzf "$RUNNER_TEMP/npm-package/foxleash-$VERSION.tgz" --no-same-owner -C "$UNPACKED" -- \\',
      "            package/LICENSE package/README.md package/THIRD_PARTY_NOTICES.md package/foxleash.mjs package/package.json",
      '          if ! jq -e -s --arg version "$VERSION" \\',
      '            \'length == 1 and (.[0] | type == "object" and (has("publishConfig") | not) and (has("scripts") | not) and .name == "foxleash" and .version == $version)\' \\',
      '            "$UNPACKED/package/package.json" > /dev/null; then',
      '            echo "::error::package/package.json must be one JSON object with no publishConfig and no scripts, name foxleash and version $VERSION."',
      "            exit 1",
      "          fi",
      '          mkdir "$RUNNER_TEMP/npm-publish"',
      '          npm pack "$UNPACKED/package" --ignore-scripts --pack-destination "$RUNNER_TEMP/npm-publish"',
      '          check_tarball "$RUNNER_TEMP/npm-publish"',
      "      - name: Publish",
      "        env:",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
      "          VERSION: ${{ needs.build.outputs.version }}",
      '        run: npm publish "$RUNNER_TEMP/npm-publish/foxleash-$VERSION.tgz" --provenance --access public --ignore-scripts',
    ]);
    const publishes = publish.filter((line) => /^\s*(?:run: )?npm publish\b/.test(line));
    assert.equal(publishes.length, 1, JSON.stringify(publishes));
    assert.match(
      publishes[0] ?? "",
      /^ {8}run: npm publish "\$RUNNER_TEMP\/npm-publish\/[^"]+\.tgz" /,
    );
    assert.match(publishes[0] ?? "", / --provenance(?: |$)/);
  });

  test("no token is stored for it", () => {
    assert.deepEqual(
      source.split("\n").filter((line) => /\bsecrets\b|NODE_AUTH_TOKEN/.test(line)),
      [],
    );
  });
});

describe("publish.yml's checks refuse what they must", () => {
  const source = read(PUBLISH_FILE);
  const jobs = jobBlocks(source);
  const build = jobs.get("build") ?? [];
  const publish = jobs.get("publish") ?? [];

  describe("Check the package", () => {
    const script = stepScript(publish, "Check the package");

    function check(
      tarball: Buffer,
      options: { tag?: string; version?: string; name?: string; extra?: string } = {},
    ): StepRun {
      return runStep(script, ({ temp }) => {
        const downloaded = path.join(temp, "npm-package");
        mkdirSync(downloaded);
        writeFileSync(path.join(downloaded, options.name ?? "foxleash-1.2.3.tgz"), tarball);
        if (options.extra !== undefined) writeFileSync(path.join(downloaded, options.extra), "x");
        return { TAG: options.tag ?? "v1.2.3", VERSION: options.version ?? "1.2.3" };
      });
    }

    test("passes a clean package and packs the checked files again", () => {
      const run = check(tarball(packageEntries()));
      assert.equal(run.status, 0, run.output);
      assert.deepEqual(run.published?.names, PACKAGE_FILES);
      assert.equal(run.published?.manifest, CLEAN_MANIFEST);
    });

    const refused: Array<[string, Buffer, Parameters<typeof check>[1], RegExp]> = [
      [
        "a publishConfig",
        tarball(
          packageEntries({
            "package/package.json":
              '{"name":"foxleash","version":"1.2.3","publishConfig":{"registry":"https://registry.example/"}}',
          }),
        ),
        {},
        /package\/package\.json must be/,
      ],
      [
        "scripts",
        tarball(
          packageEntries({
            "package/package.json":
              '{"name":"foxleash","version":"1.2.3","scripts":{"prepublishOnly":"x"}}',
          }),
        ),
        {},
        /package\/package\.json must be/,
      ],
      [
        "another name",
        tarball(
          packageEntries({ "package/package.json": '{"name":"foxleash2","version":"1.2.3"}' }),
        ),
        {},
        /package\/package\.json must be/,
      ],
      [
        "another version",
        tarball(
          packageEntries({ "package/package.json": '{"name":"foxleash","version":"1.2.4"}' }),
        ),
        {},
        /package\/package\.json must be/,
      ],
      [
        "two JSON values",
        tarball(packageEntries({ "package/package.json": `${CLEAN_MANIFEST}{}` })),
        {},
        /package\/package\.json must be/,
      ],
      [
        "a package.json that is not JSON",
        tarball(packageEntries({ "package/package.json": '{"name":' })),
        {},
        /package\/package\.json must be/,
      ],
      [
        "a sixth entry",
        tarball([...packageEntries(), { name: "package/extra.js", data: "x" }]),
        {},
        /must hold exactly the five package files/,
      ],
      [
        "a missing entry",
        tarball(packageEntries().filter((entry) => entry.name !== "package/LICENSE")),
        {},
        /must hold exactly the five package files/,
      ],
      [
        "a duplicate entry",
        tarball([...packageEntries(), { name: "package/LICENSE", data: "again" }]),
        {},
        /must hold exactly the five package files/,
      ],
      [
        "a symlink entry",
        tarball(
          packageEntries().map((entry) =>
            entry.name === "package/README.md"
              ? { name: entry.name, data: "", type: "2", linkname: "/etc/passwd" }
              : entry,
          ),
        ),
        {},
        /must be a regular file/,
      ],
      [
        "a second file in the download",
        tarball(packageEntries()),
        { extra: ".npmrc" },
        /must hold exactly one file/,
      ],
      [
        "a second tarball after it in the download",
        tarball(packageEntries()),
        { extra: "foxleash-1.2.4.tgz" },
        /must hold exactly one file/,
      ],
      [
        "a tarball of another version",
        tarball(packageEntries()),
        { name: "foxleash-1.2.4.tgz" },
        /must hold exactly one file/,
      ],
      ["a tag of another version", tarball(packageEntries()), { tag: "v1.2.4" }, /tag is not/],
      ["a version that is not x.y.z", tarball(packageEntries()), { version: "1.2" }, /not x\.y\.z/],
      [
        "a prerelease version, though the tag, the file name and package.json agree on it",
        tarball(
          packageEntries({
            "package/package.json": '{"name":"foxleash","version":"1.2.3-rc.1"}',
          }),
        ),
        { tag: "v1.2.3-rc.1", version: "1.2.3-rc.1", name: "foxleash-1.2.3-rc.1.tgz" },
        /not x\.y\.z/,
      ],
      [
        "entries after a lone zero block",
        tarball([
          ...packageEntries(),
          {
            name: "package/package.json",
            data: '{"name":"foxleash","version":"1.2.3","publishConfig":{"registry":"https://registry.example/"},"scripts":{"x":"y"}}',
            zeroBlockBefore: true,
          },
        ]),
        {},
        /must hold exactly the five package files/,
      ],
    ];
    for (const [name, input, options, error] of refused) {
      test(`refuses ${name}`, () => {
        const run = check(input, options);
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.stdout, error);
        assert.equal(run.published, undefined, "a refused package must not be packed for npm");
      });
    }

    test("packs only what GNU tar read, where npm would read an entry hidden in another", () => {
      const hidden = tarEntry({
        name: "package/package.json",
        data: '{"name":"foxleash","version":"1.2.3","publishConfig":{"registry":"https://registry.example/"}}',
      });
      const run = check(
        tarball(
          packageEntries().map((entry) =>
            entry.name === "package/README.md"
              ? { name: entry.name, data: hidden, signedChecksum: true }
              : entry,
          ),
        ),
      );
      assert.equal(run.status, 0, run.output);
      assert.equal(run.published?.manifest, CLEAN_MANIFEST);
      assert.deepEqual(
        run.published?.npmNames,
        PACKAGE_FILES.map((name) => name.slice("package/".length)),
      );
    });
  });

  describe("Check npm", () => {
    const script = stepScript(publish, "Check npm");

    for (const version of ["11.5.1", "11.16.0", "12.0.0"]) {
      test(`accepts npm ${version}`, () => {
        const run = runStep(script, () => ({ FAKE_NPM_VERSION: version }));
        assert.equal(run.status, 0, run.output);
      });
    }

    for (const version of ["11.5.0", "11.4.2", "10.99.99", "11.5.1-pre", ""]) {
      test(`refuses npm ${JSON.stringify(version)}`, () => {
        const run = runStep(script, () => ({ FAKE_NPM_VERSION: version }));
        assert.equal(run.status, 1, run.output);
        assert.match(run.stdout, /^::error::npm .* is older than 11\.5\.1/m);
      });
    }
  });

  describe("Check the tag", () => {
    const script = stepScript(build, "Check the tag");

    function tagStep(options: { status?: number; nvmrc?: string } = {}): StepRun {
      return runStep(script, ({ work }) => {
        writeFileSync(path.join(work, ".nvmrc"), options.nvmrc ?? "24\n");
        return { TAG: "v1.2.3", FAKE_NPM_STATUS: String(options.status ?? 0) };
      });
    }

    test("runs the tag check, then passes on the version and the Node version", () => {
      const run = tagStep();
      assert.equal(run.status, 0, run.output);
      assert.deepEqual(run.calls, ["npm run check:release -- tag v1.2.3"]);
      assert.equal(run.outputs, "version=1.2.3\nnode-version=24\n");
    });

    test("passes on nothing when the tag check fails", () => {
      const run = tagStep({ status: 1 });
      assert.notEqual(run.status, 0, run.output);
      assert.equal(run.outputs, "");
    });

    for (const nvmrc of ["lts/*\n", "v24\n", "24\nversion=0.0.1\n", ""]) {
      test(`passes on nothing for the .nvmrc ${JSON.stringify(nvmrc)}`, () => {
        const run = tagStep({ nvmrc });
        assert.notEqual(run.status, 0, run.output);
        assert.match(run.stdout, /^::error::\.nvmrc holds no Node version/m);
        assert.equal(run.outputs, "");
      });
    }
  });

  describe("Wait until AMO serves the version publicly", () => {
    const script = stepScript(build, "Wait until AMO serves the version publicly");

    function wait(body: string, status = 0, manifest: unknown = amoManifest()): StepRun {
      return runStep(script, ({ root, work }) => {
        mkdirSync(path.join(work, "apps/extension"), { recursive: true });
        writeFileSync(path.join(work, "apps/extension/manifest.json"), JSON.stringify(manifest));
        writeFileSync(path.join(root, "curl-body"), body);
        return { VERSION: "1.2.3", FAKE_CURL_STATUS: String(status) };
      });
    }

    test("passes once AMO lists the version as public and listed, without waiting", () => {
      const run = wait(
        amoVersions(
          { version: "1.2.4", channel: "listed", status: "public" },
          { version: "1.2.3", channel: "listed", status: "public" },
        ),
      );
      assert.equal(run.status, 0, run.output);
      assert.equal(run.calls.length, 1, JSON.stringify(run.calls));
      assert.match(
        run.calls[0] ?? "",
        /^curl .* https:\/\/addons\.mozilla\.org\/api\/v5\/addons\/addon\/foxleash%40mattiasw\.com\/versions\/$/,
      );
    });

    const notYet: Array<[string, string, number]> = [
      ["an older version only", amoVersions({ version: "1.2.2" }), 0],
      ["the version unlisted", amoVersions({ version: "1.2.3", channel: "unlisted" }), 0],
      ["the version not public yet", amoVersions({ version: "1.2.3", status: "unreviewed" }), 0],
      ["an HTTP error", '{"detail":"Authentication credentials were not provided."}', 22],
      ["an answer that is not JSON", "<html>", 0],
      ["an answer with no results", "{}", 0],
    ];
    for (const [name, body, status] of notYet) {
      test(`waits on ${name}`, () => {
        const run = wait(body, status);
        assert.notEqual(run.status, 0, run.output);
        assert.equal(run.calls.at(-1), "sleep 60", JSON.stringify(run.calls));
      });
    }

    test("stops before asking AMO when the manifest names no add-on id", () => {
      const run = wait(amoVersions({ version: "1.2.3" }), 0, { browser_specific_settings: {} });
      assert.notEqual(run.status, 0, run.output);
      assert.deepEqual(run.calls, []);
    });
  });

  describe("Pack the package", () => {
    const script = stepScript(build, "Pack the package");

    function pack(extra: Record<string, string> = {}): StepRun {
      return runStep(script, ({ work }) => {
        const dist = path.join(work, "apps/server/dist");
        mkdirSync(dist, { recursive: true });
        for (const [name, data] of Object.entries({ ...distFiles(), ...extra })) {
          writeFileSync(path.join(dist, name), data);
        }
        return { VERSION: "1.2.3" };
      });
    }

    test("packs the five files into foxleash-<version>.tgz", () => {
      const run = pack();
      assert.equal(run.status, 0, run.output);
      assert.deepEqual(run.packed, ["foxleash-1.2.3.tgz"]);
    });

    test("refuses a sixth file", () => {
      const run = pack({ "extra.js": "x" });
      assert.notEqual(run.status, 0, run.output);
      assert.match(run.stdout, /must hold exactly the five package files/);
    });
  });
});

describe("the workflow readers", () => {
  test("unpinnedUses reports every uses that is not a remote action pinned by commit", () => {
    const source = [
      "steps:",
      "  - uses: actions/checkout@v7",
      "  - uses: ./local",
      "  - uses: ./.github/actions/x@3d3c42e5aac5ba805825da76410c181273ba90b1 # v1",
      '  - "uses": actions/checkout@v7',
      "  - ? uses",
      "    : actions/checkout@v7",
      "  - {uses",
      "    : actions/checkout@v7}",
      "  - name: &key uses",
      "  - *key : actions/checkout@v7",
      "  - uses: actions/checkout/../../../../x@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "  - {name:",
      "     \u00a0#hidden, uses: evil/x@main}",
      "permissions:",
      "  statuses: read",
      "  # - uses: actions/checkout@v7",
      "  - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0",
      "    uses: octo-org/repo/.github/workflows/x.yml@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v1",
    ].join("\n");
    assert.deepEqual(unpinnedUses(source), [
      "2: - uses: actions/checkout@v7",
      "3: - uses: ./local",
      "4: - uses: ./.github/actions/x@3d3c42e5aac5ba805825da76410c181273ba90b1 # v1",
      '5: - "uses": actions/checkout@v7',
      "6: - ? uses",
      "8: - {uses",
      "10: - name: &key uses",
      "12: - uses: actions/checkout/../../../../x@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "14: #hidden, uses: evil/x@main}",
    ]);
  });

  test("topLevelPermissions ignores a job-level block", () => {
    const source = "jobs:\n  x:\n    permissions:\n      contents: read\n";
    assert.equal(topLevelPermissions(source), undefined);
  });

  test("topLevelPermissions reads past comments and blank lines up to the next top-level key", () => {
    const source =
      "permissions:\n  # note\n  contents: write\n\njobs:\n  x:\n    permissions:\n      actions: read\n";
    assert.deepEqual(topLevelPermissions(source), ["contents: write"]);
  });

  test("ownsPermissions accepts only an empty map or a block of scopes, declared once", () => {
    assert.equal(ownsPermissions("permissions: {}\njobs:\n"), true);
    assert.equal(ownsPermissions("permissions:\n  contents: read\njobs:\n"), true);
    assert.equal(ownsPermissions("jobs:\n  x:\n    permissions: {}\n"), false);
    assert.equal(ownsPermissions("permissions: write-all\njobs:\n"), false);
    assert.equal(ownsPermissions('permissions: "write-all"\njobs:\n'), false);
    assert.equal(ownsPermissions("permissions:\n  write-all\njobs:\n"), false);
    assert.equal(ownsPermissions("permissions:\njobs:\n"), false);
    assert.equal(ownsPermissions('permissions: {}\n"permissions": write-all\n'), false);
    assert.equal(ownsPermissions("permissions: {}\n? permissions\n: write-all\n"), false);
    assert.equal(ownsPermissions("permissions:\n  \u00a0#x: write\n  contents: read\n"), false);
  });

  test("topLevelBlock reads one top-level key's block, not a job's key of the same name", () => {
    const source =
      "jobs:\n  x:\n    on:\n      push:\non:\n  # note\n  release:\n\n    types: [published]\njobs2:\n";
    assert.deepEqual(topLevelBlock(source, "on"), ["release:", "types: [published]"]);
    assert.equal(topLevelBlock(source, "defaults"), undefined);
  });

  test("jobBlocks reads each job's body under jobs: without comments, up to the next top-level key", () => {
    const source = [
      "on:",
      "  a:",
      "jobs:",
      "  build:",
      "    # note",
      "    runs-on: x",
      "# between",
      "  publish:",
      "    needs: build",
      "env:",
      "  c:",
    ].join("\n");
    assert.deepEqual(
      [...jobBlocks(source)],
      [
        ["build", ["    runs-on: x"]],
        ["publish", ["    needs: build"]],
      ],
    );
    assert.deepEqual([...jobBlocks("on:\n  a:\n")], []);
  });

  test("strayJobLines reports flow-style, quoted and repeated job keys", () => {
    const source = [
      "jobs:",
      "  build:",
      "    runs-on: x",
      "  sneaky: {runs-on: x, permissions: {id-token: write}}",
      '  "quoted":',
      "  build:",
      "   three: x",
      "  # comment",
      "",
      "permissions: {}",
    ].join("\n");
    assert.deepEqual(strayJobLines(source), [
      "  sneaky: {runs-on: x, permissions: {id-token: write}}",
      '  "quoted":',
      "  build:",
      "   three: x",
    ]);
  });

  test("jobPermissions reads {} or a block of scopes, and nothing else", () => {
    assert.deepEqual(jobPermissions(["    permissions: {}"]), []);
    assert.deepEqual(
      jobPermissions([
        "    runs-on: x",
        "    permissions:",
        "      id-token: write",
        "",
        "    steps:",
      ]),
      ["id-token: write"],
    );
    assert.equal(jobPermissions(["    runs-on: x"]), undefined);
    assert.equal(jobPermissions(["    permissions: write-all"]), undefined);
    assert.equal(jobPermissions(["    permissions: {id-token: write}"]), undefined);
    assert.equal(jobPermissions(["    permissions:", "    steps:"]), undefined);
  });

  test("jobValue reads a job key's inline value, not a step's", () => {
    const body = ["    steps:", "      - environment: x", "    environment:  npm  ", "    needs:"];
    assert.equal(jobValue(body, "environment"), "npm");
    assert.equal(jobValue(body, "needs"), undefined);
  });

  test("withoutPin writes a commit pin and its release comment as <pin>, and nothing else", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(withoutPin(`- uses: a/b@${sha} # v1.2.3`), "- uses: a/b@<pin>");
    assert.equal(withoutPin(`- uses: a/b@${sha}`), `- uses: a/b@${sha}`);
    assert.equal(withoutPin("- uses: a/b@v1 # v1.2.3"), "- uses: a/b@v1 # v1.2.3");
    assert.equal(withoutPin(`- uses: a/b@${sha} # main`), `- uses: a/b@${sha} # main`);
  });

  test("stepNames lists each step's first line, and stepScript dedents its run: | block", () => {
    const body = [
      "    steps:",
      "      - uses: a/b@c",
      "      - name: First",
      "        env:",
      "          A: b",
      "        run: |",
      "          if true; then",
      "            echo one",
      "",
      "          fi",
      "        if: always()",
      "      - name: Second",
      "        run: |",
      "          echo two",
      "      -",
      "        name: Hidden",
      "        run: echo hidden",
    ];
    assert.deepEqual(stepNames(body), ["- uses: a/b@c", "- name: First", "- name: Second", "-"]);
    assert.equal(stepScript(body, "First"), "if true; then\n  echo one\n\nfi\n");
    assert.equal(stepScript(body, "Second"), "echo two\n");
    assert.throws(() => stepScript(body, "Third"), /no step named "Third"/);
    assert.throws(
      () => stepScript(["      - name: X", "        run: echo"], "X"),
      /has no run: \| block/,
    );
    assert.throws(
      () =>
        stepScript(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression
          ["      - name: X", "        run: |", "          echo ${{ github.ref }}"],
          "X",
        ),
      /interpolates into run:/,
    );
  });

  test("hasOtherLineBreak finds every line break but \\n and \\r\\n", () => {
    assert.equal(hasOtherLineBreak("permissions:\r\n  contents: read\r\n"), false);
    for (const lineBreak of ["\r", "\u0085", "\u2028", "\u2029"]) {
      assert.equal(
        hasOtherLineBreak(`permissions:\n  # note${lineBreak}  id-token: write\n`),
        true,
        JSON.stringify(lineBreak),
      );
    }
  });
});

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

function hasOtherLineBreak(source: string): boolean {
  return /\r(?!\n)|[\u0085\u2028\u2029]/.test(source);
}

// An allow-list of the two forms in use: YAML spells write-all in many ways (quoted, anchored,
// tagged, as a scalar on the next line), and a second key could say something else.
function ownsPermissions(source: string): boolean {
  const keys = source
    .split("\n")
    .filter((line) => /^(?:\?\s+)?["']?permissions["']?\s*(?::|$)/.test(line));
  if (keys.length !== 1) return false;
  if (/^permissions:\s*\{\}\s*$/.test(keys[0] ?? "")) return true;
  const scopes = topLevelPermissions(source);
  return scopes !== undefined && scopes.length > 0 && scopes.every((scope) => SCOPE.test(scope));
}

// The lines of the top-level permissions block, trimmed, without blank and comment lines.
function topLevelPermissions(source: string): string[] | undefined {
  return topLevelBlock(source, "permissions");
}

// The lines of a top-level block written as `<key>:` on its own line, trimmed, without blank and
// comment lines.
function topLevelBlock(source: string, key: string): string[] | undefined {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.replace(/\s+$/, "") === `${key}:`);
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || COMMENT.test(line)) continue;
    if (!/^\s/.test(line)) break;
    body.push(line.trim());
  }
  return body;
}

function unpinnedUses(source: string): string[] {
  return usesLines(source)
    .filter(([, line]) => !PINNED.test(line))
    .map(([number, line]) => `${number}: ${line.trim()}`);
}

// Inclusive on purpose: every line that names uses outside a comment, and every explicit key (? on
// its own line, the value on the next), is reported and must then match PINNED, so a key split
// over two lines of a flow mapping, or repeated through an alias, is caught where it is written.
// \b keeps statuses: out.
function usesLines(source: string): Array<[number, string]> {
  return source
    .split("\n")
    .map((line, index): [number, string] => [index + 1, line])
    .filter(
      ([, line]) =>
        !COMMENT.test(line) && (/\buses\b/i.test(line) || /^\s*(?:-\s+)?\?(?:\s|$)/.test(line)),
    );
}

// Each job under the top-level jobs: block by name, with its body lines; comment lines are left
// out. A job header is a plain key at indent 2; strayJobLines reports every other line there.
function jobBlocks(source: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let body: string[] | undefined;
  for (const line of jobsBody(source)) {
    if (COMMENT.test(line)) continue;
    const header = JOB_HEADER.exec(line);
    if (header !== null) {
      body = [];
      jobs.set(header[1] ?? "", body);
    } else {
      body?.push(line);
    }
  }
  return jobs;
}

// The lines after the top-level jobs: key, up to the next top-level key.
function jobsBody(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !COMMENT.test(line) && !/^[ \t]/.test(line)) break;
    body.push(line);
  }
  return body;
}

// Lines under jobs: indented less than a job's body that are not a plain job header, or that
// repeat one, such as a flow-style or quoted job key, which jobBlocks would fold into the job
// above it.
function strayJobLines(source: string): string[] {
  const seen = new Set<string>();
  const stray: string[] = [];
  for (const line of jobsBody(source)) {
    if (line.trim() === "" || COMMENT.test(line)) continue;
    const header = JOB_HEADER.exec(line);
    if (header !== null && !seen.has(header[1] ?? "")) {
      seen.add(header[1] ?? "");
    } else if ((/^[ \t]*/.exec(line)?.[0].length ?? 0) < 4) {
      stray.push(line);
    }
  }
  return stray;
}

// A job's scopes: [] for permissions: {}, the lines of a block of scopes, and undefined for no
// permissions key or any other form (write-all, a flow map, an empty block).
function jobPermissions(body: string[]): string[] | undefined {
  const start = body.findIndex((line) => /^ {4}permissions:/.test(line));
  const first = body[start];
  if (first === undefined) return undefined;
  if (/^ {4}permissions:\s*\{\}\s*$/.test(first)) return [];
  if (!/^ {4}permissions:\s*$/.test(first)) return undefined;
  const scopes: string[] = [];
  for (const line of body.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (!/^ {5}/.test(line)) break;
    scopes.push(line.trim());
  }
  return scopes.length > 0 ? scopes : undefined;
}

function jobValue(body: string[], key: string): string | undefined {
  for (const line of body) {
    const match = /^ {4}([A-Za-z0-9_-]+):\s*(\S.*?)\s*$/.exec(line);
    if (match?.[1] === key) return match[2];
  }
  return undefined;
}

// A line whose action is pinned by commit with its release in a comment, with both written as
// <pin>, so that a Dependabot update of a pin leaves the lists above as they are.
function withoutPin(line: string): string {
  return line.replace(/@[0-9a-f]{40} # v\d+(?:\.\d+)*\s*$/, "@<pin>");
}

function stepNames(body: string[]): string[] {
  return body.filter((line) => STEP_START.test(line)).map((line) => line.trim());
}

// The `run: |` script of the named step, dedented. It ends at the first non-empty line indented
// less than its first line, and holds no GitHub expression: context values come in through env:.
function stepScript(body: string[], name: string): string {
  const start = body.findIndex((line) => line.replace(/\s+$/, "") === `      - name: ${name}`);
  assert.ok(start >= 0, `no step named ${JSON.stringify(name)}`);
  const rest = body.slice(start + 1);
  const next = rest.findIndex((line) => STEP_START.test(line));
  const step = next < 0 ? rest : rest.slice(0, next);
  const run = step.findIndex((line) => /^ {8}run: \|\s*$/.test(line));
  assert.ok(run >= 0, `the step ${JSON.stringify(name)} has no run: | block`);
  const block = step.slice(run + 1);
  const first = block.find((line) => line.trim() !== "") ?? "";
  const indent = first.length - first.trimStart().length;
  assert.ok(indent > 8, `the step ${JSON.stringify(name)}'s run: | block is empty`);
  const script: string[] = [];
  for (const line of block) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    script.push(line.slice(indent));
  }
  const text = `${script.join("\n")}\n`;
  assert.ok(!text.includes("${{"), `the step ${JSON.stringify(name)} interpolates into run:`);
  return text;
}

type StepDirs = { root: string; work: string; temp: string };
type StepRun = {
  status: number | null;
  stdout: string;
  output: string;
  /** The fake curl's, sleep's and npm's calls, in order. */
  calls: string[];
  /** What the script wrote to GITHUB_OUTPUT. */
  outputs: string;
  /** RUNNER_TEMP/npm-package's names, after the run. */
  packed: string[] | undefined;
  /** The tarball left in RUNNER_TEMP/npm-publish: its entries as GNU tar and npm list them. */
  published: { names: string[]; manifest: string; npmNames: string[] } | undefined;
};

// Runs a step's script as GitHub runs a shell: bash step, in a fresh folder, with fake curl and
// sleep first on PATH (and a fake npm when the case sets its version or exit status), so no test
// reaches AMO.
function runStep(script: string, prepare: (dirs: StepDirs) => Record<string, string>): StepRun {
  const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
  assert.equal(jq.status, 0, "jq is required: the publish tests run the workflow's jq filters");
  const root = mkdtempSync(path.join(tmpdir(), "foxleash-publish-"));
  try {
    const dirs = { root, work: path.join(root, "work"), temp: path.join(root, "temp") };
    const bin = path.join(root, "bin");
    for (const dir of [bin, dirs.work, dirs.temp, path.join(root, "home")]) mkdirSync(dir);
    const log = path.join(root, "calls.log");
    writeFileSync(log, "");
    writeFileSync(path.join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
    writeFileSync(path.join(bin, "sleep"), FAKE_SLEEP, { mode: 0o755 });
    const env = prepare(dirs);
    if (env.FAKE_NPM_VERSION !== undefined || env.FAKE_NPM_STATUS !== undefined) {
      writeFileSync(path.join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
    }
    const file = path.join(root, "script.sh");
    writeFileSync(file, script);
    const outputs = path.join(root, "github-output");
    const npmEnv = {
      npm_config_cache: path.join(root, "npm-cache"),
      npm_config_update_notifier: "false",
      npm_config_offline: "true",
    };
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], {
      cwd: dirs.work,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: [bin, process.env.PATH ?? ""].join(path.delimiter),
        HOME: path.join(root, "home"),
        RUNNER_TEMP: dirs.temp,
        GITHUB_OUTPUT: outputs,
        FAKE_LOG: log,
        FAKE_CURL_BODY: path.join(root, "curl-body"),
        ...npmEnv,
        ...env,
      },
    });
    const downloaded = path.join(dirs.temp, "npm-package");
    return {
      status: result.status,
      stdout: result.stdout,
      output: `${result.stdout}\n${result.stderr}`,
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
      outputs: existsSync(outputs) ? readFileSync(outputs, "utf8") : "",
      packed: existsSync(downloaded) ? readdirSync(downloaded).sort() : undefined,
      published: publishedPackage(path.join(dirs.temp, "npm-publish"), dirs.work, npmEnv),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FAKE_CURL = `#!/bin/sh
echo "curl $*" >> "$FAKE_LOG"
cat "$FAKE_CURL_BODY"
exit "\${FAKE_CURL_STATUS:-0}"
`;
const FAKE_SLEEP = `#!/bin/sh
echo "sleep $*" >> "$FAKE_LOG"
exit 1
`;
const FAKE_NPM = `#!/bin/sh
echo "npm $*" >> "$FAKE_LOG"
if [ "$1" = "--version" ]; then printf '%s\\n' "$FAKE_NPM_VERSION"; fi
exit "\${FAKE_NPM_STATUS:-0}"
`;

function publishedPackage(
  dir: string,
  cwd: string,
  npmEnv: Record<string, string>,
): StepRun["published"] {
  const tarballs = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".tgz")) : [];
  if (tarballs.length === 0) return undefined;
  assert.deepEqual(tarballs, ["foxleash-1.2.3.tgz"]);
  const tarball = path.join(dir, "foxleash-1.2.3.tgz");
  const run = (command: string, args: string[]): string => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...npmEnv },
    });
    assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  const listed: unknown = JSON.parse(run("npm", ["pack", tarball, "--dry-run", "--json"]));
  const files = Array.isArray(listed) && isRecord(listed[0]) ? listed[0].files : undefined;
  assert.ok(Array.isArray(files), `npm pack --dry-run --json printed ${JSON.stringify(listed)}`);
  return {
    names: run("tar", ["-tzf", tarball]).split("\n").filter(Boolean).sort(),
    manifest: run("tar", ["-xOzf", tarball, "package/package.json"]),
    npmNames: files.map((file: unknown) => (isRecord(file) ? String(file.path) : "")).sort(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type TarEntry = {
  name: string;
  data: string | Buffer;
  /** The ustar typeflag: 0 a regular file, 2 a symlink. */
  type?: "0" | "2";
  linkname?: string;
  /** A header byte above 127 and a checksum summed over signed bytes, which GNU tar accepts. */
  signedChecksum?: boolean;
  /** A lone zero block before this entry, where GNU tar stops reading without --ignore-zeros. */
  zeroBlockBefore?: boolean;
};

// The five files npm packs, with the given contents replacing the clean ones.
function packageEntries(overrides: Record<string, string> = {}): TarEntry[] {
  return [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/THIRD_PARTY_NOTICES.md",
    "package/foxleash.mjs",
  ].map((name) => ({
    name,
    data: overrides[name] ?? (name === "package/package.json" ? CLEAN_MANIFEST : `${name}\n`),
  }));
}

function tarball(entries: TarEntry[]): Buffer {
  const blocks = entries.flatMap((entry) => [
    ...(entry.zeroBlockBefore === true ? [Buffer.alloc(512)] : []),
    tarEntry(entry),
  ]);
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

// One ustar header and its data, padded to 512 bytes.
function tarEntry(entry: TarEntry): Buffer {
  const data = Buffer.from(entry.data);
  const header = Buffer.alloc(512);
  const octal = (value: number, width: number): string =>
    `${value.toString(8).padStart(width - 1, "0")}\0`;
  header.write(entry.name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100);
  header.write(octal(0, 8), 108);
  header.write(octal(0, 8), 116);
  header.write(octal(data.length, 12), 124);
  header.write(octal(0, 12), 136);
  header.write(" ".repeat(8), 148);
  header.write(entry.type ?? "0", 156);
  header.write(entry.linkname ?? "", 157, 100, "utf8");
  header.write("ustar\u000000", 257, "latin1");
  if (entry.signedChecksum === true) header[265] = 0xe9;
  let sum = 0;
  for (const byte of header) sum += entry.signedChecksum === true && byte > 127 ? byte - 256 : byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function amoManifest(): unknown {
  return { manifest_version: 3, browser_specific_settings: { gecko: { id: ADDON_ID } } };
}

// An answer of AMO's versions endpoint; each item is listed and public unless it says otherwise.
function amoVersions(
  ...items: Array<{ version: string; channel?: string; status?: string }>
): string {
  return JSON.stringify({
    count: items.length,
    next: null,
    results: items.map((item) => ({
      version: item.version,
      channel: item.channel ?? "listed",
      file: { status: item.status ?? "public" },
    })),
  });
}

function distFiles(): Record<string, string> {
  return {
    "package.json": CLEAN_MANIFEST,
    "foxleash.mjs": "#!/usr/bin/env node\n",
    LICENSE: "license\n",
    "README.md": "readme\n",
    "THIRD_PARTY_NOTICES.md": "notices\n",
  };
}

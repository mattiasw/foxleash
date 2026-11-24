import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BLOCKLIST } from "./default-blocklist.ts";
import {
  hasPlainHost,
  hostOf,
  MAX_SITE_HOST,
  matchesDomain,
  normalizeDomain,
  parseBlocklist,
  redactedUrl,
  siteOf,
  sitePattern,
} from "./site.ts";

const SITES: [string, string | undefined][] = [
  ["https://example.com/path?q=1#top", "https://example.com"],
  ["http://example.com/", "http://example.com"],
  ["https://example.com:443/", "https://example.com"],
  ["http://example.com:80/", "http://example.com"],
  ["https://example.com:8443/", "https://example.com:8443"],
  ["http://example.com:443/", "http://example.com:443"],
  ["http://127.0.0.1:4567/a", "http://127.0.0.1:4567"],
  ["https://EXAMPLE.com/", "https://example.com"],
  ["HTTPS://Example.COM/", "https://example.com"],
  ["https://bücher.de/", "https://xn--bcher-kva.de"],
  ["http://0x7f.1/", "http://127.0.0.1"],
  ["http://[::1]:8080/x", "http://[::1]:8080"],
  ["http://[0:0:0:0:0:0:0:1]/", "http://[::1]"],
  ["https://user:pw@EXAMPLE.com:443/x", "https://example.com"],
  ["https://www.paypal.com./", "https://www.paypal.com"],
  ["https://www.paypal.com.:443/", "https://www.paypal.com"],
  ["https://www.paypal.com%2e/", "https://www.paypal.com"],
  ["https://__proto__/", "https://__proto__"],
  ["https://example.com../", undefined],
  ["http://./", undefined],
  ["about:blank", undefined],
  ["file:///etc/passwd", undefined],
  ["moz-extension://abc/options.html", undefined],
  ["javascript:alert(1)", undefined],
  ["data:text/html,<p>x</p>", undefined],
  ["blob:https://example.com/0b2c", undefined],
  ["ftp://example.com/", undefined],
  ["", undefined],
  ["not a url", undefined],
];

describe("siteOf", () => {
  for (const [url, site] of SITES) {
    it(`gives ${JSON.stringify(url)} the site ${String(site)}`, () => {
      assert.equal(siteOf(url), site);
    });
  }

  it("gives a site the same site back", () => {
    for (const [, site] of SITES) {
      if (site !== undefined) assert.equal(siteOf(site), site);
    }
  });
});

describe("redactedUrl", () => {
  const cases: [string | undefined, string][] = [
    [undefined, ""],
    ["", ""],
    ["https://mail.example.com/inbox?id=7#top", "https://mail.example.com"],
    ["http://127.0.0.1:4567/a", "http://127.0.0.1:4567"],
    ["https://user:pw@example.com/", "https://example.com"],
    ["https://example.com../", "https:"],
    ["http://./", "http:"],
    ["about:blank", "about:blank"],
    ["about:blank#x", "about:"],
    ["about:blank?x", "about:"],
    ["about:config", "about:"],
    ["file:///home/user/secret.txt", "file:"],
    ["moz-extension://abc/options.html", "moz-extension:"],
    ["data:text/html,<p>x</p>", "data:"],
    ["blob:https://example.com/0b2c", "blob:"],
    ["javascript:alert(1)", "javascript:"],
    ["view-source:https://example.com/a", "view-source:"],
    ["not a url", ""],
  ];
  for (const [url, redacted] of cases) {
    it(`redacts ${JSON.stringify(url)} to ${JSON.stringify(redacted)}`, () => {
      assert.equal(redactedUrl(url), redacted);
    });
  }
});

describe("hostOf", () => {
  const cases: [string, string][] = [
    ["http://[::1]:80", "[::1]"],
    ["https://a.example:8443", "a.example"],
    ["https://a.example", "a.example"],
    ["http://[::ffff:7f00:1]", "127.0.0.1"],
    ["http://[::ffff:c0a8:101]", "192.168.1.1"],
    ["http://[::ffff:ffff:ffff]", "255.255.255.255"],
    ["http://[::ffff:0:7f00:1]", "[::ffff:0:7f00:1]"],
    ["http://[64:ff9b::7f00:1]", "[64:ff9b::7f00:1]"],
    ["not a site", ""],
  ];
  for (const [site, host] of cases) {
    it(`gives ${site} the host ${host}`, () => {
      assert.equal(hostOf(site), host);
    });
  }
});

describe("sitePattern", () => {
  it("gives the match pattern of the site's scheme and host", () => {
    assert.equal(sitePattern("https://mail.google.com"), "https://mail.google.com/*");
  });

  it("leaves out the port", () => {
    assert.equal(sitePattern("http://127.0.0.1:8123"), "http://127.0.0.1/*");
  });

  it("keeps the brackets of an IPv6 host", () => {
    assert.equal(sitePattern("http://[::1]:8080"), "http://[::1]/*");
  });

  it("is undefined for a site that does not parse", () => {
    assert.equal(sitePattern("not a url"), undefined);
  });
});

describe("matchesDomain", () => {
  const cases: [string, string, boolean][] = [
    ["https://paypal.com", "paypal.com", true],
    ["https://www.paypal.com", "paypal.com", true],
    ["http://paypal.com", "paypal.com", true],
    ["https://paypal.com:8443", "paypal.com", true],
    ["https://a.b.paypal.com", "paypal.com", true],
    ["https://pay.google.com", "pay.google.com", true],
    ["https://x.pay.google.com", "pay.google.com", true],
    ["https://google.com", "pay.google.com", false],
    ["https://mail.google.com", "pay.google.com", false],
    ["https://notpaypal.com", "paypal.com", false],
    ["https://paypal.com.evil", "paypal.com", false],
    ["https://paypal.co", "paypal.com", false],
    ["http://127.0.0.1:4567", "127.0.0.1", true],
    ["http://[::1]", "127.0.0.1", false],
  ];
  for (const [site, pattern, matches] of cases) {
    it(`${matches ? "matches" : "does not match"} ${site} against ${pattern}`, () => {
      assert.equal(matchesDomain(hostOf(site), pattern), matches);
    });
  }

  it("matches a site Firefox reached through a trailing dot or an IPv4-mapped address", () => {
    assert.equal(matchesDomain(hostOf(siteOf("http://localhost.:4567/") ?? ""), "localhost"), true);
    assert.equal(
      matchesDomain(hostOf(siteOf("http://[::ffff:127.0.0.1]:4567/") ?? ""), "127.0.0.1"),
      true,
    );
  });
});

// A host of 253 characters, the DNS limit.
const LONGEST_HOST = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;

describe("hasPlainHost", () => {
  const plain = [
    "https://example.com",
    "https://xn--bcher-kva.de",
    "https://my_host.example",
    "http://localhost:3000",
    "http://127.0.0.1:8080",
    "http://[::1]:3000",
    "http://[::ffff:1.2.3.4]",
    `https://${"a".repeat(63)}.example`,
    `https://${LONGEST_HOST}`,
  ];
  for (const url of plain) {
    it(`takes ${url}`, () => {
      assert.equal(hasPlainHost(webSite(url)), true);
    });
  }

  const refused = [
    "https://accounts.google.com(verified-by-foxleash).evil.example",
    "https://accounts.google.com,evil.example",
    `https://${LONGEST_HOST}d`,
    `https://${"a".repeat(64)}.example`,
    "http://a..b",
  ];
  for (const url of refused) {
    it(`refuses ${url}`, () => {
      assert.equal(hasPlainHost(webSite(url)), false);
    });
  }

  it("refuses a string that is not a URL", () => {
    assert.equal(hasPlainHost(""), false);
  });

  it("measures the host's length against the DNS limit", () => {
    assert.equal(MAX_SITE_HOST, 253);
    assert.equal(LONGEST_HOST.length, MAX_SITE_HOST);
  });
});

const EMPTY = "The line is empty.";
const NOT_A_DOMAIN = "This is not a domain; write one such as example.com.";
const SUBDOMAINS =
  "Write the domain without a wildcard or a leading dot: a domain already covers its subdomains.";
const SCHEME = "Write the domain without http:// or https://: it is blocked on both.";
const PATH = "Write the domain without a path, query or #: the whole site is blocked.";
const PORT = "Write the domain without a port: it is blocked on every port.";

describe("normalizeDomain", () => {
  const accepted: [string, string][] = [
    ["paypal.com", "paypal.com"],
    [" Paypal.COM ", "paypal.com"],
    ["paypal.com/", "paypal.com"],
    ["paypal.com.", "paypal.com"],
    ["PAYPAL.com./", "paypal.com"],
    ["bank.例え", "bank.xn--r8jz45g"],
    ["127.0.0.1", "127.0.0.1"],
    ["127.0.0.1.", "127.0.0.1"],
    ["127.0.0.1/", "127.0.0.1"],
    ["localhost", "localhost"],
    ["deutsche-bank.de", "deutsche-bank.de"],
    ["1177.se", "1177.se"],
  ];
  for (const [line, host] of accepted) {
    it(`accepts ${JSON.stringify(line)} as ${host}`, () => {
      assert.deepEqual(normalizeDomain(line), { host });
    });
  }

  const refused: [string, string][] = [
    ["", EMPTY],
    ["   ", EMPTY],
    ["*.paypal.com", SUBDOMAINS],
    [".paypal.com", SUBDOMAINS],
    ["*paypal.com", SUBDOMAINS],
    ["paypal.*", SUBDOMAINS],
    ["https://paypal.com", SCHEME],
    ["http://paypal.com/", SCHEME],
    ["paypal.com/x", PATH],
    ["paypal.com//", PATH],
    ["paypal.com?x", PATH],
    ["paypal.com#x", PATH],
    ["paypal.com\\x", PATH],
    ["paypal.com:443", PORT],
    ["paypal.com:80", PORT],
    ["paypal.com:", PORT],
    ["user@paypal.com", NOT_A_DOMAIN],
    [":@paypal.com", NOT_A_DOMAIN],
    ["pay%2epal.com", NOT_A_DOMAIN],
    ["paypal.com%2e", NOT_A_DOMAIN],
    ["[::1]", NOT_A_DOMAIN],
    ["a b", NOT_A_DOMAIN],
    ["paypal.com\nevil.com", NOT_A_DOMAIN],
    ["paypal.com\revil.com", NOT_A_DOMAIN],
    ["pay\tpal.com", NOT_A_DOMAIN],
    ["paypal.com,venmo.com", NOT_A_DOMAIN],
    ["paypal..com", NOT_A_DOMAIN],
    ["paypal.com..", NOT_A_DOMAIN],
    ["paypal.com!", NOT_A_DOMAIN],
    ["paypal.123", NOT_A_DOMAIN],
    ["192.168", NOT_A_DOMAIN],
    ["10.1", NOT_A_DOMAIN],
    ["0x7f.1", NOT_A_DOMAIN],
    ["127.000.0.1", NOT_A_DOMAIN],
    ["127.0.0.1..", NOT_A_DOMAIN],
  ];
  for (const [line, error] of refused) {
    it(`refuses ${JSON.stringify(line)}`, () => {
      assert.deepEqual(normalizeDomain(line), { error });
    });
  }
});

describe("parseBlocklist", () => {
  it("skips blank lines and numbers the lines that fail, blank ones counted", () => {
    assert.deepEqual(parseBlocklist("paypal.com\n\n*.x.com\nok.com\nhttps://y.com"), {
      errors: [
        { line: 3, text: SUBDOMAINS },
        { line: 5, text: SCHEME },
      ],
    });
  });

  it("returns the patterns in first order without duplicates", () => {
    assert.deepEqual(parseBlocklist("paypal.com\r\n  \r\nchase.com\nPAYPAL.com.\n"), {
      patterns: ["paypal.com", "chase.com"],
    });
  });

  it("returns no patterns for empty text", () => {
    assert.deepEqual(parseBlocklist(""), { patterns: [] });
    assert.deepEqual(parseBlocklist(" \n\t\n"), { patterns: [] });
  });
});

describe("DEFAULT_BLOCKLIST", () => {
  it("holds only normalized domains", () => {
    for (const entry of DEFAULT_BLOCKLIST) {
      assert.deepEqual(normalizeDomain(entry), { host: entry }, entry);
    }
  });

  it("has no duplicates", () => {
    assert.equal(new Set(DEFAULT_BLOCKLIST).size, DEFAULT_BLOCKLIST.length);
  });

  it("is in alphabetical order", () => {
    assert.deepEqual(DEFAULT_BLOCKLIST, [...DEFAULT_BLOCKLIST].sort());
  });
});

/** The site of an http(s) URL, which the test needs to have one. */
function webSite(url: string): string {
  const site = siteOf(url);
  assert.ok(site !== undefined, url);
  return site;
}

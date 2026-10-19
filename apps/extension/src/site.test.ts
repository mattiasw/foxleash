import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactedUrl, siteOf } from "./site.ts";

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

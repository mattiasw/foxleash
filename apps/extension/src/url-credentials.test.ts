import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REDACTED } from "./response-body.ts";
import { MAX_SCANNED_URL, redactLinkCredentials, redactUrlCredentials } from "./url-credentials.ts";

const HOST = "https://app.test";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
const R = REDACTED;

/** Asserts the redaction of `HOST + input` and that the origin stays the same. */
function assertRedacts(input: string, expected: string): void {
  const output = redactUrlCredentials(HOST + input);
  assert.equal(output, HOST + expected, input);
  assert.equal(new URL(output).origin, new URL(HOST + input).origin, input);
}

describe("redactUrlCredentials", () => {
  it("replaces only the value of a session token in a live API address", () => {
    const hex = "a8f3".repeat(16);
    assertRedacts(
      `/api/everything?&return=everything&since_ms=1&authtoken=${hex}&appid=com.app.focus`,
      `/api/everything?&return=everything&since_ms=1&authtoken=${R}&appid=com.app.focus`,
    );
  });

  it("redacts token parameters in the query and the fragment", () => {
    assertRedacts("/cb?access_token=v", `/cb?access_token=${R}`);
    assertRedacts(
      "/cb#access_token=v&token_type=bearer&expires_in=3600",
      `/cb#access_token=${R}&token_type=bearer&expires_in=3600`,
    );
    assertRedacts("/#/callback?code=v&state=s", `/#/callback?code=${R}&state=s`);
    assertRedacts("/#access_token=v?x=1", `/#access_token=${R}`);
    assertRedacts("/#/home#code=v&state=s", `/#/home#code=${R}&state=s`);
    assertRedacts("/#x#sid=v", `/#x#sid=${R}`);
  });

  it("redacts every name of the documented list", () => {
    const names = [
      "authtoken",
      "token",
      "access_token",
      "refresh_token",
      "id_token",
      "api_key",
      "apikey",
      "key",
      "secret",
      "client_secret",
      "password",
      "passwd",
      "session",
      "sessionid",
      "sid",
      "sig",
      "signature",
      "code",
      "X-Amz-Signature",
      "X-Amz-Credential",
      "X-Amz-Security-Token",
      "X-Goog-Signature",
      "X-Goog-Credential",
    ];
    for (const name of names) assertRedacts(`/p?a=1&${name}=v&b=2`, `/p?a=1&${name}=${R}&b=2`);
  });

  it("redacts variants of credential names", () => {
    const names = [
      "AuthToken",
      "api-key",
      "session_id",
      "Auth-Token",
      "user[password]",
      "auth[token]",
      "token[]",
      "token[0]",
      "user[password_confirmation]",
      "auth%74oken",
      "authtoken%FF",
      "auth%74oken%zz",
      "auth+token",
      "password2",
      "token.0",
      "oauth_access_token",
      "accessToken",
      "reset_password_token",
      "private_token",
      "token_hash",
      "credentials",
      "PHPSESSID",
      "x-api-key",
      "app_secret",
      "new_password",
      "auth",
      "jwt",
      "pwd",
      "authorization",
      "amp;token",
      "oobCode",
      "auth_code",
      "login_code",
      "otp",
      "ticket",
      "oauth_verifier",
      "code_verifier",
      "pass",
      "passcode",
      "pw",
    ];
    for (const name of names) assertRedacts(`/p?${name}=v&b=2`, `/p?${name}=${R}&b=2`);
    assertRedacts("/p?a=1&amp;token=v", `/p?a=1&amp;token=${R}`);
  });

  it("keeps parameters whose names are not credentials'", () => {
    for (const input of [
      "/p?token_type=bearer&token_type_hint=x&TokenType2=y",
      "/p?oauth_signature_method=HMAC-SHA1&session_state=st&keyword=k&countryCode=SE",
      "/p?keys1=2&codes=x&sigma=1&sessions=2",
      "/#/reset-password?email=a@b.test&step=2",
      "/#/settings/api-token?page=2",
    ]) {
      assertRedacts(input, input);
    }
    assertRedacts("/p?oauth_signature=s", `/p?oauth_signature=${R}`);
  });

  it("strips trailing digits only, and ignores a name's characters outside a-z and 0-9", () => {
    assertRedacts("/p?sid2=v&sig99=v&2sid=v&s1d=v", `/p?sid2=${R}&sig99=${R}&2sid=v&s1d=v`);
    assertRedacts("/p?S.I.D=v&code-=v", `/p?S.I.D=${R}&code-=${R}`);
  });

  it("redacts the whole value of a parameter that holds a credential parameter", () => {
    assertRedacts(
      "/login?redirect_uri=https%3A%2F%2Fapp%2Fcb%3Faccess_token%3Dabc&x=1",
      `/login?redirect_uri=${R}&x=1`,
    );
    assertRedacts(
      "/login?redirect_uri=https%253A%252F%252Fapp%252Fcb%253Faccess_token%253Dabc",
      `/login?redirect_uri=${R}`,
    );
    assertRedacts(
      "/login?r=https%25253A%25252F%25252Fa%25252F%25253Ftoken%25253Dabc",
      `/login?r=${R}`,
    );
    assertRedacts("/login?next=/cb?code=abc&x=1", `/login?next=${R}&x=1`);
    assertRedacts("/p?a=1;sid=q&b=2", `/p?a=${R}&b=2`);
    assertRedacts("/p?a=x#sid=q", `/p?a=x#sid=${R}`);
    assertRedacts("/p#a=code=v", `/p#a=${R}`);
    assertRedacts("/p?a=sid%3Dq", `/p?a=${R}`);
    assertRedacts("/p?a=%2B%26sid%3Dq", `/p?a=${R}`);
    assertRedacts(
      "/collect?dl=https%3A%2F%2Fapp%2Freset%3Freset_password_token%3Dabc&dt=Title",
      `/collect?dl=${R}&dt=Title`,
    );
  });

  it("redacts a whole part whose name, or the part itself when it has no name, holds one", () => {
    assertRedacts("/login?https%3A%2F%2Fapp%2Fcb%3Faccess_token%3Dabc&x=1", `/login?${R}&x=1`);
    assertRedacts("/cb#https%3A%2F%2Fa%2F%3Fid_token%3Dabc", `/cb#${R}`);
    assertRedacts("/login?x=1&https%3A%2F%2Fapp%2Fcb%3Fcode%3Dabc=", `/login?x=1&${R}`);
    assertRedacts("/login?https%3A%2F%2Fapp%2Fcb%3Fcode%3Dabc=1&x=1", `/login?${R}&x=1`);
    assertRedacts("/p?a=1&%2Fcb%253Fsid%253Dq", `/p?a=1&${R}`);
    for (const input of [
      "/login?https%3A%2F%2Fapp%2Fcallback&x=1",
      "/cb#%2Fsearch%3Fq%3Dx",
      "/p?a%3Dtoken&b",
    ]) {
      assertRedacts(input, input);
    }
  });

  it("keeps a value that holds no credential parameter", () => {
    for (const input of [
      "/login?redirect_uri=https%3A%2F%2Fapp%2Fcallback",
      "/login?next=%2Fcb%3Fcode%3D",
      "/collect?dl=https%3A%2F%2Fshop%2F%3Futm_source%3Dx",
      "/p?a=code&b=%3Dsid",
      // Four rounds of encoding are past what the check decodes.
      "/login?r=https%2525253A%2525252F%2525252Fa%2525252F%2525253Ftoken%2525253Dabc",
    ]) {
      assertRedacts(input, input);
    }
  });

  it("redacts path parameters", () => {
    assertRedacts("/app/page;jsessionid=ABC123?x=1", `/app/page;jsessionid=${R}?x=1`);
    assertRedacts("/p;next=%2Fcb%3Ftoken%3Dabc/q", `/p;next=${R}/q`);
    assertRedacts("/p;a=1;sid=s;b=2/c", `/p;a=1;sid=${R};b=2/c`);
    for (const input of ["/p;v=2", "/p;sid=", "/p;sid", "/p;=x"]) assertRedacts(input, input);
  });

  it("redacts JWTs anywhere after the authority", () => {
    assertRedacts(`/p?state=${JWT}&x=1`, `/p?state=${R}&x=1`);
    assertRedacts(`/p?q=Bearer%20${JWT}`, `/p?q=Bearer%20${R}`);
    assertRedacts(`/files/${JWT}/view`, `/files/${R}/view`);
    assertRedacts(`/p#${JWT}`, `/p#${R}`);
  });

  it("leaves the scheme and authority as they are", () => {
    const userInfo = `https://user:${JWT}@app.test:8443/p?token=v`;
    assert.equal(redactUrlCredentials(userInfo), `https://user:${JWT}@app.test:8443/p?token=${R}`);
    assert.equal(
      redactUrlCredentials("https://user:pass@app.test/p?x=1"),
      "https://user:pass@app.test/p?x=1",
    );
    assert.equal(
      redactUrlCredentials("https://[::1]:8080/p?token=v"),
      `https://[::1]:8080/p?token=${R}`,
    );
    assert.equal(
      new URL(redactUrlCredentials("https://[::1]:8080/p?token=v")).origin,
      "https://[::1]:8080",
    );
    assert.equal(
      redactUrlCredentials("https://app.test\\cb;jsessionid=ABC"),
      `https://app.test\\cb;jsessionid=${R}`,
    );
    assert.equal(redactUrlCredentials("https://app.test?token=v"), `https://app.test?token=${R}`);
    assert.equal(redactUrlCredentials("https://app.test#sid=v"), `https://app.test#sid=${R}`);
  });

  it("treats an address without a leading scheme as path, query and fragment", () => {
    assert.equal(redactUrlCredentials("/cb?next=https://x/?token=v&y=1"), `/cb?next=${R}&y=1`);
    assert.equal(redactUrlCredentials("//host.test/p?token=v"), `//host.test/p?token=${R}`);
    assert.equal(redactUrlCredentials("/cb?code=abc"), `/cb?code=${R}`);
    assert.equal(redactUrlCredentials("x https://a/?token=v"), `x https://a/?token=${R}`);
    assert.equal(redactUrlCredentials("1a://h/;sid=s"), `1a://h/;sid=${R}`);
    assert.equal(redactUrlCredentials("data:,sid=v"), "data:,sid=v");
    assert.equal(redactUrlCredentials(""), "");
  });

  it("changes nothing in an address without credentials", () => {
    for (const input of [
      "",
      "/",
      "/a/b.html",
      "/?",
      "/#",
      "/?#",
      "/p?q=hello&page=2",
      "/p#section-2",
      "/p#:~:text=password",
      "/p?flag&x",
      "/p?token=",
      "/p?token=&x=1",
      "/p?q=a%20b+c&r=%E2%9C%93",
      "/p?a==b",
    ]) {
      assertRedacts(input, input);
    }
  });

  it("reads only the first MAX_SCANNED_URL characters", () => {
    const long = `${HOST}/${"u".repeat(MAX_SCANNED_URL + 100)}`;
    assert.equal(redactUrlCredentials(long), long.slice(0, MAX_SCANNED_URL));
    const prefix = `${HOST}/?a=`;
    const filler = "b".repeat(MAX_SCANNED_URL);
    assert.equal(
      redactUrlCredentials(`${prefix}${filler}&token=v`),
      `${prefix}${filler}`.slice(0, MAX_SCANNED_URL),
    );
    const head = `${HOST}/?x=1&token=`;
    const crossing = `${head}${"v".repeat(MAX_SCANNED_URL)}`;
    assert.equal(redactUrlCredentials(crossing), `${head}${R}`);
    const nameCut = `${HOST}/?${"x".repeat(MAX_SCANNED_URL - HOST.length - 7)}&token=v`;
    assert.equal(redactUrlCredentials(nameCut), nameCut.slice(0, MAX_SCANNED_URL));
  });

  it("never cuts a character in two", () => {
    // The first half of the emoji is the last character the scan would keep.
    const head = `/cb?token=${"v".repeat(MAX_SCANNED_URL - 14)}&x=`;
    assert.equal(head.length, MAX_SCANNED_URL - 1);
    assert.equal(redactUrlCredentials(`${head}\u{1F600}tail`), `/cb?token=${R}&x=`);
    const target = `</cb?token=${"v".repeat(MAX_SCANNED_URL - 15)}&x=`;
    assert.equal(target.length, MAX_SCANNED_URL - 1);
    assert.equal(redactLinkCredentials(`${target}\u{1F600}tail`), `</cb?token=${R}&x=`);
  });

  it("redacts a long name of digits in linear time", () => {
    const digits = `${HOST}/?${"1".repeat(MAX_SCANNED_URL - 100)}a=v`;
    const started = performance.now();
    assert.equal(redactUrlCredentials(digits), digits);
    // A scan that rescans the run of digits from each position takes hundreds of milliseconds.
    assert.ok(performance.now() - started < 50);
  });
});

describe("redactLinkCredentials", () => {
  it("redacts each target on its own and keeps the rest", () => {
    assert.equal(
      redactLinkCredentials(
        "<https://app.test/x?token=abc>; rel=preload, <https://app.test/y>; rel=next",
      ),
      `<https://app.test/x?token=${R}>; rel=preload, <https://app.test/y>; rel=next`,
    );
    assert.equal(
      redactLinkCredentials("<https://a/x?token=abc <https://b/y?sig=s>; rel=next"),
      `<https://a/x?token=${R}>; rel=next`,
    );
    assert.equal(
      redactLinkCredentials("<https://a.test/x?a=<b&token=abc>; rel=preload"),
      `<https://a.test/x?a=<b&token=${R}>; rel=preload`,
    );
    assert.equal(redactLinkCredentials("<>; rel=x"), "<>; rel=x");
    assert.equal(
      redactLinkCredentials("https://a/x?token=abc; rel=next"),
      "https://a/x?token=abc; rel=next",
    );
  });

  it("redacts each quoted parameter value on its own", () => {
    const srcset = "/i?url=https%3A%2F%2Fb%2Fi.jpg%3FX-Amz-Signature%3DSIG&w=640 640w";
    assert.equal(
      redactLinkCredentials(`<>; rel=preload; as="image"; imagesrcset="${srcset}"`),
      `<>; rel=preload; as="image"; imagesrcset="/i?url=${R}&w=640 640w"`,
    );
    assert.equal(
      redactLinkCredentials('<https://a.test/>; anchor="https://a.test/cb?code=abc"; rel="x"'),
      `<https://a.test/>; anchor="https://a.test/cb?code=${R}"; rel="x"`,
    );
    assert.equal(
      redactLinkCredentials('<https://a.test/>; title="a, b"; rel="next'),
      '<https://a.test/>; title="a, b"; rel="next',
    );
  });

  it("reads only the first MAX_SCANNED_URL characters", () => {
    const value = `<${HOST}/x>; rel=next, ${"a".repeat(MAX_SCANNED_URL)}`;
    assert.equal(redactLinkCredentials(value), value.slice(0, MAX_SCANNED_URL));
    const target = `<${HOST}/?x=1&token=`;
    assert.equal(
      redactLinkCredentials(`${target}${"v".repeat(MAX_SCANNED_URL)}>; rel=next`),
      `${target}${R}`,
    );
  });
});

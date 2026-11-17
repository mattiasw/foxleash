import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXTENSION_ID,
  NATIVE_HOST_NAME,
  OLDEST_SERVED_PROTOCOL,
  PROTOCOL_VERSION,
} from "./index.ts";

describe("protocol constants", () => {
  it("uses a native host name Firefox accepts", () => {
    // Firefox rejects host manifests whose name does not match this pattern.
    assert.match(NATIVE_HOST_NAME, /^\w+(\.\w+)*$/);
  });

  it("uses an email-style add-on ID", () => {
    assert.match(EXTENSION_ID, /^[a-z0-9-]+@[a-z0-9.-]+\.[a-z]+$/);
  });

  it("starts the protocol at a positive integer", () => {
    assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0);
  });

  it("serves protocols from a positive integer up to the current one", () => {
    assert.ok(Number.isInteger(OLDEST_SERVED_PROTOCOL) && OLDEST_SERVED_PROTOCOL > 0);
    assert.ok(OLDEST_SERVED_PROTOCOL <= PROTOCOL_VERSION);
  });
});

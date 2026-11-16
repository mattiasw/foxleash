/** Bump when a message shape or method contract changes incompatibly. */
export const PROTOCOL_VERSION = 4;

/** The native messaging host name, as registered with Firefox. */
export const NATIVE_HOST_NAME = "foxleash";

/** The extension's add-on ID; the native host manifest allows only this one. */
export const EXTENSION_ID = "foxleash@mattiasw.com";

export * from "./handshake.ts";
export * from "./messages.ts";
export * from "./methods.ts";

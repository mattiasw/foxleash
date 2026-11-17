/** Bump when a message shape or method contract changes incompatibly. */
export const PROTOCOL_VERSION = 7;

/**
 * The oldest protocol version the extension still serves; never above the `PROTOCOL_VERSION`
 * of the latest release.
 */
export const OLDEST_SERVED_PROTOCOL = 6;

/** The native messaging host name, as registered with Firefox. */
export const NATIVE_HOST_NAME = "foxleash";

/** The command that installs the Foxleash program on this computer. */
export const SETUP_COMMAND = "npx foxleash setup";

/** What the setup command needs on this computer. */
export const NODE_REQUIREMENT = "Node.js 24 or later";

/** The extension's add-on ID; the native host manifest allows only this one. */
export const EXTENSION_ID = "foxleash@mattiasw.com";

export * from "./handshake.ts";
export * from "./messages.ts";
export * from "./methods.ts";

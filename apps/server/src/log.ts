export type Log = (message: string, detail?: unknown) => void;

const UNSERIALIZABLE = "[unserializable]";

// Characters JSON.stringify leaves raw that a terminal or log viewer treats as a line break, a
// control or a display-reordering character: C1 controls, U+2028/U+2029, bidi and invisible
// format characters.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function createLog(prefix: string, stream: NodeJS.WritableStream = process.stderr): Log {
  return function log(message: string, detail?: unknown): void {
    if (detail === undefined) {
      stream.write(`${prefix} ${message}\n`);
      return;
    }
    stream.write(`${prefix} ${message} ${formatDetail(detail)}\n`);
  };
}

function formatDetail(detail: unknown): string {
  try {
    // Typed as string, but undefined for a function, a symbol or undefined itself.
    const text: string | undefined = JSON.stringify(detail);
    return text === undefined ? UNSERIALIZABLE : text.replace(UNSAFE, escapeUnits);
  } catch {
    return UNSERIALIZABLE;
  }
}

function escapeUnits(match: string): string {
  return Array.from(
    { length: match.length },
    (_, index) => `\\u${match.charCodeAt(index).toString(16).padStart(4, "0")}`,
  ).join("");
}

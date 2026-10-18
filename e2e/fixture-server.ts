import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const TITLES = {
  a: "Fixture page A",
  b: "Fixture page B",
  slow: "Fixture slow page",
} as const;

// Must stay above the extension's LOAD_GRACE_MS (1000 ms, apps/extension/src/wait-for-load.ts):
// the held response is what makes the navigate test fail when the load wait returns early.
const SLOW_HOLD_MS = 1500;

const COUNTER_PREFIX = "Counter ";

export interface FixtureServer {
  url(path: string): string;
  close(): Promise<void>;
}

/** Serves the fixture pages on 127.0.0.1 at a free port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const timers = new Set<NodeJS.Timeout>();
  let counter = 0;

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/a") {
      sendPage(response, TITLES.a);
    } else if (path === "/b") {
      sendPage(response, TITLES.b);
    } else if (path === "/slow") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        sendPage(response, TITLES.slow);
      }, SLOW_HOLD_MS);
      timers.add(timer);
    } else if (path === "/counter") {
      counter += 1;
      sendPage(response, counterTitle(counter));
    } else {
      // Firefox asks for /favicon.ico; it must not reach the counter.
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
  await promise;
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fixture server has no TCP address");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    url: (path) => `${origin}${path}`,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

function sendPage(response: ServerResponse, title: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    // So reload and back fetch the page again.
    "Cache-Control": "no-store",
  });
  response.end(
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body><h1>${title}</h1></body></html>\n`,
  );
}

export function counterTitle(count: number): string {
  return `${COUNTER_PREFIX}${count}`;
}

export function parseCount(title: string): number {
  const match = /^Counter ([0-9]+)$/.exec(title);
  if (match === null) throw new Error(`not a counter page title: ${JSON.stringify(title)}`);
  return Number(match[1]);
}

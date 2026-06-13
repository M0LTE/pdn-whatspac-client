// The pdn-app/1 socket transport for the RF head.
//
// A long-running Unix-domain-socket server (the slice-2 "socket" kind / LOBBY
// pattern): pdn connects once per RF session, writes the connect header, then
// bridges the user's line stream. We parse the header, build an RfSession over
// the shared agent + store, forward `\n`-delimited input lines to feedLine, and
// write the session's output back. Output is `\n`-only — pdn translates each
// `\n` to the transport's CR; we MUST never emit `\r` ourselves. EOF/close on
// the connection means the user is gone → dispose the session.

import net from "node:net";
import { unlink } from "node:fs/promises";
import type { Logger } from "../../agent/agent";
import { WhatspacAgent } from "../../agent/agent";
import { Store } from "../../store/store";
import { RfSession } from "./session";

export interface StartRfHeadOptions {
  agent: WhatspacAgent;
  store: Store;
  socketPath: string;
  myCallsign: string;
  log?: Logger;
}

export interface RfHead {
  close(): Promise<void>;
}

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Bind a Unix socket and serve the RF head. Each accepted connection is one RF
 * user; concurrent connections each get their own RfSession over the shared
 * (long-lived) agent + store. Resolves once listening.
 */
export async function startRfHead(opts: StartRfHeadOptions): Promise<RfHead> {
  const log = opts.log ?? silentLog;

  // pdn (or a prior crashed instance) may have left a stale socket file; a bind
  // over an existing path fails with EADDRINUSE, so unlink it first.
  await unlink(opts.socketPath).catch(() => {});

  const connections = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    connections.add(socket);
    handleConnection(socket, opts, log).finally(() => connections.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(opts.socketPath);
  });

  log.info(`RF head listening on ${opts.socketPath}`);

  return {
    async close(): Promise<void> {
      for (const s of connections) s.destroy();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(opts.socketPath).catch(() => {});
    },
  };
}

/** Drive one accepted connection through header-parse → session → teardown. */
async function handleConnection(
  socket: net.Socket,
  opts: StartRfHeadOptions,
  log: Logger,
): Promise<void> {
  socket.setEncoding("utf8");

  let buffer = "";
  let header: Record<string, string> | undefined;
  let session: RfSession | undefined;

  // Write a line WITHOUT \r; pdn adds the transport newline. We append \n only.
  const write = (line: string): void => {
    if (socket.writableEnded || socket.destroyed) return;
    socket.write(line.replace(/\r/g, "") + "\n");
  };

  const teardown = (): void => {
    if (session) {
      session.dispose();
      session = undefined;
    }
  };

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      teardown();
      resolve();
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      // Phase 1: accumulate the connect header until the blank line.
      if (!header) {
        const sep = findHeaderEnd(buffer);
        if (sep === -1) return; // header still arriving
        const headerText = buffer.slice(0, sep.headerEnd);
        buffer = buffer.slice(sep.bodyStart);
        header = parseHeader(headerText);
        try {
          session = new RfSession({
            agent: opts.agent,
            store: opts.store,
            myCallsign: opts.myCallsign,
            write,
            header,
          });
          session.start();
        } catch (err) {
          log.error(`RF session start failed: ${err instanceof Error ? err.message : String(err)}`);
          socket.end();
          return;
        }
      }

      // Phase 2: feed whole \n-terminated lines to the session.
      if (!session) return;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        // pdn sends \n only, but strip a stray \r defensively.
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        try {
          session.feedLine(line);
        } catch (err) {
          log.error(`RF feedLine error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    // EOF / close / error all mean "user gone": dispose and stop.
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (err) => {
      log.warn(`RF socket error: ${err.message}`);
      finish();
    });
  });
}

/**
 * Locate the end of the connect header — the first blank line. The header is a
 * run of `Key: Value\n` lines terminated by one empty line (`\n`). Returns the
 * index where the header text ends and where the session body begins, or -1 if
 * the blank line has not arrived yet.
 */
function findHeaderEnd(buffer: string): { headerEnd: number; bodyStart: number } | -1 {
  // The blank-line terminator is "\n\n" (an empty line after the last header
  // line). Also tolerate a leading blank line / lone "\n" as an empty header.
  const idx = buffer.indexOf("\n\n");
  if (idx === -1) return -1;
  return { headerEnd: idx, bodyStart: idx + 2 };
}

/** Parse `Key: Value` UTF-8 lines into a lower-cased-key map; ignore malformed lines. */
function parseHeader(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue; // ignore malformed lines (forward-compat)
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key !== "") out[key] = value;
  }
  return out;
}

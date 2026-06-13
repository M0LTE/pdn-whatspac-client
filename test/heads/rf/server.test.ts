import { describe, expect, it, afterEach } from "vitest";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRfHead, type RfHead } from "../../../src/heads/rf/server";
import { WhatspacAgent, type AgentConfig } from "../../../src/agent/agent";
import { Store } from "../../../src/store/store";
import type { ConnectScript } from "../../../src/agent/connectScript";
import type { RhpLink, RhpOpenOptions, RhpTransport } from "../../../src/rhp/transport";

const ME = "M0LTE";

const SCRIPT: ConnectScript = [
  { id: 1, hop: "node", cmd: "GB7NBH", val: "GB7NBH BPQ Packet Node" },
  { id: 2, hop: "WPS", cmd: "C MB7NPW-9", val: "*** Connected to WPS" },
];

/** A transport whose open() never resolves — the agent is never started here. */
class IdleTransport implements RhpTransport {
  open(_opts: RhpOpenOptions): Promise<RhpLink> {
    return new Promise<RhpLink>(() => {});
  }
}

function makeAgent(store: Store): WhatspacAgent {
  const config: AgentConfig = {
    family: "ax25",
    localCallsign: "M0LTE-7",
    whatsPacCallsign: ME,
    displayName: "Tom",
    clientVersion: 0.92,
    connectScript: SCRIPT,
    rhpPort: null,
  };
  return new WhatspacAgent({ transport: new IdleTransport(), store, config });
}

/** Connect, send header + lines, collect output until the server closes the socket. */
function roundTrip(
  socketPath: string,
  header: string,
  lines: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let received = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(header);
      for (const l of lines) sock.write(l + "\n");
      // Give the server a moment to process, then half-close to signal EOF.
      setTimeout(() => sock.end(), 100);
    });
    sock.on("data", (c: string) => (received += c));
    sock.on("close", () => resolve(received));
    sock.on("error", reject);
  });
}

describe("startRfHead (socket round-trip)", () => {
  let head: RfHead | undefined;

  afterEach(async () => {
    await head?.close();
    head = undefined;
  });

  it("parses the connect header, runs commands, and writes \\n-terminated output", async () => {
    const store = new Store();
    store.upsertChannelHeader({ cid: "general", cn: "General" });
    store.setOnline(["G0ABC"]);
    const agent = makeAgent(store);

    const socketPath = join(tmpdir(), `whatspac-rf-${process.pid}-${Date.now()}.sock`);
    head = await startRfHead({ agent, store, socketPath, myCallsign: ME });

    const header =
      "pdn-app: 1\n" +
      "id: whatspac\n" +
      "callsign: M0TST-1\n" +
      "transport: ax25\n" +
      "sysop: 0\n" +
      "args:\n" +
      "\n";

    const output = await roundTrip(socketPath, header, ["WHO", "CH"]);

    // Greeting used the header callsign.
    expect(output).toContain("hi M0TST-1");
    // WHO rendered the online list.
    expect(output).toContain("Online (1): G0ABC");
    // CH rendered the seeded channel.
    expect(output).toContain("General");
    // Wire discipline: lines end with \n, never \r.
    expect(output).not.toContain("\r");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("a posted line reaches the agent over the socket", async () => {
    const store = new Store();
    store.upsertChannelHeader({ cid: "general", cn: "General" });
    const agent = makeAgent(store);

    // The real agent has no spy seam, so assert the optimistic store write
    // postToChannel performs before transmit (the transmit rejects because the
    // agent never connected, but the store write already happened).
    const socketPath = join(tmpdir(), `whatspac-rf-post-${process.pid}-${Date.now()}.sock`);
    head = await startRfHead({ agent, store, socketPath, myCallsign: ME });

    const header = "pdn-app: 1\nid: whatspac\ncallsign: M0TST-1\n\n";
    await roundTrip(socketPath, header, ["CH", "O 1", "P hello over socket"]);

    // postToChannel writes optimistically to the store before transmit; the
    // transmit (link.send) rejects because the agent never connected, but the
    // store write already happened.
    const posts = store.listPosts("general");
    expect(posts.some((p) => p.p === "hello over socket" && p.fc === ME)).toBe(true);
  });

  it("unlinks a stale socket file on start", async () => {
    const store = new Store();
    const agent = makeAgent(store);
    const socketPath = join(tmpdir(), `whatspac-rf-stale-${process.pid}-${Date.now()}.sock`);

    // First bind, close (close() unlinks), then bind again over the same path.
    const first = await startRfHead({ agent, store, socketPath, myCallsign: ME });
    await first.close();
    // A leftover file: create a plain server to occupy the path, then leave it.
    const squatter = net.createServer();
    await new Promise<void>((r) => squatter.listen(socketPath, () => r()));
    await new Promise<void>((r) => squatter.close(() => r())); // leaves the file behind on some platforms
    head = await startRfHead({ agent, store, socketPath, myCallsign: ME });
    expect(head).toBeDefined();
  });
});

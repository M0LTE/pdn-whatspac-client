import { describe, expect, it, beforeEach } from "vitest";
import { RfSession, type RfAgent } from "../../../src/heads/rf/session";
import { Store, conversationId } from "../../../src/store/store";
import { TypedEmitter } from "../../../src/util/emitter";
import type {
  AgentEvents,
} from "../../../src/agent/agent";
import type { ChannelPost, DirectMessage } from "../../../src/protocol/index";

const ME = "M0LTE";

/** A stub agent: a real typed emitter + recorded method calls. */
class StubAgent implements RfAgent {
  readonly events = new TypedEmitter<AgentEvents>();
  readonly posts: Array<{ cid: string; text: string }> = [];
  readonly dms: Array<{ tc: string; text: string }> = [];
  readonly subs: Array<{ cid: string; on: boolean }> = [];

  async postToChannel(cid: string, text: string): Promise<void> {
    this.posts.push({ cid, text });
  }
  async sendDirectMessage(tc: string, text: string): Promise<void> {
    this.dms.push({ tc, text });
  }
  async subscribeChannel(cid: string): Promise<void> {
    this.subs.push({ cid, on: true });
  }
  async unsubscribeChannel(cid: string): Promise<void> {
    this.subs.push({ cid, on: false });
  }
  emitPost(p: ChannelPost): void {
    this.events.emit("post", p);
  }
  emitMessage(m: DirectMessage): void {
    this.events.emit("message", m);
  }
}

function seed(store: Store): void {
  // Channels
  store.upsertChannelHeader({ cid: "general", cn: "General" });
  store.upsertChannelHeader({ cid: "tech", cn: "Tech Talk" });
  store.setChannelSubscribed("general", true);

  // Hams (name lookup)
  store.upsertHam({ c: "G0ABC", n: "Alice", ts: 1 });

  // Posts (ts in ms; newest determines order)
  store.putPost({ t: "cp", cid: "general", fc: "G0ABC", p: "hello world", ts: 1000 });
  store.putPost({ t: "cp", cid: "general", fc: "M0XYZ", p: "second post", ts: 2000 });

  // DMs (ts in seconds). Conversation between ME and G0ABC.
  store.putDirectMessage({ t: "m", fc: "G0ABC", tc: ME, m: "hi tom", ts: 10 });
  store.putDirectMessage({ t: "m", fc: ME, tc: "G0ABC", m: "hi alice", ts: 11 });

  // Presence
  store.setOnline(["G0ABC", "M0XYZ"]);
}

function makeSession(): { session: RfSession; agent: StubAgent; store: Store; out: string[] } {
  const store = new Store();
  seed(store);
  const agent = new StubAgent();
  const out: string[] = [];
  const session = new RfSession({
    agent,
    store,
    myCallsign: ME,
    write: (line) => out.push(line),
    header: { callsign: "M0TST", args: "" },
  });
  return { session, agent, store, out };
}

describe("RfSession", () => {
  let session: RfSession;
  let agent: StubAgent;
  let store: Store;
  let out: string[];

  beforeEach(() => {
    ({ session, agent, store, out } = makeSession());
  });

  it("greets with the connecting callsign and shows the menu", () => {
    session.start();
    expect(out.join("\n")).toContain("hi M0TST");
    expect(out.join("\n")).toContain("--- WhatsPac ---");
  });

  it("never emits a carriage return", () => {
    session.start();
    session.feedLine("CH");
    session.feedLine("O 1");
    for (const line of out) expect(line).not.toContain("\r");
  });

  it("lists channels with index, subscription marker, and post count", () => {
    session.feedLine("CH");
    const text = out.join("\n");
    expect(text).toMatch(/\*1\. General \(2\)/); // subscribed, 2 posts
    expect(text).toMatch(/ 2\. Tech Talk \(0\)/); // not subscribed
  });

  it("opens a channel and shows posts newest-last with sender labels", () => {
    session.feedLine("CH");
    out.length = 0;
    session.feedLine("O 1");
    const text = out.join("\n");
    expect(text).toContain("== General ==");
    // Alice has a ham name; order is oldest-first.
    const helloIdx = text.indexOf("hello world");
    const secondIdx = text.indexOf("second post");
    expect(helloIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(helloIdx);
    expect(text).toContain("G0ABC (Alice)");
  });

  it("rejects O with a bad index", () => {
    session.feedLine("CH");
    out.length = 0;
    session.feedLine("O 9");
    expect(out.join("\n")).toContain("Usage: O <n>");
  });

  it("posts to the open channel via the agent", () => {
    session.feedLine("CH");
    session.feedLine("O 1");
    session.feedLine("P hello from rf");
    expect(agent.posts).toEqual([{ cid: "general", text: "hello from rf" }]);
  });

  it("refuses P with no open channel", () => {
    session.feedLine("P nope");
    expect(agent.posts).toHaveLength(0);
    expect(out.join("\n")).toContain("Open a channel first");
  });

  it("subscribes / unsubscribes the open channel", () => {
    session.feedLine("CH");
    session.feedLine("O 2");
    session.feedLine("SUB");
    session.feedLine("UNSUB");
    expect(agent.subs).toEqual([
      { cid: "tech", on: true },
      { cid: "tech", on: false },
    ]);
  });

  it("lists who is online", () => {
    session.feedLine("WHO");
    expect(out.join("\n")).toContain("Online (2): G0ABC, M0XYZ");
  });

  it("lists DM conversations from myCallsign's perspective", () => {
    session.feedLine("DM");
    const text = out.join("\n");
    // peer is the other party, not ME
    expect(text).toContain("G0ABC (2):");
    expect(text).toContain("hi alice"); // newest preview
  });

  it("opens a DM and shows messages newest-last, labelling own as 'me'", () => {
    session.feedLine("T G0ABC");
    const text = out.join("\n");
    expect(text).toContain("== DM G0ABC ==");
    const hiTomIdx = text.indexOf("hi tom");
    const hiAliceIdx = text.indexOf("hi alice");
    expect(hiTomIdx).toBeGreaterThan(-1);
    expect(hiAliceIdx).toBeGreaterThan(hiTomIdx); // oldest-first
    expect(text).toContain("[me] hi alice");
  });

  it("uppercases the DM target callsign", () => {
    session.feedLine("T g0abc");
    session.feedLine("S hi again");
    expect(agent.dms).toEqual([{ tc: "G0ABC", text: "hi again" }]);
  });

  it("refuses S with no open conversation", () => {
    session.feedLine("S nope");
    expect(agent.dms).toHaveLength(0);
    expect(out.join("\n")).toContain("Open a conversation first");
  });

  it("shows help and reports unknown commands", () => {
    session.feedLine("H");
    expect(out.join("\n")).toContain("Commands:");
    out.length = 0;
    session.feedLine("FLOOP");
    expect(out.join("\n")).toContain("unknown: FLOOP");
  });

  it("renders WhatsPic / image posts as [image omitted]", () => {
    store.putPost({
      t: "cp",
      cid: "general",
      fc: "G0ABC",
      p: "/9j/" + "A".repeat(50),
      ts: 3000,
    });
    session.feedLine("CH");
    out.length = 0;
    session.feedLine("O 1");
    expect(out.join("\n")).toContain("[image omitted]");
  });

  // ---- live updates ----

  it("forwards a new post live while the channel is open", () => {
    session.feedLine("CH");
    session.feedLine("O 1");
    out.length = 0;
    agent.emitPost({ t: "cp", cid: "general", fc: "M0XYZ", p: "live one", ts: 5000 });
    expect(out.join("\n")).toContain(">> ");
    expect(out.join("\n")).toContain("live one");
  });

  it("does not echo the user's own post back as a live line", () => {
    session.feedLine("CH");
    session.feedLine("O 1");
    out.length = 0;
    agent.emitPost({ t: "cp", cid: "general", fc: ME, p: "my own", ts: 5000 });
    expect(out.join("\n")).not.toContain("my own");
  });

  it("does not forward posts from a different channel", () => {
    session.feedLine("CH");
    session.feedLine("O 1"); // general
    out.length = 0;
    agent.emitPost({ t: "cp", cid: "tech", fc: "M0XYZ", p: "elsewhere", ts: 5000 });
    expect(out.join("\n")).not.toContain("elsewhere");
  });

  it("stops forwarding posts after leaving the channel view", () => {
    session.feedLine("CH");
    session.feedLine("O 1");
    session.feedLine("M"); // back to menu
    out.length = 0;
    agent.emitPost({ t: "cp", cid: "general", fc: "M0XYZ", p: "after leave", ts: 5000 });
    expect(out.join("\n")).not.toContain("after leave");
  });

  it("forwards a new inbound DM live while the conversation is open", () => {
    session.feedLine("T G0ABC");
    out.length = 0;
    agent.emitMessage({ t: "m", fc: "G0ABC", tc: ME, m: "live dm", ts: 20 });
    expect(out.join("\n")).toContain(">> ");
    expect(out.join("\n")).toContain("live dm");
  });

  it("only forwards DMs from the open conversation", () => {
    session.feedLine("T G0ABC");
    out.length = 0;
    agent.emitMessage({ t: "m", fc: "M0OTH", tc: ME, m: "other convo", ts: 20 });
    expect(out.join("\n")).not.toContain("other convo");
  });

  it("dispose() stops further live forwarding and output", () => {
    session.feedLine("T G0ABC");
    session.dispose();
    out.length = 0;
    agent.emitMessage({ t: "m", fc: "G0ABC", tc: ME, m: "post dispose", ts: 21 });
    session.feedLine("WHO");
    expect(out).toHaveLength(0);
  });

  it("switching views unsubscribes the previous live stream", () => {
    session.feedLine("CH");
    session.feedLine("O 1"); // channel general
    session.feedLine("T G0ABC"); // switch to DM
    out.length = 0;
    // A post for general must no longer be forwarded.
    agent.emitPost({ t: "cp", cid: "general", fc: "M0XYZ", p: "stale", ts: 6000 });
    expect(out.join("\n")).not.toContain("stale");
  });

  it("conversationId helper agrees with the view's sid", () => {
    // Sanity: the DM-forward filter keys on conversationId(ME, peer).
    expect(conversationId(ME, "G0ABC")).toBe(conversationId("G0ABC", ME));
  });
});

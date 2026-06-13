// The RF-terminal head: a pure, socket-decoupled session handler.
//
// One RfSession renders the daemon's shared Store + WhatspacAgent to a single
// connected RF user over the pdn-app/1 line-oriented wire. It is deliberately
// transport-agnostic — it `write()`s plain UTF-8 lines (the socket layer adds
// the CR) and is fed input lines via `feedLine()` — so it unit-tests without a
// socket. The UX is terse and numbered, sized for low-bandwidth packet links.

import type { Callsign, ChannelPost, DirectMessage } from "../../protocol/index";
import { Store, conversationId, type DmRow, type PostRow } from "../../store/store";

/**
 * The slice of {@link WhatspacAgent} the head drives. A structural interface so
 * tests can pass a lightweight stub; the real agent satisfies it.
 */
export interface RfAgent {
  readonly events: {
    on(event: "post", listener: (p: ChannelPost) => void): () => void;
    on(event: "message", listener: (m: DirectMessage) => void): () => void;
    on(event: "presence", listener: (online: Callsign[]) => void): () => void;
  };
  postToChannel(cid: string, text: string): Promise<void>;
  sendDirectMessage(tc: Callsign, text: string): Promise<void>;
  subscribeChannel(cid: string): Promise<void>;
  unsubscribeChannel(cid: string): Promise<void>;
}

export interface RfSessionDeps {
  agent: RfAgent;
  store: Store;
  /** The daemon's own WhatsPac callsign — the perspective for DMs / conversationId. */
  myCallsign: Callsign;
  /** Emit one output line. The line is plain text WITHOUT a trailing newline; the session adds `\n`. */
  write: (line: string) => void;
  /** The parsed pdn-app/1 connect header (callsign, args, …). */
  header: Record<string, string>;
}

/** The current "view" — what live traffic the session forwards. */
type View =
  | { kind: "menu" }
  | { kind: "channel"; cid: string }
  | { kind: "dm"; peer: Callsign; sid: string };

const HELP_LINES = [
  "Commands:",
  "  CH            list channels",
  "  O <n>         open channel n (from CH)",
  "  P <text>      post to the open channel",
  "  SUB / UNSUB   (un)subscribe the open channel",
  "  WHO           who is online",
  "  DM            list DM conversations",
  "  T <call>      open/start a DM with <call>",
  "  S <text>      send a DM in the open conversation",
  "  M             back to the menu",
  "  H             this help",
  "  Q             quit",
];

const PREVIEW_LIMIT = 40;
const HISTORY_LIMIT = 10;

export class RfSession {
  private readonly agent: RfAgent;
  private readonly store: Store;
  private readonly myCallsign: Callsign;
  private readonly write: (line: string) => void;
  private readonly header: Record<string, string>;

  private view: View = { kind: "menu" };
  /** Cached channel id list backing the numeric `O <n>` selector. */
  private channelIndex: string[] = [];
  /** Active live-event unsubscribe, torn down on every view change / dispose. */
  private unsubscribe?: () => void;
  private disposed = false;

  constructor(deps: RfSessionDeps) {
    this.agent = deps.agent;
    this.store = deps.store;
    this.myCallsign = deps.myCallsign;
    this.write = deps.write;
    this.header = deps.header;
  }

  /** Greet the user and show the main menu. */
  start(): void {
    const who = this.header["callsign"] ?? "OM";
    this.emit(`WhatsPac terminal — hi ${who}.`);
    this.showMenu();
  }

  /** Interpret one input line. Tolerant of leading/trailing space and case in verbs. */
  feedLine(line: string): void {
    if (this.disposed) return;
    const trimmed = line.trim();
    if (trimmed === "") return;

    const sp = trimmed.indexOf(" ");
    const verb = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toUpperCase();
    const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();

    switch (verb) {
      case "H":
      case "?":
      case "HELP":
        this.showHelp();
        return;
      case "M":
      case "MENU":
        this.setView({ kind: "menu" });
        this.showMenu();
        return;
      case "CH":
      case "C":
        this.cmdChannels();
        return;
      case "O":
      case "OPEN":
        this.cmdOpenChannel(rest);
        return;
      case "P":
      case "POST":
        void this.cmdPost(rest);
        return;
      case "SUB":
        void this.cmdSubscribe(true);
        return;
      case "UNSUB":
        void this.cmdSubscribe(false);
        return;
      case "WHO":
      case "W":
        this.cmdWho();
        return;
      case "DM":
      case "D":
        this.cmdConversations();
        return;
      case "T":
      case "TALK":
        this.cmdOpenDm(rest);
        return;
      case "S":
      case "SEND":
        void this.cmdSendDm(rest);
        return;
      case "Q":
      case "QUIT":
      case "BYE":
        this.emit("73.");
        return;
      default:
        this.emit(`? unknown: ${verb}  (H for help)`);
        return;
    }
  }

  /** Tear down live subscriptions. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearLive();
  }

  // ---- menu / help ----

  private showMenu(): void {
    this.emit("--- WhatsPac ---");
    this.emit("CH channels  WHO online  DM messages  H help  Q quit");
  }

  private showHelp(): void {
    for (const l of HELP_LINES) this.emit(l);
  }

  // ---- channels ----

  private cmdChannels(): void {
    const channels = this.store.listChannels();
    this.channelIndex = channels.map((c) => c.cid);
    if (channels.length === 0) {
      this.emit("No channels yet.");
      return;
    }
    this.emit(`Channels (${channels.length}) — O <n> to open:`);
    channels.forEach((c, i) => {
      const sub = c.subscribed ? "*" : " ";
      const n = this.store.countPosts(c.cid);
      this.emit(`${sub}${i + 1}. ${this.channelLabel(c.cid, c.cn)} (${n})`);
    });
  }

  private cmdOpenChannel(arg: string): void {
    if (this.channelIndex.length === 0) {
      // Allow O <n> directly by lazily populating the index from the store.
      this.channelIndex = this.store.listChannels().map((c) => c.cid);
    }
    const idx = Number.parseInt(arg, 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > this.channelIndex.length) {
      this.emit("Usage: O <n>  (CH lists channels)");
      return;
    }
    const cid = this.channelIndex[idx - 1]!;
    this.setView({ kind: "channel", cid });
    const cn = this.store.listChannels().find((c) => c.cid === cid)?.cn ?? null;
    this.emit(`== ${this.channelLabel(cid, cn)} ==`);
    const posts = this.store.listPosts(cid, HISTORY_LIMIT);
    if (posts.length === 0) {
      this.emit("(no posts)");
    } else {
      // Store returns newest-first; show newest-LAST (natural reading order).
      for (const p of [...posts].reverse()) this.emit(this.formatPost(p));
    }
    this.emit("P <text> to post, M for menu.");
  }

  private async cmdPost(text: string): Promise<void> {
    if (this.view.kind !== "channel") {
      this.emit("Open a channel first (CH then O <n>).");
      return;
    }
    if (text === "") {
      this.emit("Usage: P <text>");
      return;
    }
    try {
      await this.agent.postToChannel(this.view.cid, text);
    } catch (err) {
      this.emit(`! post failed: ${errText(err)}`);
    }
  }

  private async cmdSubscribe(on: boolean): Promise<void> {
    if (this.view.kind !== "channel") {
      this.emit("Open a channel first (CH then O <n>).");
      return;
    }
    try {
      if (on) await this.agent.subscribeChannel(this.view.cid);
      else await this.agent.unsubscribeChannel(this.view.cid);
      this.emit(on ? "Subscribed." : "Unsubscribed.");
    } catch (err) {
      this.emit(`! failed: ${errText(err)}`);
    }
  }

  // ---- presence ----

  private cmdWho(): void {
    const online = this.store.onlineCallsigns();
    if (online.length === 0) {
      this.emit("Nobody online.");
      return;
    }
    this.emit(`Online (${online.length}): ${online.join(", ")}`);
  }

  // ---- direct messages ----

  private cmdConversations(): void {
    const convos = this.store.listConversations(this.myCallsign);
    if (convos.length === 0) {
      this.emit("No conversations. T <call> to start one.");
      return;
    }
    this.emit(`DMs (${convos.length}) — T <call> to open:`);
    for (const c of convos) {
      this.emit(`  ${c.peer} (${c.count}): ${truncate(scrub(c.lastText), PREVIEW_LIMIT)}`);
    }
  }

  private cmdOpenDm(arg: string): void {
    const peer = arg.toUpperCase();
    if (peer === "") {
      this.emit("Usage: T <callsign>");
      return;
    }
    const sid = conversationId(this.myCallsign, peer);
    this.setView({ kind: "dm", peer, sid });
    this.emit(`== DM ${peer} ==`);
    const msgs = this.store.listDirectMessages(sid, HISTORY_LIMIT);
    if (msgs.length === 0) {
      this.emit("(no messages)");
    } else {
      for (const m of [...msgs].reverse()) this.emit(this.formatDm(m));
    }
    this.emit("S <text> to send, M for menu.");
  }

  private async cmdSendDm(text: string): Promise<void> {
    if (this.view.kind !== "dm") {
      this.emit("Open a conversation first (T <call>).");
      return;
    }
    if (text === "") {
      this.emit("Usage: S <text>");
      return;
    }
    try {
      await this.agent.sendDirectMessage(this.view.peer, text);
    } catch (err) {
      this.emit(`! send failed: ${errText(err)}`);
    }
  }

  // ---- live updates ----

  // On entering a view, subscribe to the matching agent stream and forward new
  // traffic to the wire prefixed with ">>" so it is unmistakably an incoming
  // line interleaved with the user's typing. Torn down on every view change.
  private setView(next: View): void {
    this.clearLive();
    this.view = next;
    if (next.kind === "channel") {
      this.unsubscribe = this.agent.events.on("post", (p: ChannelPost) => {
        if (p.cid === next.cid && p.fc !== this.myCallsign) {
          this.emit(`>> ${this.formatPost(toPostRow(p))}`);
        }
      });
    } else if (next.kind === "dm") {
      this.unsubscribe = this.agent.events.on("message", (m: DirectMessage) => {
        if (conversationId(m.fc, m.tc) === next.sid && m.fc !== this.myCallsign) {
          this.emit(`>> ${this.formatDm(toDmRow(m, next.sid))}`);
        }
      });
    }
  }

  private clearLive(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- formatting ----

  private emit(line: string): void {
    if (this.disposed) return;
    this.write(line);
  }

  private channelLabel(cid: string, cn: string | null): string {
    return cn && cn.trim() !== "" ? cn : cid;
  }

  private formatPost(p: PostRow): string {
    const who = this.senderLabel(p.fc);
    return `[${who}] ${scrub(p.p)}`;
  }

  private formatDm(m: DmRow): string {
    const who = m.fc === this.myCallsign ? "me" : this.senderLabel(m.fc);
    return `[${who}] ${scrub(m.m)}`;
  }

  private senderLabel(c: Callsign): Callsign {
    const ham = this.store.getHam(c);
    return ham?.n && ham.n.trim() !== "" ? `${c} (${ham.n})` : c;
  }
}

// ---- helpers ----

function toPostRow(p: ChannelPost): PostRow {
  return {
    _id: p._id ?? `${p.ts}-${p.fc}`,
    cid: p.cid,
    fc: p.fc,
    p: p.p,
    ts: p.ts,
    rts: p.rts ?? null,
    rfc: p.rfc ?? null,
  };
}

function toDmRow(m: DirectMessage, sid: string): DmRow {
  return {
    _id: m._id ?? `${m.ts}-${m.fc}`,
    sid,
    fc: m.fc,
    tc: m.tc,
    m: m.m,
    ts: m.ts,
  };
}

/**
 * Render image/emoji payloads packet-friendly. WhatsPic images arrive as data
 * URIs / base64 blobs in the text; collapse them to a marker. Emoji react
 * markup (when present in text) is left inline — it is already short.
 */
function scrub(text: string): string {
  if (text === "") return "(empty)";
  // A WhatsPic post carries the image inline (data URI or bare base64 JPEG).
  if (/^data:image\//i.test(text) || /^\/9j\/[A-Za-z0-9+/]{40,}/.test(text)) {
    return "[image omitted]";
  }
  // Replace any embedded data-image URI mid-text too.
  const replaced = text.replace(/data:image\/[^\s)]+/gi, "[image omitted]");
  // Strip stray CRs (we must never emit \r) and collapse newlines to spaces so
  // one logical message stays on one packet line.
  return replaced.replace(/\r/g, "").replace(/\n/g, " ");
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

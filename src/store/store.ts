// Persistent store — the SQLite mirror of the WhatsPac client state.
//
// Schema follows docs/wps-protocol.md §8 (the SPA's Dexie tables): users,
// messages (DMs), posts, hams, channels, plus a key/value config table. Uses
// the built-in node:sqlite (no native dependency), which keeps single-binary
// packaging clean.
//
// The store is the single source of truth both heads render, and the source of
// the delta cursors the agent sends in its connect object on (re)connect.

import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import type {
  Avatar,
  Callsign,
  ChannelHeader,
  ChannelPost,
  DirectMessage,
  HamName,
  UserObject,
} from "../protocol/messages";

/** The `cc` delta cursor for one subscribed channel. */
export interface ChannelCursor {
  cid: string;
  lp: number;
  le: number;
  led: number;
}

/** Everything the connect object needs to ask the server for a delta backfill. */
export interface ConnectCursors {
  lm: number;
  le: number;
  led: number;
  lhts: number;
  cc: ChannelCursor[];
}

export interface ChannelRow {
  cid: string;
  cn: string | null;
  subscribed: boolean;
}

export interface DmRow {
  _id: string;
  sid: string;
  fc: Callsign;
  tc: Callsign;
  m: string;
  ts: number;
}

export interface PostRow {
  _id: string;
  cid: string;
  fc: Callsign;
  p: string;
  ts: number;
  rts: number | null;
  rfc: Callsign | null;
}

export interface HamRow {
  c: Callsign;
  n: string | null;
  ts: number;
  a: string | null;
  ats: number;
}

export interface ConversationRow {
  sid: string;
  peer: Callsign;
  lastText: string;
  lastTs: number;
  count: number;
}

/** `sid` is the DM conversation key: the two callsigns sorted and joined. */
export function conversationId(a: Callsign, b: Callsign): string {
  return [a, b].sort().join("|");
}

// node:sqlite is newer than the test bundler's builtin list, so load the value
// via require() (the type comes from the erased `import type` above). At runtime
// — Node ≥ 22.5, or the SEA binary — it resolves natively.
const { DatabaseSync: DatabaseSyncCtor } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export class Store {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSyncCtor(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        tc TEXT PRIMARY KEY,
        n  TEXT,
        ls INTEGER,
        us INTEGER
      );
      CREATE TABLE IF NOT EXISTS online (
        c TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS hams (
        c   TEXT PRIMARY KEY,
        n   TEXT,
        ts  INTEGER DEFAULT 0,
        a   TEXT,
        ats INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS channels (
        cid        TEXT PRIMARY KEY,
        cn         TEXT,
        subscribed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        _id  TEXT PRIMARY KEY,
        sid  TEXT,
        fc   TEXT,
        tc   TEXT,
        m    TEXT,
        ts   INTEGER DEFAULT 0,
        ms   INTEGER DEFAULT 0,
        rs   INTEGER DEFAULT 0,
        e    TEXT,
        ets  INTEGER DEFAULT 0,
        edts INTEGER DEFAULT 0,
        r    TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_sid_ts ON messages(sid, ts);
      CREATE TABLE IF NOT EXISTS posts (
        _id  TEXT PRIMARY KEY,
        cid  TEXT,
        fc   TEXT,
        p    TEXT,
        ts   INTEGER DEFAULT 0,
        ps   INTEGER DEFAULT 0,
        rs   INTEGER DEFAULT 0,
        e    TEXT,
        ets  INTEGER DEFAULT 0,
        edts INTEGER DEFAULT 0,
        rts  INTEGER,
        rfc  TEXT,
        at   TEXT
      );
      CREATE INDEX IF NOT EXISTS posts_cid_ts ON posts(cid, ts);
    `);
  }

  // ---- config (key/value) ----

  getConfig(key: string): string | undefined {
    const row = this.db.prepare("SELECT v FROM config WHERE k = ?").get(key) as
      | { v: string }
      | undefined;
    return row?.v;
  }

  setConfig(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(key, value);
  }

  // ---- ingest ----

  upsertUser(u: UserObject): void {
    this.db
      .prepare(
        `INSERT INTO users (tc, n, ls, us) VALUES (?, ?, ?, ?)
         ON CONFLICT(tc) DO UPDATE SET
           n  = coalesce(excluded.n, users.n),
           ls = coalesce(excluded.ls, users.ls),
           us = coalesce(excluded.us, users.us)`,
      )
      .run(u.tc, u.n ?? null, u.ls ?? null, typeof u["us"] === "number" ? (u["us"] as number) : null);
  }

  setOnline(callsigns: Callsign[]): void {
    const tx = this.db.prepare("DELETE FROM online");
    tx.run();
    const ins = this.db.prepare("INSERT OR IGNORE INTO online (c) VALUES (?)");
    for (const c of callsigns) ins.run(c);
  }

  addOnline(c: Callsign): void {
    this.db.prepare("INSERT OR IGNORE INTO online (c) VALUES (?)").run(c);
  }

  removeOnline(c: Callsign): void {
    this.db.prepare("DELETE FROM online WHERE c = ?").run(c);
  }

  onlineCallsigns(): Callsign[] {
    return (this.db.prepare("SELECT c FROM online ORDER BY c").all() as { c: string }[]).map(
      (r) => r.c,
    );
  }

  upsertHam(h: HamName): void {
    this.db
      .prepare(
        `INSERT INTO hams (c, n, ts) VALUES (?, ?, ?)
         ON CONFLICT(c) DO UPDATE SET
           n  = excluded.n,
           ts = max(hams.ts, excluded.ts)`,
      )
      .run(h.c, h.n, h.ts ?? 0);
  }

  upsertAvatar(a: Avatar): void {
    if (!a.c) return;
    this.db
      .prepare(
        `INSERT INTO hams (c, a, ats) VALUES (?, ?, ?)
         ON CONFLICT(c) DO UPDATE SET
           a   = excluded.a,
           ats = max(hams.ats, excluded.ats)`,
      )
      .run(a.c, a.a ?? null, a.ts ?? 0);
  }

  /** True when no ham row exists for `c` (used to auto-fire a name enquiry). */
  hamUnknown(c: Callsign): boolean {
    return (
      (this.db.prepare("SELECT 1 FROM hams WHERE c = ? AND n IS NOT NULL").get(c) as
        | object
        | undefined) === undefined
    );
  }

  upsertChannelHeader(ch: ChannelHeader): void {
    this.db
      .prepare(
        `INSERT INTO channels (cid, cn) VALUES (?, ?)
         ON CONFLICT(cid) DO UPDATE SET cn = coalesce(excluded.cn, channels.cn)`,
      )
      .run(ch.cid, ch.cn ?? null);
  }

  setChannelSubscribed(cid: string, subscribed: boolean): void {
    this.db
      .prepare(
        `INSERT INTO channels (cid, subscribed) VALUES (?, ?)
         ON CONFLICT(cid) DO UPDATE SET subscribed = excluded.subscribed`,
      )
      .run(cid, subscribed ? 1 : 0);
  }

  putDirectMessage(m: DirectMessage): void {
    const id = m._id ?? `${m.ts}-${m.fc}`;
    const sid = conversationId(m.fc, m.tc);
    this.db
      .prepare(
        `INSERT INTO messages (_id, sid, fc, tc, m, ts, r) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(_id) DO UPDATE SET m = excluded.m`,
      )
      .run(id, sid, m.fc, m.tc, m.m, m.ts ?? 0, m.r ?? null);
  }

  putPost(p: ChannelPost): void {
    const id = p._id ?? `${p.ts}-${p.fc}`;
    this.db
      .prepare(
        `INSERT INTO posts (_id, cid, fc, p, ts, rts, rfc, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(_id) DO UPDATE SET p = excluded.p`,
      )
      .run(
        id,
        p.cid,
        p.fc,
        p.p,
        p.ts ?? 0,
        p.rts ?? null,
        p.rfc ?? null,
        p.at ? JSON.stringify(p.at) : null,
      );
  }

  // ---- queries (the heads render these) ----

  listChannels(): ChannelRow[] {
    return (
      this.db.prepare("SELECT cid, cn, subscribed FROM channels ORDER BY cid").all() as {
        cid: string;
        cn: string | null;
        subscribed: number;
      }[]
    ).map((r) => ({ cid: r.cid, cn: r.cn, subscribed: r.subscribed !== 0 }));
  }

  listPosts(cid: string, limit = 100): PostRow[] {
    return this.db
      .prepare(
        "SELECT _id, cid, fc, p, ts, rts, rfc FROM posts WHERE cid = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(cid, limit) as unknown as PostRow[];
  }

  listDirectMessages(sid: string, limit = 100): DmRow[] {
    return this.db
      .prepare("SELECT _id, sid, fc, tc, m, ts FROM messages WHERE sid = ? ORDER BY ts DESC LIMIT ?")
      .all(sid, limit) as unknown as DmRow[];
  }

  countPosts(cid: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM posts WHERE cid = ?").get(cid) as { n: number })
      .n;
  }

  /** The newest avatar timestamp held, for the WhatsPic enquiry's `lats` cursor. */
  lastAvatarTs(): number {
    return ((this.db.prepare("SELECT max(ats) AS v FROM hams").get() as { v: number | null }).v ?? 0) as number;
  }

  /** A ham (name + avatar) by callsign, for display in the heads. */
  getHam(c: Callsign): HamRow | undefined {
    return this.db.prepare("SELECT c, n, ts, a, ats FROM hams WHERE c = ?").get(c) as
      | HamRow
      | undefined;
  }

  /**
   * Distinct DM conversations from the point of view of `myCallsign`: the peer
   * callsign, the latest message preview, and a count — for the heads' DM list.
   */
  listConversations(myCallsign: Callsign): ConversationRow[] {
    const rows = this.db
      .prepare(
        `SELECT sid,
                count(*)                AS n,
                max(ts)                 AS lastTs
           FROM messages
          GROUP BY sid
          ORDER BY lastTs DESC`,
      )
      .all() as { sid: string; n: number; lastTs: number }[];
    return rows.map((r) => {
      const last = this.db
        .prepare("SELECT fc, tc, m FROM messages WHERE sid = ? ORDER BY ts DESC LIMIT 1")
        .get(r.sid) as { fc: string; tc: string; m: string } | undefined;
      const peer = last ? (last.fc === myCallsign ? last.tc : last.fc) : r.sid;
      return { sid: r.sid, peer, lastText: last?.m ?? "", lastTs: r.lastTs, count: r.n };
    });
  }

  // ---- connect-object delta cursors (mirrors the SPA, docs §5) ----

  getConnectCursors(): ConnectCursors {
    const maxAll = (sql: string): number =>
      ((this.db.prepare(sql).get() as { v: number | null }).v ?? 0) as number;
    const maxFor = (sql: string, cid: string): number =>
      ((this.db.prepare(sql).get(cid) as { v: number | null }).v ?? 0) as number;

    const cc: ChannelCursor[] = (
      this.db.prepare("SELECT cid FROM channels WHERE subscribed = 1 ORDER BY cid").all() as {
        cid: string;
      }[]
    ).map((c) => ({
      cid: c.cid,
      lp: maxFor("SELECT max(ts) AS v FROM posts WHERE cid = ?", c.cid),
      le: maxFor("SELECT max(ets) AS v FROM posts WHERE cid = ?", c.cid),
      led: maxFor("SELECT max(edts) AS v FROM posts WHERE cid = ?", c.cid),
    }));

    return {
      lm: maxAll("SELECT max(ts) AS v FROM messages"),
      le: maxAll("SELECT max(ets) AS v FROM messages"),
      led: maxAll("SELECT max(edts) AS v FROM messages"),
      lhts: maxAll("SELECT max(ts) AS v FROM hams"),
      cc,
    };
  }

  close(): void {
    this.db.close();
  }
}

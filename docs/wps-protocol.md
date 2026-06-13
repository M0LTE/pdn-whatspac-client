# WhatsPac Server (WPS) application protocol — code-grounded reference

> Source of truth: static analysis of the production WhatsPac SPA bundle
> (`/home/tf/whatspac-capture/index.js`, ~2.2 MB, beautified to
> `index.pretty.js`). Every claim below is read directly from the bundle; line
> numbers cite the beautified file. Items that genuinely cannot be settled
> from the client code are collected in **§9 STILL UNKNOWN**.
>
> Client version observed in this bundle: **`whatsPacVersion = 0.92`**
> (`sle = 0.92`, line 34612; surfaced as the connect-object `v` field).

This supersedes the inferred §3 of `docs/whatspac-client-design.md`. Where the
two disagree, the corrections are called out inline (search "CORRECTION").

---

## 1. Transport stack (bottom-up)

1. **KISS / AX.25** — driven by the local packet engine (XRouter / LinBPQ).
2. **A transparent connected-mode byte stream**, obtained over **RHPv2**
   (WebSocket to the engine at `ws://…/rhp`, port 9000). The SPA never opens
   `MB7NPW-9` directly — it opens the **first hop** of the connect-script and
   then runs the script inside the stream. See §6.
3. **App framing** — deflate + base64 + a `Ã` compression-wrap, line-delimited
   by `\r`. See §2. **This is the single biggest correction to the prior doc.**
4. **JSON objects** with a `t` type discriminator and short-key fields. See §3.

---

## 2. Framing (SOLID — read from the codec)

### 2.1 The codec functions (`ma` encode, `cfe` decode)

`index.pretty.js:38246-38267`:

```js
const K6 = "Ã",                                  // U+00C3, one JS char (0xC3)
  ma = (e) => {                                  // ENCODE  (client -> server)
    const t = vY.deflate(e, { to: "string" }),   // pako.deflate(JSON) -> binary string
      n = btoa(String.fromCharCode(...t)),       // base64
      r = K6 + n + K6,                           // wrap with Ã ... Ã
      a = (r.length / e.length).toFixed(2) * 100;
    return r.length < e.length                   // only send compressed if it is smaller
      ? (console.log(`Compression Result: ${a}%, sending compressed data.`), r)
      : (console.log(`Compression Result: ${a}%, sending uncompressed data.`), e);
  },
  cfe = (e) => {                                 // DECODE  (server -> client, compressed)
    const n = atob(e).split("").map(i => i.charCodeAt(0)),
      r = new Uint8Array(n);
    return vY.inflate(r, { to: "string" });      // pako.inflate -> JSON text
  };
```

`vY` is the pako module object (`index.pretty.js:38236-38246`: `vY = {Deflate, deflate, deflateRaw, gzip, Inflate, inflate, inflateRaw, ungzip, constants}`).

### 2.2 The deflate variant — **zlib-wrapped, level 6, window 15**

`ma()` calls **`pako.deflate(...)`** (the default), NOT `deflateRaw`. pako's
default produces a **zlib-wrapped** stream (2-byte header `78 9C`, level 6,
window bits 15, Adler-32 trailer). Verified empirically:

```
deflate('{"t":"k"}')  ->  hex head 78 9c   ->  base64 "eJyrVipRslLKVqoFAA0QApo="
deflateRaw(same)      ->  hex head ab 56   (NOT used by WPS)
```

**For the C# codec:** use `System.IO.Compression.ZLibStream`
(zlib-wrapped) — NOT `DeflateStream` (raw). Decompress should accept the
2-byte zlib header; compress should emit it. Level 6 (`Optimal`/default)
reproduces pako byte-for-byte in practice, but the wire is self-describing so
any valid deflate is decodable; only re-encode byte-equality is level-sensitive.

### 2.3 Full on-wire frame (BOTH directions)

```
frame = "Ã" + base64( zlib_deflate( JSON.stringify(obj) ) ) + "Ã"      (compressed)
   or   = JSON.stringify(obj)                                          (uncompressed fallback)
then the SENDER appends "\r"  (0x0D)
```

- **`Ã` = U+00C3 = byte 0xC3.** It is a *compression marker / wrap*, present on
  **both ends of the payload**, the same in both directions.
  **CORRECTION vs prior doc:** the server→client delimiter is **NOT** `0xC0`
  (FEND), and the `0xC3 0x80` pair the doc described is a red herring. The
  marker is a single `Ã` (0xC3) at the start and end of the base64.
- **`\r` (0x0D) is the frame terminator in BOTH directions** — see the
  receive accumulator (§2.4), which splits incoming data on `"\r"`. The prior
  doc had this right for client→server and wrong for server→client.
- **Uncompressed fallback:** if the compressed+wrapped form is not shorter than
  the raw JSON, `ma()` returns the **raw JSON string** instead. The receiver
  (§2.4 `T`) detects this: a frame whose first/last 2 chars are not `Ã`
  but that starts with `{` / ends with `}` is parsed as plain JSON. A codec
  MUST handle both forms on receive. (In practice almost everything compresses
  smaller, but tiny objects like `{"t":"k"}` may go uncompressed.)

### 2.4 Receive accumulator + frame split (SOLID)

`index.pretty.js:73900-73960`. The accumulator (`c.current` is the partial-line
buffer, `w = "Ã"`):

```js
const w = "Ã";
// classify one already-split line:
const T = (S) => {
  if (S.slice(0, 2) == w && S.slice(-2) == w) {          // compressed: Ã..Ã wrap
    const N = S.slice(2, -2);                            //   strip the wrap
    const P = cfe(N);                                    //   atob -> inflate -> JSON text
    return JSON.parse(P);
  }
  if (S.at(0) == "{" || S.trim().at(-1) == "}") {        // uncompressed fallback
    return JSON.parse(S);
  }
};
// the splitter (S(...) preprocessor): prepend leftover buffer, split on "\r"
const P = M.split("\r");
//  - P.length == 1            -> no complete frame, stash all in buffer
//  - last element == ""       -> all frames complete, clear buffer, pop the ""
//  - last element non-empty   -> last frame incomplete, stash it in buffer
```

Note `S.slice(0,2)`/`S.slice(-2)` test *two* JS chars but `w` is one char; in
the browser the inbound bytes are UTF-8-decoded so a single 0xC3 byte may
surface as the 2-char sequence `Ã` + low byte — the test is written defensively.
**A raw-byte (Latin-1) client should treat the marker as the single byte 0xC3
at offset 0 and at the last byte before the `\r`**, and split frames on 0x0D.

### 2.5 RHP envelopes that carry the frames (SOLID)

`index.pretty.js:14770-14797`:

```js
fT = { type:"open", id, pfam:"ax25",   mode:"stream", port, local, remote, flags:128 };  // L2
XW = { type:"open", id, pfam:"netrom", mode:"stream",       local, remote, flags:128 };  // L4
qA = { id, type:"close", handle:null };
Dr = { type:"send", handle:null, data:null };   // data = ma(JSON)+"\r"
```

Every WPS send site is `xxx.data = ma(JSON.stringify(obj)) + "\r"` with the `Dr`
("send") envelope (e.g. lines 38383, 71290, 74318, 75314, 80871, 81113,
104008, 106036).

---

## 3. Message catalogue (the `t` field) — every type, code-confirmed

Direction: **→** client→WPS, **←** WPS→client, **↔** both.
All field names are the literal short keys. "SOLID" = read from a constructor
or a dispatch arm in the bundle.

Inbound dispatch: the `switch (ee.t)` at `index.pretty.js:74738-75143`.
Outbound builders cited per-row.

### 3.1 Session

| `t` | Dir | Fields | Meaning | Status |
|---|---|---|---|---|
| `c` | ↔ | **out:** `{t:"c", n:name, c:whatsPacCallsign, lm, le, led, lhts, v, cc?}` · **in:** `{t:"c", w, mc, pc, v}` | Connect/login. See §5 for exact construction. Reply: `w`=new(1)/returning, `mc`=message count, `pc`=post count, `v`=**server** version (drives upgrade nag at 74461). | SOLID |
| `k` | → | `{t:"k"}` | Keepalive. Emitted by the idle timer (§7). | SOLID (38380) |

### 3.2 Users / presence

| `t` | Dir | Fields | Meaning | Status |
|---|---|---|---|---|
| `u` | ← | `{t:"u", u:[ {tc, n, ls, …} ]}` | User object(s) → `users` table. First one becomes active user if list empty. | SOLID (74993) |
| `o` | ← | `{t:"o", o:[callsign,…]}` | Full online-callsign list. | SOLID (75005) |
| `uc` | ← | `{t:"uc", c:callsign}` | User connected → add to online list. | SOLID (75007) |
| `ud` | ← | `{t:"ud", c:callsign}` | User disconnected → remove from online list. | SOLID (75008) |
| `ue` | ↔ | **out:** `{t:"ue", c:callsign}` · **in:** `{t:"ue", tc, r, n, ls}` | User enquiry / reply. `r`=found?; `n`=name; `ls`=lastSeen. | SOLID (out 75425; in 75053) |
| `he` | ↔ | **out:** `{t:"he", h:[callsign,…]}` · **in:** `{t:"he", h:[ {c, n, ts} ]}` | "Ham" name enquiry / reply → `hams` table (`c`→`{n,ts}`). Auto-fired when an avatar arrives for an unknown callsign. | SOLID (out 80867/74954; in 74903) |
| `s` | ← | `{t:"s", s:{…}}` | Stats blob → app `stats` state. | SOLID (75127) |
| `p` | ↔ | **out:** `{t:"p", fc:callsign}` · **in:** `{t:"p", …}` | **Pairing** request / reply. NEW — absent from prior doc's catalogue. Out at 106046; in handled at 75049 via `setParingRequestResponse`. | SOLID |

### 3.3 Direct messages (1:1) — local `sid = [fc,tc].sort().join("|")`, `_id = "${ms}-${fc}"` (ms = epoch-ms)

| `t` | Dir | Fields | Meaning | Status |
|---|---|---|---|---|
| `m` | ↔ | `{t:"m", fc, tc, m, ts, _id, r?}` | A DM. `fc`=from, `tc`=to, `m`=text, `ts`=epoch **seconds**, `_id`=`"${epochMs}-${fc}"`, optional `r`=reply-to. Inbound adds client-side `ms`(status)/`rs`(read)/`sid`. | SOLID (out 75308; in 75011) |
| `mb` | ← | `{t:"mb", md:{mc, mt}, m:[ msg… ]}` | DM backfill batch. `md.mc`=downloaded count, `md.mt`=total. "Downloaded X of Y new messages". | SOLID (75085) |
| `med` | ↔ | `{t:"med", _id, m, edts}` | DM edit. `edts`=edit timestamp (epoch-ms). | SOLID (out 71366; in 75030) |
| `medb` | ← | `{t:"medb", med:[ {_id, m, edts} ]}` | DM edit batch. | SOLID (75112) |
| `mr` | ← | `{t:"mr", _id}` | DM delivery receipt → set `ms:1`. | SOLID (75046) |
| `mem` | ↔ | `{t:"mem", a, _id, e, ets}` | DM emoji react. `a`=1 add / 0 remove; `e`=emoji unified codepoint; `ets`=ts. | SOLID (out 71281; in 75082) |
| `memb` | ← | `{t:"memb", mem:[ {a,_id,e,ets} ]}` | DM emoji batch. | SOLID (75108) |

### 3.4 Channels & posts — post natural key is `ts` (epoch-ms here); local `_id = "${ts}-${fc}"`

| `t` | Dir | Fields | Meaning | Status |
|---|---|---|---|---|
| `pch` | ← | `{t:"pch", ch:[ channelHeader… ]}` | Channel header / list → `pausedChannelHeaders`. (Each header has `cid`, `cn` channel-name, …) | SOLID (74979) |
| `cs` | ↔ | **subscribe:** `{t:"cs", s:1, cid, lcp}` · **unsub:** `{t:"cs", s:0, cid}` · **reply:** `{t:"cs", s, cid, pc}` | Channel subscribe / unsubscribe + response. `lcp`=last-channel-post ts cursor; reply `pc`=available post count. | SOLID (sub 81110; unsub 81343; reply 74971) |
| `cp` | ↔ | `{t:"cp", cid, fc, p, ts, rts?, rfc?, at?}` | A channel post. `p`=text, `ts`=epoch-ms, `rts`/`rfc`=reply-to ts/callsign, `at`=array of @-mentioned callsigns. Inbound adds `_id`,`ps`,`rs`. | SOLID (out 80908; in 74740) |
| `cpb` | ↔ | **out (request):** `{t:"cpb", cid, pc}` · **in (batch):** `{t:"cpb", cid, m:{pc,pt}, p:[ post… ]}` | Channel-post backfill. Request asks for `pc` posts; batch delivers them. "Downloaded X of Y new posts in #…". | SOLID (out 81142; in 74850) |
| `cped` | ↔ | `{t:"cped", cid, ts, p, edts, fc?, rts?, rfc?}` | Channel-post edit. | SOLID (out 81457; in 74762) |
| `cpedb` | ← | `{t:"cpedb", cid, ed:[ {ts, p, edts} ]}` | Channel-post edit batch. | SOLID (74940) |
| `cpr` | ← | `{t:"cpr", ts, dts?}` | Channel-post delivery receipt → set `ps:1` (+`dts`). | SOLID (74779) |
| `cpem` | ↔ | `{t:"cpem", a, ts, cid, e, fc?}` | Channel-post emoji. `a`=1 add / 0 remove; `e`=emoji; `fc`(inbound)=reactor. | SOLID (out 81354; in 74797) |
| `cpemb` | ← | `{t:"cpemb", cid, e:[ {ts, e, ets} ]}` | Channel-post emoji batch. | SOLID (74928) |
| `cu` | → | `{t:"cu", cid, lts?}` *(re-open / catch-up)* or `{t:"cu", cid, pc?}` | **Channel "unpause" / catch-up** request: re-request posts for a previously-paused channel. `lts`=last-known ts (gap-fill from there) OR `pc`=count. **CORRECTION:** prior doc guessed "create/unsubscribe"; it is unpause/catch-up. | SOLID (81156) |

### 3.5 WhatsPic (avatars / small images)

| `t` | Dir | Fields | Meaning | Status |
|---|---|---|---|---|
| `a` | ↔ | **out (upload):** `{t:"a", a:base64jpeg}` · **in (push):** `{t:"a", c, a, ts}` · **in (count):** `{t:"a", ac:N}` | WhatsPic avatar. `c`=callsign, `a`=the image (base64 of a 40×40 JPEG), `ts`=ts. The `{ac:N}` form reports how many avatar updates are pending. Inbound `a` updates `hams.a/ats` and, for an unknown callsign, auto-fires a `he` name enquiry. | SOLID (out 104008; in 74927) |
| `ae` | → | `{t:"ae", lats, co?}` | Avatar/WhatsPic **enquiry**: "give me avatars newer than `lats`". `co:1` = check-only/count mode. Sent on connect and on the first keepalive tick. | SOLID (38395, 104019) |
| `ar` | ← | `{t:"ar", …}` | Avatar response / upload-ack (client just clears the uploading flag). | SOLID (74968) |

**Image pipeline (SOLID, `index.pretty.js:103962-104004`):**
```js
eye.imageFileResizer(file, 40, 40, "JPEG", 100, 0, cb, "base64");
// -> 40x40 px, JPEG, quality 100, base64 string
// then:  { t:"a", a:<that base64> }  ->  ma()  ->  Ã base64(deflate(JSON)) Ã \r
```
**No application-level chunking.** A 40×40 JPEG is a few hundred bytes; the whole
avatar rides in a single frame. The only "chunk" in the bundle is pako's
internal `chunkSize: 16384` buffer (line 36812), unrelated to messaging.
**CORRECTION/RESOLUTION:** the prior doc's "chunking of larger images: verify" —
there is **no large-image path and no chunking**; images are constrained to
40×40 at source.

---

## 4. Inbound dispatch summary

Confirmed inbound `t` arms (from `switch (ee.t)` at 74738): `cp, cped, cpr,
cpem, cpb, cpemb, cpedb, he, a, ar, cs, pch, c, u, o, uc, ud, m, med, mr, p,
ue, mem, mb, memb, medb, s`. A frame whose `t` matches none of these is
ignored; a frame that fails to JSON-parse triggers `serviceDisconnect(CORRUPT_DATA_RECEIVED)`.

Confirmed outbound `t` builders: `c, k, m, med, mem, cp, cped, cpem, cs, cu,
cpb, he, ae, ue, p, a`.

---

## 5. Connect handshake — the EXACT connect object (SOLID)

`index.pretty.js:74283-74302` (inside the connect handler, after the
connect-script's final hop matches):

```js
const Ce = {
  t: "c",
  n: l.ham.name,                       // user's display name
  c: A,                                // A = whatsPacCallsign (from context)
  lm:  pe  === void 0 ? 0 : pe.ts,     // last DM ts            (messages.orderBy("ts").last())
  le:  ne  === void 0 ? 0 : ne.ets,    // last DM-emoji ts      (messages.orderBy("ets").last())
  led: me  === void 0 ? 0 : me.edts,   // last DM-edit ts       (messages.orderBy("edts").last())
  lhts: (Se && Se.ts) || 0,            // last ham(name) ts     (hams.orderBy("ts").last())
  v: Fs.whatsPacVersion,               // client version  ->  0.92
};
if (se.length > 0) Ce.cc = se;         // per-channel delta cursors (see below)
// guards: if lm>0 but le==0 / led==0, backfill le/led from the OLDEST message ts.
```

Per-channel cursor array `cc` (`index.pretty.js:74270-74282`), one entry per
subscribed channel:

```js
se.push({
  cid: fe.channelId,
  lp:  De,        // last post ts in this channel     (posts where cid==…, .orderBy("ts").last().ts)
  le:  et,        // last post-emoji ts (ets)          (.orderBy("ets").last().ets, fallback to first post ts)
  led: He,        // last post-edit ts (edts)          (.orderBy("edts").last().edts, fallback to first post ts)
});
```

So the **whole connect object** is:

```jsonc
{
  "t": "c",
  "n": "<display name>",
  "c": "<whatsPac callsign>",
  "lm":  <last DM ts | 0>,
  "le":  <last DM-emoji ts | 0>,
  "led": <last DM-edit ts | 0>,
  "lhts": <last ham-name ts | 0>,
  "v": 0.92,
  "cc": [ { "cid": "<channelId>", "lp": <ts>, "le": <ts>, "led": <ts> }, ... ]   // omitted if no subscriptions
}
```

**Handshake sequence (SOLID shape):**
1. RHP `open` to the FIRST connect-script hop (L2 `fT` or L4 `XW`); `remote` =
   `connectSequence[0].cmd`.
2. Run the connect-script (§6): for each hop, send `cmd`, wait until the RX text
   contains `val`, advance. On the last hop, UI shows
   *"Connected to WPS in Ns, now sending your connect details …"*.
3. Send the `{t:"c", …}` object above.
4. Server replies `{t:"c", w, mc, pc, v}` →
   *"Welcome to WhatsPac NAME! You have MC messages"* (new, `w==1`) or
   *"Welcome back NAME, you have MC new messages and PC new posts"*.
5. Server streams backfill using the cursors: `mb` (DMs), `cpb`/post arms per
   channel, `u`/`o` (users/presence), `he` (names), `a`/`ar` (avatars), `s`.
6. Steady state: `uc`/`ud`, `m`/`cp`, edits/receipts/emoji; client emits the
   keepalive (§7).

**Version negotiation:** none in the connect handshake. The client merely sends
`v: 0.92`. Server's reply `v` is compared client-side (`Number(serverV) >
Number(clientV)` → "User needs to upgrade", line 74461) — an advisory nag, not a
protocol gate. A separate REST/version check exists at 104473
(`whatsPacVersion <= "0.69"` legacy branch).

---

## 6. Connect-script vs direct open (RESOLVED)

**The client never opens `MB7NPW-9` directly.** It always opens the **first hop**
and runs a user-editable connect-script of `[{id, hop, cmd, val}]` entries.

Default script (`gle`, `index.pretty.js:34668-34679`):
```js
[
  { id:1, hop:"G4OTJ's node GB7NBH", cmd:"GB7NBH",     val:"GB7NBH BPQ Packet Node" },
  { id:2, hop:"WhatsPac Server",      cmd:"C MB7NPW-9", val:"*** Connected" },
]
```
- `cmd` = text to TX at that hop. The first hop's `cmd` is the RHP `open`
  `remote`. Subsequent hops' `cmd` strings are sent as line frames
  (`data = cmd + "\r"`, see `H()` at 74130).
- `val` = substring to watch for in RX before advancing.
- **Last-hop validation** (74154-74182): the last `cmd`'s final token (after
  stripping a trailing `!`) must be one of `["WPS","WPSDEV","MB7NPW-9","WTSPAC"]`,
  and the last `val` must begin with `"*** Connected"`. So the *callsign the
  client expects to reach* is one of those four; `MB7NPW-9` is the production one.
- L4 mode (`configurationMode=="xrouterManual"` && `ax25ConnectionLevel=="L4"`)
  uses the `XW` netrom open with `local = "<callsign>@<nodeCall>"`.

**Implication for pdn-whatspac-client:** to reach WPS it should (a) `open` to the
configured first hop, then (b) replay the connect-script `cmd`/`val` dialogue —
*or* it can short-circuit to a direct `open(MB7NPW-9)` *if the live WPS accepts
that*, which the client code can neither confirm nor deny (it never tries). See §9.

---

## 7. Keepalive / idle timer (SOLID)

`index.pretty.js:38329-38404`. Config default `keepAliveIntervalMinutes: 9`
(`index.pretty.js:34687`).

- Timer period: `ae * 60 s`, where `ae = keepAliveIntervalMinutes || 9` → **9 minutes**.
- A running counter `G` increments by `ae` each tick. Behaviour by tick:
  - **first tick (`G == ae`, i.e. 9 min):** runs a **WhatsPic enquiry**
    `{t:"ae", lats:<last avatar ts|0>, co:1}` — NOT a `{t:"k"}`.
  - **subsequent ticks:** sends `{t:"k"}`.
  - **`G >= 240` (i.e. 240 minutes ≈ 4 hours idle):** sends RHP `close` and
    disconnects with reason "Application Timeout".
- The counter is RESET to 0 on any outbound send (`Se()` at 38404 calls
  `ne("RESET")`), so the keepalive only fires after genuine idleness.

**CORRECTION/REFINEMENT vs prior doc:** interval 9 min is correct; but (a) the
first idle action is an avatar-enquiry, not `k`; (b) there is a hard 4-hour idle
cap after which the client self-disconnects.

---

## 8. Local store schema (Dexie / IndexedDB) — SOLID

`index.pretty.js:34799-34815`, database name **`WhatsPac`**, **version 19**:

```js
db.version(19).stores({
  users:    "tc, ls",
  messages: "_id, sid, ts, [sid+ts], fc, tc, rs, ets, edts",
  posts:    "_id, cid, ps, ts, rs, ets, edts, [cid+ts]",
  hams:     "c, ts, ats",
  connections: "id",
  config:   "wpc",
});
// v19 upgrade: recompute messages.sid = [fc,tc].sort().join("|")
```

Key paths / indices (first token is the primary key):
- **`users`** — pk `tc` (the other party's callsign); index `ls` (lastSeen).
  Fields seen: `tc, n, ls, us`(status:0 unknown/1 not-found/2 found), `new`.
- **`messages`** (DMs) — pk `_id` (`"${epochMs}-${fc}"`); indices `sid`, `ts`,
  `[sid+ts]`, `fc`, `tc`, `rs`, `ets`, `edts`. Fields: `fc, tc, m, ts, _id,
  sid, ms`(send status), `rs`(read status; `-1` from backfill), `e`(emoji
  array), `ets, ed, edts, r`(reply-to).
- **`posts`** — pk `_id` (`"${ts}-${fc}"`); indices `cid`, `ps`(post status),
  `ts`, `rs`, `ets`, `edts`, `[cid+ts]`. Fields: `cid, fc, p, ts, _id, ps, rs,
  e`(emoji `[{e,c:[callsign]}]`), `ets, ped, ed, edts, lts, gap, rts, rfc, at`.
- **`hams`** — pk `c` (callsign); indices `ts`(name ts), `ats`(avatar ts).
  Fields: `c, n, ts, a`(avatar base64), `ats`.
- **`connections`** — pk `id`.
- **`config`** — pk `wpc`. Holds e.g. `subscribedChannels` (`{value:[{channelId}]}`),
  `persistedLastUsedChannel`, and the `whatsPacConfig` blob (ham, whatsPac
  settings incl. `keepAliveIntervalMinutes`, connection profiles, connectSequence).

**For pdn-whatspac-client's SQLite mirror:** these six tables + the listed
columns are the full persisted surface.

---

## 9. STILL UNKNOWN — needs on-air capture

These cannot be settled from the client bundle alone (the client only sends/parses;
the *server's* exact reply shapes for some types are inferred from the parser, not a schema):

1. **Server reply field-completeness.** We know which keys the client *reads*
   per type, but the server may include extra keys the client ignores. Capture
   real `c`, `u`, `o`, `s`, `mb`, `cpb`, `pch`, `ar`, `p` frames to enumerate
   *all* server-sent keys (esp. the `s` stats blob shape and the `pch` channel-
   header object: confirmed keys `cid`, `cn`; others unknown).
2. **Direct `open(MB7NPW-9)` acceptance.** The client always runs the connect-
   script; whether the live WPS will accept a direct L2 open (skipping the
   node-console dialogue) is a server behaviour, untestable from the client.
   (§6.)
3. **Pairing (`p`) reply shape.** Outbound is `{t:"p", fc}`; the inbound reply
   object's fields (success/failure, paired-callsign, token?) are only stored
   via `setParingRequestResponse` and rendered — capture one to pin the schema.
4. **`cu` exact server contract.** We know the two outbound forms
   (`{cid,lts}` and `{cid,pc}`); the server's response to a `cu` (does it reply
   with `cpb`, or a stream of `cp`?) needs a capture.
5. **Backfill ordering / pacing under the cursors** — confirm the server honours
   `lm/le/led/lhts/cc` exactly and the order in which it streams `mb`/`cpb`/etc.
6. **Latin-1 framing round-trip** — confirm (it will) that a raw-byte client sees
   a clean single-0xC3 marker and clean base64, with frames cleanly `\r`-split,
   i.e. none of the browser's UTF-8 high-byte mangling. (Low risk; mechanical.)
7. **No hardcoded test vectors exist in the bundle** — there are zero embedded
   `Ã…Ã` sample frames or long base64 blobs, so golden round-trip fixtures must
   be synthesized (see `fixtures/`) and then validated against a real capture.

# pdn platform integration contracts — for `pdn-whatspac-client`

Extracted from the pdn (packet.net) platform design docs + the `RhpV2.Client` 0.3.0 assembly,
2026-06-13. The new app is **out-of-process** and consumes pdn only through these public seams.
DAPPS is a reference consumer of the same seams, not a template.

These four sections are independently buildable. Where a feature is *planned vs shipped* it's
flagged. Genuinely ambiguous points are called out as **QUESTION** rather than guessed.

Source docs (read for full prose): `/home/tf/packet.net/docs/{app-extensibility,app-local-session-wire,app-gateway,app-packages}.md`.
RHP client assembly: `/home/tf/.nuget/packages/rhpv2.client/0.3.0/lib/net10.0/RhpV2.Client.dll` (also net8.0).

The app touches two/three seams:
- **Network plane (RHPv2):** the WhatsPac *client* opens an outbound AX.25 connected-mode session to `MB7NPW-9` through the node. → §4.
- **Local-session plane (`pdn-app/1`):** the node hands you a connected user's terminal session when they type `C WHATSPAC` (or the configured verb) at the node prompt. → §1.
- **Human plane (app-gateway):** optional web UI surfaced under `/apps/{id}/`. → §2.
- Packaging/lifecycle (`pdn-app.yaml`) ties them together. → §3.

---

## 1. `pdn-app/1` local-session wire  (SHIPPED — slices 1 & 2)

How the RF-terminal head is reached. A connected user types the app's `match` verb (e.g.
`WHATSPAC`) at the node prompt; pdn attaches their session to your process. You read lines, you
write lines — you need to know nothing about AX.25/NET-ROM/telnet framing or line endings.

Two transports, **identical wire**:
- `kind: process` (the floor, slice 1) — pdn **spawns your `command` per connect**, session piped
  over the child's **stdin/stdout/stderr**. No shared state across users (fresh process each time).
- `kind: socket` (slice 2) — your app is a **long-running daemon** listening on a **Unix-domain
  socket**; pdn **connects to that socket per connect** and bridges the session over it. You hold
  shared in-memory state across users and can push unsolicited output. You are the server, pdn is
  the client; pdn does *not* manage the daemon's lifecycle in the inline-config model (but see §3 —
  with a package `service:` block + `managed: pdn`, pdn supervises it).

### Framing

1. **Connect header**, written by pdn to your stdin (or into the accepted socket connection) before
   any session traffic: a sequence of `Key: Value` lines, **UTF-8, each terminated by a single
   `\n`**, ended by **one blank line** (`\n`). Read lines until the blank line.

   ```
   pdn-app: 1
   id: whatspac
   callsign: M0LTE-7
   transport: ax25
   port: gb7rdg
   sysop: 0
   args: last 5

   ```

   | Key | Meaning |
   |---|---|
   | `pdn-app` | Wire version, always first line. `1` today. |
   | `id` | The registered application id launched. |
   | `callsign` | Connecting station — AX.25 callsign w/ SSID for radio; remote endpoint string for telnet. Canonicalised; treat as opaque text. |
   | `transport` | `ax25` \| `netrom` \| `telnet`. |
   | `port` | Arrival port id when known; `-` or absent for telnet/network-arrived. |
   | `sysop` | `1` if sysop-elevated, else `0`. **Reserved; always `0` in v1.** |
   | `args` | Tokens typed after the `match` verb, space-joined. May be empty. |

   **MUST ignore unrecognised header keys** (forward-compat: new keys get added).

2. **Session traffic** (after the blank line), line-oriented UTF-8:
   - **pdn → app:** each user input line as UTF-8 terminated by a **single `\n`**. pdn has already
     stripped the transport's CR/CR-LF. One user line = one `\n`-terminated read.
   - **app → pdn:** write UTF-8 with **`\n` only**. pdn translates each `\n` to the transport's
     newline (bare `CR` for ax25/netrom, `CR-LF` for telnet). **Never emit `\r` yourself.**
   - **stderr** (process kind): captured to node log, never shown to user. Log freely.
   - **Flush after every prompt/reply** — pipes are not line-buffered; a block-buffered app appears
     to hang.

### Lifecycle / teardown

- **User disconnects:** pdn closes your stdin → you see **EOF on stdin** (process kind) / your
  `recv` returns empty (socket kind). **Treat EOF as "user gone — exit / drop them."** pdn waits a
  short grace then kills the process tree (process kind).
- **App exits first:** pdn returns the user to the node prompt (exit code ignored in v1).
- **App fails to start:** pdn tells the user "unavailable" and returns them to the prompt. The node
  never crashes on a misconfigured app.

### What pdn does / does NOT guarantee (v1)

Guarantees: one duplex UTF-8 line stream per connect, newline translation, stderr capture, teardown
on disconnect. Does **not**: sandbox the child; pass node secrets (minimal inherited env); deliver
**raw bytes** (the wire is text/line-oriented — there is no binary-clean path on this seam); expose
a web UI (that's §2).

**Implication for WhatsPac:** the RF-terminal head is a **line-oriented text UI**. If WhatsPac needs
binary-clean transport to/from the user's terminal it does not get it here — that lives on the
network plane (§4, RHP, which is binary-clean via Latin-1 wire strings). The `pdn-app/1` head is for
a human typing at a prompt.

### Minimal sketch (process kind, any language)

```
read header lines until blank line; parse Key: Value; remember callsign/args
print greeting; flush
loop:
    line = readline(stdin)        # UTF-8, \n-terminated
    if EOF: break                 # user gone
    handle(line)
    print(reply, end="\n"); flush # \n only — pdn adds the CR
```

Socket kind: same per accepted connection, but you `bind`+`listen`+`accept` a Unix socket, handle
each accepted connection concurrently (one accepted conn = one user), guard shared state with a
lock, and reap an entry when its `recv` returns empty.

---

## 2. app-gateway — human plane (reverse-proxied web UI)  (SHIPPED — slice 3)

How your app exposes a web UI *through* pdn. The node is a manifest reader + reverse proxy + auth
gateway; it imports none of your code. Optional for WhatsPac (an app may be packet-plane-only).

### The deal

1. Your app runs **its own web server bound loopback-only** (`127.0.0.1:<port>`) — any stack.
   **MUST bind loopback only** — that loopback boundary is what makes the injected identity headers
   trustworthy (see Trust).
2. A `ui:` block in the manifest points pdn at that upstream (+ a tile name/icon).
3. pdn renders an **Apps launcher** tile and **reverse-proxies `/apps/{id}/*`** (YARP
   `IHttpForwarder`) to your upstream.
4. pdn is the **auth gateway**: only an authenticated panel user with ≥ `read` scope reaches
   `/apps/{id}/*`; pdn injects the identity as headers.

### What arrives on each proxied request

For `GET|POST|… /apps/{id}/<path>?<query>`:

- **Auth gate.** With node auth on: request must carry a valid panel session (the `pdn_at` cookie or
  a bearer token) with ≥ `read` scope, else 401 / redirect to login. Auth off → passes, identity
  anonymous.
- **Path rebase.** The `/apps/{id}` prefix is **stripped** before your app sees it — your app is
  mounted at **its own root**. But the browser sees it under `/apps/{id}/`, so:
  - **Use relative URLs only** for assets/links (`./style.css`, `<form action="post">`), or emit
    `<base href="./">`. Absolute-rooted (`/style.css`) breaks.
  - **Server-rendered absolute URLs** (links, form actions, redirect `Location`s) **MUST be prefixed
    with `X-Forwarded-Prefix`** (see below). Treat absent as empty (so direct loopback access still
    works).
- **Injected identity headers** — pdn **strips any client-supplied copy first**, then sets:

  | Header | Value |
  |---|---|
  | `X-Pdn-User` | viewer's callsign / username. Empty when anonymous / auth-off. |
  | `X-Pdn-Scope` | `read` \| `operate` \| `admin`. Empty when anonymous. |
  | `X-Pdn-Gateway` | `1` — marks the request as gateway-originated. |
  | `X-Forwarded-Prefix` | the public mount point, `/apps/{id}`. Prefix your server-rendered absolute URLs with this. |

  Read these to know who is viewing. **v1 does NOT cryptographically sign them** — trust rests on
  the loopback boundary (planned hardening: per-app signing secret, not in v1).
- **Forward.** Method, headers (minus hop-by-hop), query, request/response bodies streamed unchanged.
  **WebSockets supported** (forwarder handles the upgrade); SSE / chunked / long-poll stream fine.

### Trust

App web server **MUST bind `127.0.0.1` only**. Headers are trustworthy because (a) pdn strips
client copies before injecting, and (b) only pdn can reach a loopback upstream. Bind a routable
interface and anyone can hit you directly and forge `X-Pdn-User`.

### Cookie note

The `pdn_at` gateway cookie carries the access token, refreshed when the panel session renews; if it
lapses mid-use the user re-opens the app from the launcher.

### Minimal sketch

```
serve on 127.0.0.1:9090
on each request:
    prefix = header["X-Forwarded-Prefix"] or ""   # e.g. /apps/whatspac
    user   = header["X-Pdn-User"]                  # who is viewing (trusted)
    scope  = header["X-Pdn-Scope"]                 # read|operate|admin
    render with relative asset URLs (or <base href="./">)
    any absolute link / form action / redirect Location => prefix + "/..."
```

---

## 3. `pdn-app.yaml` package manifest + lifecycle  (design locked 2026-06-11; supervisor BUILT)

The packaging/distribution/lifecycle layer. An **app package** is a directory containing a
`pdn-app.yaml` **authored by the app** (not the node owner). pdn discovers packages, the owner
enables them (the trust grant), and — when a `service:` block is present with `managed: pdn` — pdn
**supervises the daemon**.

### Discovery (scanned at startup + every config apply/reload)

In order, **later roots win on id collision**:
1. `/usr/share/packetnet/apps/<id>/pdn-app.yaml` — distro-installed (a `.deb` drops a dir here;
   pdn's own deb ships bundled apps this way).
2. `/var/lib/packetnet/apps/<id>/pdn-app.yaml` — owner-installed (hand-unpacked, or later UI upload).

The **directory name MUST equal manifest `id`** (validated). Roots overridable for dev/tests via
top-level `appPackageRoots:` config (replaces defaults entirely when set). Per-app state lives in
`/var/lib/packetnet/apps/<id>/` (auto-created, `packetnet`-owned, `0750`).

**Discovered ≠ enabled** — a discovered package is **off until the owner enables it**.

### Manifest schema

```yaml
manifest: 1                  # schema version, REQUIRED
id: whatspac                 # REQUIRED; must equal dir name; charset [a-z0-9-]
name: WhatsPac               # human label (default: id)
version: "1.0.0"             # informational, shown in UI
description: WhatsPac client for MB7NPW-9.
icon: message-circle         # lucide icon name, cosmetic
capabilities: [session, network, web]  # declared, shown to owner at enable (NOT enforced in v1)

session:                     # OPTIONAL — packet-plane console attachment (the pdn-app/1 wire, §1)
  match: WHATSPAC            # console verb (owner may override)
  kind: process              # process | socket
  command: /usr/bin/python3  # kind: process only — absolute, or relative to package dir
  args: [whatspac.py]        # relative paths resolve against package dir
  socketPath: /run/packetnet/whatspac.sock   # kind: socket only

service:                     # OPTIONAL — a long-running daemon pdn supervises
  command: /usr/bin/dotnet   # absolute, or relative to package dir
  args: [WhatsPac.dll]
  environment:               # map; merged UNDER the owner's override map
    EXAMPLE_FLAG: "1"
  workingDirectory: null     # default: state dir /var/lib/packetnet/apps/<id>
  restart: on-failure        # on-failure (default) | always | never
  managed: pdn               # pdn (default) | external

ui:                          # OPTIONAL — human plane (the §2 app-gateway contract)
  upstream: http://127.0.0.1:9090
  name: WhatsPac
  icon: message-circle
```

**At least one of `session` / `service` / `ui` must be present.** Shapes by example:
- WALL: `session`(process) + `service`(web view) + `ui`.
- LOBBY: `session`(socket) + `service`(the daemon pdn keeps alive).
- DAPPS: `service`(dotnet daemon, env selects RHP bearer) + `ui` + `capabilities: [network, web]`,
  **no `session`** — it binds its own callsigns over RHP. **This is the closest shape to a WhatsPac
  client that talks RHP outbound** — except WhatsPac likely *also* wants a `session` head for
  `C WHATSPAC`.

**Path resolution:** a relative `command`/`args` element naming an existing file in the package dir
resolves to it; everything else passes through untouched. `workingDirectory` defaults to state dir.

### Environment injected into a supervised `service` (last wins)

node's own env → then these injected vars → then manifest `environment` map → then owner override map:

| Var | Meaning |
|---|---|
| `PDN_APP_ID` | the app id |
| `PDN_APP_DIR` | the package dir |
| `PDN_APP_STATE` | the state dir (`/var/lib/packetnet/apps/<id>/`) |
| `PDN_NODE_CALLSIGN` | the node's own callsign (derive your identity per "app lives at an SSID of the node callsign") |
| `PDN_NODE_ALIAS` | the node alias, when set |
| `PDN_RHP_HOST` | RHP server host — **only when the RHP server is enabled** |
| `PDN_RHP_PORT` | RHP server port — **only when the RHP server is enabled** |

`PDN_RHP_HOST`/`PDN_RHP_PORT` are a **convenience, not a grant** — a `network`-capable app reaches
RHP exactly like any local process (loopback TCP). **A WhatsPac service should read `PDN_RHP_HOST`/
`PDN_RHP_PORT` for the §4 client, falling back to `127.0.0.1:9000`.**

### Owner state — `packetnet.yaml` (the whole owner surface)

```yaml
apps:
  - id: whatspac
    enabled: true
    environment:             # merged OVER the manifest's service environment
      WHATSPAC_REMOTE: MB7NPW-9
    match: null              # optional session-verb override
```

Discovered packages default disabled; `apps:` entries flip them on + carry small overrides. An
`apps:` id matching no discovered package = validation **warning** (may install later). Legacy inline
`applications:` list still works (owner-authored → defaults `enabled: true`); an id collision between
inline + discovered package = validation **error**. Verb-collision rules span the union. Built-in
console verbs always win — the validator rejects a `match` colliding with a built-in (`BYE`,
`CONNECT`, etc.).

### Lifecycle — the supervisor (`managed: pdn`, default)

For every **enabled** package with a `service` block + `managed: pdn`:
- **Start** on enable / node start / config apply. Runs as the node's user, own process group,
  stdout+stderr captured to node log prefixed `app:<id>`.
- **Stop** on disable / shutdown: SIGTERM to process group → 5 s grace → SIGKILL tree.
- **Restart** per `restart` policy with **exponential backoff** (1 s doubling, capped 60 s).
  **Crash-loop breaker:** 5 failures inside 5 min → service `Faulted`, stays down until owner toggles
  or hits restart.
- **Reconcile** idempotent at startup / config apply / on demand. Manifest changes take effect next
  reconcile (rescan).
- `managed: external` = escape hatch: owner runs the daemon (systemd/container); pdn never starts/
  stops it, but the toggle still gates the verb + tile; UI shows `External`.

`session:` + `ui:` follow the enable toggle exactly (disabled → verb falls through to "unknown
command", tile disappears).

### Admin/launcher surfaces

- `GET /api/v1/apps` — launcher tiles for enabled apps with a `ui`.
- `GET /api/v1/apps/packages` — admin inventory: every discovered package + inline entry, each
  `{id, name, version, description, icon, capabilities, enabled, source: package|inline,
  service: none|managed|external, state: Stopped|Starting|Running|Backoff|Faulted|External, pid?,
  detail?}`. Read scope to view; **admin scope to mutate**.
- `POST /api/v1/apps/packages/{id}/enable` · `/disable` — admin; writes the `apps:` override.
- `POST /api/v1/apps/packages/{id}/restart` — admin; supervisor action / way out of `Faulted`.

### Security posture (v1)

Enabling = the trust grant; services run as `packetnet` user, no new privilege; `capabilities`
**displayed, not enforced** (enforcement is a later slice); manifests are read-only data (nothing
executes until enabled); state dir per-app `0750`; RHP is a loopback TCP surface.

---

## 4. `RhpV2.Client` NuGet API — network plane  (assembly 0.3.0; pdn RHP server R-1+R-2 BUILT)

The client the WhatsPac app uses to get a **transparent connected-mode AX.25 stream** to
`MB7NPW-9` through the node. pdn runs an **RHPv2 server** (`Packet.Rhp2.Server`) — JSON-over-TCP,
default **`127.0.0.1:9000`** — over its own AX.25 engine, so any app written against
`RhpV2.Client` runs against pdn (and XRouter) unchanged.

- **Package id:** `RhpV2.Client` (lowercase `rhpv2.client` on disk). Multi-targets **net10.0 +
  net8.0**. Repo `github.com/M0LTE/rhp2lib-net`, docs `https://rhp2lib.pages.dev/`. MIT.
- **Namespaces:** `RhpV2.Client` (the client + event args) and `RhpV2.Client.Protocol` (message
  records, enums, `RhpDataEncoding`).
- **No DI/options type** — the client is constructed via a static factory; host/port are plain
  args. There is no `IServiceCollection` extension and no options record in the assembly.

### The one type you drive: `RhpV2.Client.RhpClient` (`IAsyncDisposable`, `IDisposable`)

```csharp
public const int DefaultPort = 9000;                 // field RhpClient.DefaultPort
public int? MaxSendDataLength { get; set; }          // caps a single SendOnHandle payload (server-advertised)
public bool IsConnected { get; }

// --- construction / connect ---
static Task<RhpClient> ConnectAsync(string host, int port = 9000, CancellationToken ct = default);
static RhpClient FromStream(Stream stream, bool ownsStream = false);   // e.g. test harness / mock

// --- auth (only if the node requires it) ---
Task AuthenticateAsync(string user, string pass, CancellationToken ct = default);

// --- OPEN an outbound connected session (one-shot: socket+bind+connect) ---
Task<int> OpenAsync(
    string family,                 // ProtocolFamily.Ax25
    string mode,                   // SocketMode.Stream
    string? port = null,           // bearer port LABEL (XRouter: 1-indexed string; null = node chooses)
    string? local = null,          // local callsign
    string? remote = null,         // remote callsign, e.g. "MB7NPW-9"
    OpenFlags flags = OpenFlags.Passive,   // pass OpenFlags.Active for an outbound connect
    CancellationToken ct = default);
// returns a HANDLE (int) identifying the session for send/recv/close.

// --- lower-level passive/listener path (not needed for an outbound client) ---
Task<int> SocketAsync(string family, string mode, CancellationToken ct = default);
Task BindAsync(int handle, string local, string? port = null, CancellationToken ct = default);  // port:null = "all ports"
Task ListenAsync(int handle, OpenFlags flags = OpenFlags.Passive, CancellationToken ct = default);
Task ConnectAsync(int handle, string remote, CancellationToken ct = default);   // instance overload (note: same name as the static)

// --- SEND bytes on a handle ---
Task<SendReplyMessage> SendOnHandleAsync(int handle, ReadOnlySpan<byte> data, CancellationToken ct = default);
Task<SendReplyMessage> SendOnHandleAsync(int handle, string data, CancellationToken ct = default);  // string = Latin-1 wire string
Task<SendToReplyMessage> SendToAsync(int handle, string data, string? port = null, string? local = null,
                                     string? remote = null, int? tos = null, CancellationToken ct = default); // datagram

// --- status / close ---
Task<StatusFlags> QueryStatusAsync(int handle, TimeSpan? responseTimeout = null, CancellationToken ct = default);
Task CloseAsync(int handle, CancellationToken ct = default);

// --- raw escape hatches ---
Task<TReply> RequestAsync(RhpMessage request, CancellationToken ct = default);  // correlated request/reply
Task SendAsync(RhpMessage message, CancellationToken ct = default);             // fire-and-forget

ValueTask DisposeAsync();
void Dispose();
```

### RECV is push-based via an event — NOT a Stream or a byte[] return

There is **no `ReadAsync`/`ReceiveAsync`**. Inbound data is delivered through events on `RhpClient`:

```csharp
event EventHandler<RhpReceivedEventArgs> Received;     // <- inbound data
event EventHandler<RhpAcceptedEventArgs> Accepted;     // passive: a peer connected (listener path)
event EventHandler<RhpStatusEventArgs>   StatusChanged;
event EventHandler<RhpClosedEventArgs>   Closed;       // a handle closed (peer or local)
event EventHandler<RhpUnknownEventArgs>  UnknownReceived;
event EventHandler<Exception>            Disconnected; // TCP transport dropped (payload IS the Exception)
```

Event-arg shapes (all in `RhpV2.Client`):
- `RhpReceivedEventArgs.Message` → `RhpV2.Client.Protocol.RecvMessage`. Key fields:
  `int Handle`, `string Data` (the **Latin-1 wire string** — one char per byte), plus monitor-mode
  metadata (`Srce`, `Dest`, `Ctrl`, `FrameType`, `Pid`, `Ptcl`, …) used only for TRACE/RAW sockets.
- `RhpClosedEventArgs.Handle` → `int`.
- `RhpAcceptedEventArgs.Message` → `AcceptMessage` (`Handle`, `Child` = new session handle,
  `Remote`, `Local`, `Port`).
- `RhpUnknownEventArgs.Message` → `RhpMessage` base.

**Decoding recv bytes — confirmed shape.** The wire `Data` string is **Latin-1 (ISO-8859-1), one
byte per code unit** (not base64). Convert it to `byte[]` with the library helper
`RhpV2.Client.Protocol.RhpDataEncoding`:

```csharp
public static class RhpDataEncoding {
    public static string ToWireString(ReadOnlySpan<byte> bytes);  // == Encoding.Latin1.GetString(bytes)
    public static byte[] FromWireString(string s);               // == Encoding.Latin1.GetBytes(s)
}
```

So: a `Received` handler does `byte[] payload = RhpDataEncoding.FromWireString(e.Message.Data);` and
filters by `e.Message.Handle == myHandle`. To send raw bytes prefer the `ReadOnlySpan<byte>` overload
of `SendOnHandleAsync` (it encodes for you); the `string` overload treats the string as an
already-Latin-1 wire string.

`SendReplyMessage` (returned by send) carries `int ErrCode` (0 = ok), `string ErrText`,
`int? Status` (e.g. BUSY flag on large writes). **Check `ErrCode != 0` and throw/handle** — the
pdn-bbs consumer does exactly this.

### Supporting types (`RhpV2.Client.Protocol`)

- `ProtocolFamily` — **static-string holder** (NOT an enum): `Ax25` ("ax25"), `NetRom`, `Inet`, `Unix`.
  Pass `ProtocolFamily.Ax25` as the `family` string.
- `SocketMode` — static strings: `Stream`, `Dgram`, `Seqpkt`, `Custom`, `SemiRaw`, `Trace`, `Raw`.
  Use `SocketMode.Stream` for connected-mode AX.25.
- `OpenFlags` — **`[Flags]` enum**: `Passive = 0`, `TraceIncoming = 1`, `TraceOutgoing = 2`,
  `TraceSupervisory = 4`, `Active = 128`. **Outbound connect = `OpenFlags.Active`.**
- `StatusFlags` enum: `None=0, ConOk=1, Connected=2, Busy=4`.
- `RhpErrorCode` — static int fields + `Text(int)` / `IsTransient(int)` helpers: `Ok=0`,
  `Unauthorised`, `NoRoute`, `NoSuchPort`, `InvalidRemoteAddress`, `NotConnected`, … (full set in the
  assembly). Compare `SendReplyMessage.ErrCode` against these.

### Port-label convention (XRouter vs pdn)

The `port` argument is a **string label the server resolves to a bearer**, not an index. XRouter's
convention is 1-indexed (`port="1"` → PORT=1 in XROUTER.CFG); DAPPS converts its 0-indexed
bearer byte by `+1`. **For pdn specifically the exact port-label semantics are not stated in the
docs I read** → **QUESTION**: does pdn's RHP server map `port` to a pdn port *id* (e.g. `gb7rdg`)
or to a 1-indexed number like XRouter? Passing `port: null` ("let the node choose") sidesteps this
and is the safe default (pdn-bbs uses `null` for "all ports" on bind; DAPPS uses an explicit
numeric label for XRouter). Recommend `null` unless WhatsPac must pin a specific bearer.

### Minimal usage sketch (outbound connected-mode AX.25 to MB7NPW-9)

```csharp
using RhpV2.Client;
using RhpV2.Client.Protocol;

var host = Environment.GetEnvironmentVariable("PDN_RHP_HOST") ?? "127.0.0.1";
var port = int.TryParse(Environment.GetEnvironmentVariable("PDN_RHP_PORT"), out var p) ? p : 9000;

await using var rhp = await RhpClient.ConnectAsync(host, port, ct);
// await rhp.AuthenticateAsync(user, pass, ct);   // only if the node requires auth

var inbound = Channel.CreateUnbounded<byte[]>();
int myHandle = -1;
rhp.Received += (_, e) => { if (e.Message.Handle == myHandle)
    inbound.Writer.TryWrite(RhpDataEncoding.FromWireString(e.Message.Data)); };
rhp.Closed   += (_, e) => { if (e.Handle == myHandle) inbound.Writer.TryComplete(); };
rhp.Disconnected += (_, ex) => inbound.Writer.TryComplete(ex);

// OPEN (Active = outbound connect → SABM on the air)
myHandle = await rhp.OpenAsync(
    family: ProtocolFamily.Ax25,
    mode:   SocketMode.Stream,
    port:   null,                 // or a bearer label once pdn's convention is confirmed
    local:  myLocalCallsign,      // e.g. "M0LTE-7"
    remote: "MB7NPW-9",
    flags:  OpenFlags.Active,
    ct:     ct);

// SEND
var reply = await rhp.SendOnHandleAsync(myHandle, someBytes.AsSpan(), ct); // ReadOnlySpan<byte>
if (reply.ErrCode != 0) throw new IOException($"send failed: {reply.ErrCode} {reply.ErrText}");

// RECV: read decoded byte[] chunks off the channel the Received handler feeds
await foreach (var chunk in inbound.Reader.ReadAllAsync(ct)) { /* ... */ }

// CLOSE
await rhp.CloseAsync(myHandle, ct);   // also covered by `await using` dispose
```

Real consumers to mirror:
- `/home/tf/dapps/src/dapps/dapps.client/Transport/Rhp/Rhpv2OutboundTransport.cs` — the **outbound
  connect** pattern (fresh `RhpClient` per connect, `OpenAsync(..Active..)`, `Received`→`Stream`,
  `Closed`→disconnect; wraps the push events as a `Stream`).
- `/home/tf/pdn-bbs/src/Bbs.Host/Rhp/RhpNodeLink.cs` — the **passive listener** pattern
  (`SocketAsync`+`BindAsync(port:null = all ports)`+`ListenAsync(Passive)`, `Accepted`→child
  handles, resilient reconnect with backoff, `SendReplyMessage.ErrCode` checking). Useful as the
  template for a `Stream`-over-RHP adapter even though WhatsPac is outbound.

### Open questions / flags

- **QUESTION (port label):** pdn's `port` string semantics — port *id* vs 1-indexed number — not in
  the docs read. Default to `null`. (See above.)
- **`Packet.Rhp2.Server` status:** outbound host API (`open(Active)`/`send`/`recv`/`close`, auth
  against node users) is **R-1+R-2 BUILT**; the *passive* half (`socket`/`bind`/`listen`/`accept`)
  is **R-3 (not yet built)** per `app-extensibility.md`, and the XRouter conformance + DAPPS
  acceptance is R-4. **A WhatsPac *client* only needs the outbound half → it is on built ground.** A
  WhatsPac feature that *listens* for inbound connections would depend on the not-yet-shipped passive
  half — confirm before relying on it. (`pdn-bbs`'s listener code targets that R-3 surface.)
- **Auth:** whether pdn's RHP server requires `AuthenticateAsync` depends on node config (network
  apps authenticate with an owner-provisioned service credential per `app-extensibility.md`). Make
  user/pass optional + config-driven (DAPPS does: skips auth when user is empty).

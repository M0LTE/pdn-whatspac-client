# WPS codec fixtures

Golden fixtures for the WhatsPac Server (WPS) application protocol, synthesized
from the code-grounded reference in [`../wps-protocol.md`](../wps-protocol.md).
Each `*.json` is one representative message of a given `t` type.

> **No hardcoded sample frames exist in the SPA bundle** — there are zero
> embedded `Ã…Ã` blobs or long base64 literals to lift verbatim. These
> fixtures are *constructed* from the confirmed field shapes. The field
> **names, directions, and the framing/deflate variant are code-confirmed**;
> the field **values** are illustrative. Validate against a real on-air capture
> (design-doc Slice 0) before treating value-level details as canonical.

## Encoding (code-confirmed, see wps-protocol.md §2)

- `JSON.stringify(obj)` (compact, no spaces).
- `pako.deflate(json)` — **zlib-wrapped** (header `78 9c`, **level 6**,
  **window 15**, Adler-32 trailer). C# equivalent:
  **`System.IO.Compression.ZLibStream`** (NOT `DeflateStream`, which is raw).
- base64 of the deflate output.
- wrap with the marker **`Ã` (U+00C3 = byte 0x C3)** on **both** ends.
- **Uncompressed fallback:** if the wrapped form is not shorter than the raw
  JSON, the raw JSON string is sent instead (e.g. `k.json`).
- the **sender appends `\r` (0x0D)** as the frame terminator (both directions).
- the receiver splits inbound data on `\r`, then strips the `Ã…Ã` wrap (or
  parses bare JSON for the fallback).

## Fixture schema

```jsonc
{
  "name": "...",            // fixture id (== filename stem)
  "t": "...",               // the WPS message type
  "direction": "client->WPS" | "WPS->client",
  "note": "...",            // meaning / field semantics
  "decoded": { ... },       // the JSON object
  "wire": {
    "json": "...",                  // JSON.stringify(decoded)
    "deflate": "zlib-wrapped ...",  // variant
    "base64_deflate": "...",        // base64(zlib_deflate(json))  -- the cfe input
    "marker": "...",                // the Ã wrap
    "frame_terminator": "\\r",
    "encoding_mode": "compressed" | "uncompressed-fallback",
    "frame_string": "..."           // the EXACT on-wire string incl. wrap + trailing \r
  }
}
```

A codec test should: take `decoded`, encode it, and assert the result equals
`wire.frame_string`; and take `wire.frame_string`, decode it, and assert it
equals `decoded`. (Re-encode byte-equality is level-6-sensitive but the wire
is self-describing, so decode is level-agnostic.) All 41 fixtures here
round-trip cleanly under zlib level 6.

## Catalogue

| file | t | dir | mode | meaning |
|---|---|---|---|---|
| c_out.json | c | →WPS | compressed | connect/login object (n,c,lm,le,led,lhts,v=0.92,cc[]) |
| c_in.json | c | ←WPS | compressed | connect reply (w,mc,pc,v=server-version) |
| k.json | k | →WPS | uncompressed | keepalive (too small to compress) |
| ae.json | ae | →WPS | compressed | avatar/WhatsPic enquiry (lats, co) |
| a_upload.json | a | →WPS | compressed | WhatsPic upload (40x40 JPEG base64; no chunking) |
| a_push.json | a | ←WPS | compressed | avatar push (c, a, ts) |
| a_count.json | a | ←WPS | compressed | pending-avatar count (ac) |
| u.json | u | ←WPS | compressed | user object(s) |
| o.json | o | ←WPS | compressed | online callsign list |
| uc.json | uc | ←WPS | compressed | user connected |
| ud.json | ud | ←WPS | compressed | user disconnected |
| ue_out.json | ue | →WPS | compressed | user enquiry |
| ue_in.json | ue | ←WPS | compressed | user-enquiry reply (r,n,ls) |
| he_out.json | he | →WPS | compressed | ham name enquiry (h:[callsign]) |
| he_in.json | he | ←WPS | compressed | ham name reply (h:[{c,n,ts}]) |
| s.json | s | ←WPS | compressed | stats blob |
| p_out.json | p | →WPS | compressed | pairing request (fc) |
| p_in.json | p | ←WPS | compressed | pairing reply |
| m_out.json | m | →WPS | compressed | DM (ts=seconds, _id="${ms}-${fc}") |
| m_in.json | m | ←WPS | compressed | inbound DM |
| mb.json | mb | ←WPS | compressed | DM backfill batch (md:{mc,mt}, m[]) |
| med_out.json | med | →WPS | compressed | DM edit (edts) |
| medb.json | medb | ←WPS | compressed | DM edit batch |
| mr.json | mr | ←WPS | compressed | DM delivery receipt |
| mem_out.json | mem | →WPS | compressed | DM emoji react (a=1/0,e,ets) |
| memb.json | memb | ←WPS | compressed | DM emoji batch |
| pch.json | pch | ←WPS | compressed | channel header/list (ch:[{cid,cn}]) |
| cs_sub.json | cs | →WPS | compressed | channel subscribe (s:1, lcp cursor) |
| cs_unsub.json | cs | →WPS | compressed | channel unsubscribe (s:0) |
| cs_in.json | cs | ←WPS | compressed | subscribe reply (pc) |
| cp_out.json | cp | →WPS | compressed | channel post (rts/rfc reply, at[] mentions) |
| cp_in.json | cp | ←WPS | compressed | inbound post |
| cpb_out.json | cpb | →WPS | compressed | post-backfill request (pc) |
| cpb_in.json | cpb | ←WPS | compressed | post-backfill batch (m:{pc,pt}, p[]) |
| cped_out.json | cped | →WPS | compressed | channel-post edit |
| cpedb.json | cpedb | ←WPS | compressed | channel-post edit batch (ed[]) |
| cpr.json | cpr | ←WPS | compressed | channel-post delivery receipt (dts) |
| cpem_out.json | cpem | →WPS | compressed | channel-post emoji (a=1/0,e) |
| cpemb.json | cpemb | ←WPS | compressed | channel-post emoji batch (e[]) |
| cu.json | cu | →WPS | compressed | channel unpause/catch-up ({cid,lts} or {cid,pc}) |
| ar.json | ar | ←WPS | compressed | avatar response / upload-ack |

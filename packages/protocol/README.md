# @omp-desktop/protocol

Shared Paseo protocol schemas, codecs, and wire types.

## Stability

This package is public so Paseo's published packages can depend on it cleanly.
It is not a stable public API yet.

Schemas, exports, wire helpers, and types may change or disappear in any release
without advance notice. Use it outside Paseo at your own risk until the package
is explicitly documented as stable.

## Chunked daemon messages

WebSocket protocol version 1 clients advertise `chunked_json_messages` in hello.
Before optional [compression](#compressed-json-messages), outbound JSON up to
256 KiB uses ordinary text messages. Larger JSON messages use binary opcode
`0x20`, with each frame limited to 256 KiB:

| Field               | Encoding                                        |
| ------------------- | ----------------------------------------------- |
| Opcode              | One byte, `0x20`                                |
| Message ID          | Unsigned 32-bit, big-endian                     |
| Total JSON bytes    | Unsigned 32-bit, big-endian                     |
| Payload byte offset | Unsigned 32-bit, big-endian                     |
| Payload             | Non-empty UTF-8 bytes; frame header is 13 bytes |

Chunks for a logical message are contiguous by byte offset and keep the same ID
and total. UTF-8 characters may span chunks. Clients validate and dispatch JSON
only after the complete message arrives, and discard partial state on physical
disconnect. Ordinary heartbeat, file and terminal frames may appear between
chunks. Business JSON messages remain ordered per socket.

Each socket independently waits for send completion before reusing its chunk
buffer. The 64 MiB physical send-backlog protection remains; it is not a logical
JSON-size limit for capable clients. Waiting JSON is separately bounded to
128 MiB / 128 messages, with a 64 KiB / 16-message reserve for correlated errors.
Queue saturation returns `rpc_error` with `outbound_queue_full` when possible.
Clients without the capability retain ordinary text delivery; oversized RPC
responses return `outbound_message_too_large` without closing the shared socket.

RPC deadlines are unchanged: sufficiently slow transfers can still time out.
Diagnostics report rejected byte counts, buffer usage, limits, message types and
bounded request identifiers, never message content. History and directory
schemas, cursors and stored data are unchanged.

Provider subagent pushes have an explicit recovery path instead of closing the
shared connection on logical queue saturation. The daemon pauses only that feed,
finishes accepted FIFO messages, then sends one `invalidate` update before
resuming it. Physical send failures and nonrecoverable pushes retain their
bounded fail-closed behavior. Queue diagnostics distinguish waiting message
counts/bytes, reserved errors, the active message's type/age, and physical
`bufferedAmount`.

## Compressed JSON messages

Desktop, Web and daemon clients advertise `gzip_json_messages` in hello only
when their runtime provides both `CompressionStream` and `DecompressionStream`.
The daemon may then compress outbound JSON. Clients compress requests only
after `server_info.features.gzipJsonMessages` confirms daemon support. Missing
capabilities preserve the existing uncompressed protocol in either direction.

JSON text and individual `0x20` JSON chunks of at least 32 KiB are gzip candidates.
The compressed envelope is sent only when it is smaller than the original frame:

| Field              | Encoding                                        |
| ------------------ | ----------------------------------------------- |
| Opcode             | One byte, `0x21`                                |
| Original kind      | One byte: `0` for JSON text, `1` for JSON chunk |
| Decoded byte count | Unsigned 32-bit, big-endian                     |
| Payload            | Standard gzip; envelope header is 6 bytes       |

Compression happens before E2EE, independently for each frame; the relay needs
no changes and continues to forward ciphertext. A decoded envelope is bounded
to 64 MiB, checked while inflating, and must match its declared byte count.
Text must be valid UTF-8; binary contents must remain JSON chunks. Larger
uncompressed messages keep the existing framing path. Terminal and file-transfer
binary frames are not compressed.

Asynchronous encoding/decoding preserves JSON order. Later received frames wait
for earlier decompression, with a 64 MiB pending-input bound per socket. Queued
client sends are bounded separately from the active frame. Disconnect discards
pending work so stale decompression cannot reach a replacement connection.
Invalid or unnegotiated compressed frames close the connection explicitly.
Compression does not change model context, history contents, stream event
semantics, RPC deadlines or stored data.

## Provider subagent subscriptions

`agent.provider_subagents.set_subscription.request` replaces the requesting
socket's complete `parentAgentIds` and `timelines` sets. Parent IDs subscribe
to descriptor upserts/removals; each `{ parentAgentId, subagentId }` timeline
subscribes to that child's detail stream and implicitly its parent descriptors.
The response acknowledges the normalized sets and `requestId`. Listing or
fetching history does not acquire a live subscription. Detaching a socket
removes only that socket's interests.

Clients acquire reference-counted leases with
`acquireProviderSubagentSubscription(parentAgentId, subagentId?, { signal }?)`.
Await its acknowledgment before fetching the initial snapshot, abort pending
acquisition when a view closes, and release the lease on unmount. Reconnect
restores only active leases, not every previously cached child.

`agent.provider_subagents.update` with `kind: "invalidate"` requires an
authoritative list/timeline refresh for active subscriptions. An optional
`parentAgentId` scopes a history rebuild; its absence invalidates the socket's
whole provider feed after overloading. This marker is required even if no later
delta arrives. Clients reject snapshots started before invalidation, preserve
newer live rows/tool revisions, and continue using the existing epoch/sequence
gap recovery. Upgrade the daemon and application together for this contract.

Equivalent descriptors do not advance `updatedAt` or broadcast. Live child
text/reasoning and tool revisions coalesce per parent/child before sequence
assignment using the ordinary 60 ms stream window. Terminal state and removal
flush pending content first. Historical hydration builds its snapshot without
replaying individual rows to every connection, then emits a parent invalidation.

## Materialized tool timeline rows

Tool items carry an optional nonnegative `revision`. A new call/turn gets one
canonical row; progress replaces that row with a higher revision without changing
its `seq`. Other items remain append-only. Legacy rows without revisions remain
supported; unsequenced live progress neither advances nor erases the committed
revision.
Clients must apply newer tool revisions even behind the current sequence cursor,
reject older revisions within the same epoch, and retain newer live revisions
when a fetched snapshot races them. A new epoch starts a new revision namespace.

`contentVersion` is a content-edit watermark independent of `seq`. Incremental
fetches return `revisedEntries` or `revisedRows` for changes behind an `after`
cursor, with `hasMoreRevisions` when another revision page is needed. Ordinary
tool-body revisions do not reset the history window. Tail refreshes can update
tool state with unchanged `window.maxSeq`; older same-sequence pages must never
roll back a newer revision. Epoch replacement still requires a fresh snapshot.
Upgrade daemon and application together; sequence-only deduplication is insufficient.

Imported history keeps its original sequence numbers while superseded tool
payloads share current state. Server-only detached text-edit checkpoints preserve
the tool summaries and task logs visible at message/fork boundaries; normal
timeline responses do not expose those checkpoints.

## Runtime resource lifecycle

Clients use `getAgentRuntimeResources`, `releaseAgentRuntimeResource`, and
`unloadAgentRuntime`. Resource inventory includes `id`, `kind`
(`python_kernel`, `javascript_kernel`, `shell`, or `helper`), `ownerSessionId`,
optional `ownerAgentId` and `pid`, `state`, `retentionReasons`, `liveHandles`, and
`releasable`. Cold inventory reads retained state without waking the runtime;
dynamic state without a retained snapshot is explicitly unavailable.

Release is explicit and destructive to resource variables. Busy/shared resources
and background dependencies refuse release. Safe unload preserves active and
admitted work, unconfirmed content, permissions, background work and variables:
inventory → persistence drain → inventory → synchronous final admission guard.
The stable Desktop owner is `desktop:<agentId>`, independent of rewind's native
transcript ID. Unload retains history; deletion is a separate operation.

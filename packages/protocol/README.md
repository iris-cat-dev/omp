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
The daemon keeps outbound JSON up to 256 KiB as ordinary text messages. Larger
JSON messages use binary opcode `0x20`, with each frame limited to 256 KiB:

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

## Materialized tool timeline rows

Tool items carry an optional nonnegative `revision`. A new call/turn gets one
canonical row; progress replaces that row with a higher revision without changing
its `seq`. Other items remain append-only. Legacy rows without revisions remain
supported; unsequenced live progress neither advances nor erases the committed
revision.
Clients must apply newer tool revisions even behind the current sequence cursor,
reject older revisions within the same epoch, and retain newer live revisions
when a fetched snapshot races them. A new epoch starts a new revision namespace.

An `after` fetch may return an authoritative `reset` when earlier tool rows have
changed. Tail refreshes can update tool state even when `window.maxSeq` is
unchanged. Upgrade the daemon and application together; sequence-only duplicate
suppression is not sufficient for materialized tool updates.

Imported history keeps its original sequence numbers while superseded tool
payloads share current state. Server-only detached text-edit checkpoints preserve
the tool summaries and task logs visible at message/fork boundaries; normal
timeline responses do not expose those checkpoints.

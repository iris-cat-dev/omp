# Protocol Validator Codegen

This directory is build-time only. `ws-outbound.compile.ts` is the zod-aot discovery entry for the inbound WebSocket validator.

The generated runtime file is written to `../src/generated/validation/ws-outbound.aot.ts` and is not committed. The protocol package owns every generation trigger through its npm lifecycle scripts.

`../scripts/compile-shared-validation.mjs` composes the pinned compiler's IR extraction and fast/slow emitters. Structurally equal, repeated non-mutating containers share helpers; structural keys preserve property order and reference identity. Defaults, transforms, fallback schemas, recursive references and side-effectful refinements remain inline. Successful shared guards avoid constructing nested error paths.

The generated wrapper, schema references, synchronous/asynchronous API, transformed output and ordered validation issues retain the upstream contract. New IR kinds must be reviewed before joining the sharing whitelist. Regression tests compare shared and inline validators across nested arrays/records, union errors, absent optional properties, defaults, transforms and distinct fallback references.

`zod-aot` is exact-pinned, and the protocol generator applies the small compiler patches it requires before generation. Treat changes to those patches like compiler changes: regenerate, inspect the output, and run the protocol validation regression tests before shipping.

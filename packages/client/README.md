# @omp-desktop/client

TypeScript SDK for building integrations on top of an Omp daemon.

```bash
npm install @omp-desktop/client
```

```ts
import { createOmpClient } from "@omp-desktop/client";

const client = createOmpClient({ url: "ws://127.0.0.1:6767/ws" });
await client.connect();

const agent = await client.agents.create({
  config: { provider: "codex/gpt-5.5" },
  cwd: "/Users/me/dev/storefront",
  prompt: "Review the current diff and name the riskiest change.",
});

const result = await agent.waitForFinish();
console.log(result.lastMessage);

await client.close();
```

The public API is the package root. Imports under `@omp-desktop/client/internal/*` are unsupported implementation details used by Omp's own packages.

See the [public API definitions](./src/index.ts) for agents, workspaces, provider discovery, events, and the API reference. Runnable TypeScript patterns live in [`examples/`](./examples/README.md).

## Workspace files

Use `client.workspaceFiles` to read or save UTF-8 text on the daemon that owns a workspace. Pass its registered `workspaceId` and a forward-slash relative `path`. `scope: "project"` starts at the project root; `scope: "workspace"` starts at the workspace checkout.

```ts
const directory = { workspaceId, scope: "project", path: "canvases" } as const;
await client.workspaceFiles.mkdir(directory);
const target = { ...directory, path: "canvases/diagram.canva.json" };
await client.workspaceFiles.create({ ...target, content: '{"name":"Diagram"}\n' });

const current = await client.workspaceFiles.read(target);
if (current) {
  const result = await client.workspaceFiles.write({
    ...target,
    content: '{"name":"Updated diagram"}\n',
    expectedModifiedAt: current.modifiedAt,
    expectedRevision: current.revision,
  });
  if (result.status === "conflict") console.log("The file changed; reload before saving.");
  if (result.status === "error") throw new Error(result.error);
}
```

`list` and `read` return `null` for a missing entry; errors such as wrong entry type or an out-of-scope path are reported separately. `create` publishes the full file at once and returns `false` if the target already exists. Text files can be up to 16 MiB. Plugins need an active installation that declares and is granted `workspace.files`.

## Runtime

The client needs a WebSocket implementation. Modern browsers and Node.js 22 provide one globally.

Use a WebSocket URL ending in `/ws`, such as `ws://127.0.0.1:6767/ws`. Pass `password` when the daemon requires authentication.

## Stability

The high-level API exported from `@omp-desktop/client` is the supported SDK surface. The SDK and daemon remain protocol-compatible across versions, but newly added capabilities can require a newer daemon.

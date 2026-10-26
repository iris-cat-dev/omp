import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";

const TOKEN_ENV = "OMP_DESKTOP_LOCAL_MODEL_GATEWAY_TOKEN";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

interface GatewayModel {
  provider: string;
  id: string;
}
interface GatewayRegistry {
  authStorage: { keys: object };
  getApiKeyWithCredentialForProvider(
    provider: string,
    sessionId?: string,
    options?: unknown,
  ): Promise<unknown>;
  getAvailable(): GatewayModel[];
}
interface GatewayExtensionApi {
  on(
    event: "session_start",
    handler: (event: unknown, context: { modelRegistry: GatewayRegistry }) => void,
  ): void;
  on(event: "session_shutdown", handler: () => void): void;
}
interface NativeHttpServer {
  port: number;
  stop(closeActiveConnections?: boolean): void;
}

/** Runs inside the local OMP host. The router owns native provider auth, never the remote daemon. */
export default function localModelGateway(pi: GatewayExtensionApi): void {
  const token = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  if (!token) throw new Error("Local model gateway token is unavailable");
  let dispose: (() => void) | undefined;
  pi.on("session_start", (_event, context) => {
    dispose?.();
    const registry = context.modelRegistry;
    const available = new Map(
      registry
        .getAvailable()
        .filter(
          (model) =>
            model.provider !== "desktop-local" && model.provider !== "omp-desktop-bootstrap",
        )
        .map((model) => [`${model.provider}/${model.id}`, model]),
    );
    // The registry also owns keyless providers (Ollama/LM Studio/auth:none).
    // Raw AuthStorage alone would incorrectly reject those models with HTTP 401.
    const resolveCredential = registry.getApiKeyWithCredentialForProvider.bind(registry);
    const keys = new Proxy(registry.authStorage.keys, {
      get(target, key) {
        if (key === "getWithCredential") return resolveCredential;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const storage = new Proxy(registry.authStorage, {
      get(target, key) {
        if (key === "keys") return keys;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const router = createAuthGatewayRouter({
      storage,
      resolveModel: (id) => available.get(id),
    });
    // Bun is supplied by the compiled OMP extension host, not the Desktop Node process.
    const host = globalThis as unknown as {
      Bun: {
        serve(options: {
          hostname: string;
          port: number;
          idleTimeout: number;
          fetch(request: Request): Promise<Response>;
        }): NativeHttpServer;
      };
    };
    const server = host.Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        if (
          request.headers.get("authorization") !== `Bearer ${token}` ||
          request.headers.has("origin")
        ) {
          return new Response(null, { status: 403 });
        }
        if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/pi/stream") {
          return new Response(null, { status: 404 });
        }
        const declaredLength = Number(request.headers.get("content-length") ?? 0);
        if (declaredLength > MAX_REQUEST_BYTES) return new Response(null, { status: 413 });
        try {
          const reader = request.body?.getReader();
          if (!reader) return new Response(null, { status: 400 });
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_REQUEST_BYTES) {
              await reader.cancel();
              return new Response(null, { status: 413 });
            }
            chunks.push(next.value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (
            !body ||
            typeof body !== "object" ||
            !("modelId" in body) ||
            typeof body.modelId !== "string" ||
            !available.has(body.modelId)
          ) {
            return Response.json(
              { error: { message: "Local model is unavailable" } },
              { status: 404 },
            );
          }
          return await router.route(
            new Request(request.url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
              signal: request.signal,
            }),
            "desktop",
          );
        } catch {
          return Response.json(
            { error: { message: "Local model request failed" } },
            { status: 502 },
          );
        }
      },
    });
    dispose = () => {
      server.stop(true);
      router.close();
      dispose = undefined;
    };
    process.stdout.write(
      `${JSON.stringify({ type: "desktop_local_model_gateway_ready", port: server.port })}\n`,
    );
  });
  pi.on("session_shutdown", () => dispose?.());
}

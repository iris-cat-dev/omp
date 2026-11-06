import { createAuthGatewayRouter } from "@oh-my-pi/pi-ai/auth-gateway";
import { serve } from "@oh-my-pi/pi-utils/runtime";

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
  on(event: "session_shutdown", handler: () => void | Promise<void>): void;
}

/** Runs inside the local OMP host. The router owns native provider auth, never the remote daemon. */
export default function localModelGateway(pi: GatewayExtensionApi): void {
  const token = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  if (!token) throw new Error("Local model gateway token is unavailable");
  let dispose: (() => Promise<void>) | undefined;
  pi.on("session_start", async (_event, context) => {
    await dispose?.();
    const registry = context.modelRegistry;
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
      // Provider discovery can finish after session_start; resolve against the live registry.
      resolveModel: (id) =>
        registry
          .getAvailable()
          .find(
            (model) =>
              model.provider !== "desktop-local" &&
              model.provider !== "omp-desktop-bootstrap" &&
              `${model.provider}/${model.id}` === id,
          ),
    });
    const server = await serve({
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
          return await router.route(
            new Request(request.url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: bytes,
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
    dispose = async () => {
      await server.stop(true);
      router.close();
      dispose = undefined;
    };
    process.stdout.write(
      `${JSON.stringify({ type: "desktop_local_model_gateway_ready", port: server.port })}\n`,
    );
  });
  pi.on("session_shutdown", () => dispose?.());
}

import { createServer } from "node:http";

const TOKEN_ENV = "OMP_DESKTOP_SERVICE_TIER_TOKEN";

interface ServiceTierModel {
  provider: string;
  id: string;
  api?: string;
  identity?: { class?: string };
  serviceTiers?: readonly string[];
}
export interface NativeServiceTierApi {
  on(
    event: "session_start",
    handler: (event: unknown, context: { model?: ServiceTierModel }) => Promise<void>,
  ): void;
  on(event: "session_shutdown", handler: () => void): void;
  getServiceTiers?(): Readonly<Record<string, string | undefined>>;
  setServiceTier?(family: "openai", tier: "priority" | "ultrafast" | undefined): void;
}
export interface NativeServiceTierSnapshot {
  available: boolean;
  model: { provider: string; id: string } | null;
  openaiFamily: boolean;
  tier: string | null;
  ultrafastAvailable: boolean;
}

function isOpenAIFamily(model: ServiceTierModel | undefined): boolean {
  if (!model) return false;
  if (model.provider === "openai" || model.provider === "openai-codex") return true;
  if (model.provider === "fireworks" || model.provider === "github-copilot") return false;
  return (
    model.identity?.class === "openai" &&
    ["openai-completions", "openai-responses", "openai-codex-responses"].includes(model.api ?? "")
  );
}

/** Read the native session override, not the boolean Fast RPC's lossy projection. */
export function readNativeServiceTier(
  pi: NativeServiceTierApi,
  model: ServiceTierModel | undefined,
): NativeServiceTierSnapshot {
  const available =
    typeof pi.getServiceTiers === "function" && typeof pi.setServiceTier === "function";
  const openaiFamily = isOpenAIFamily(model);
  return {
    available,
    model: model ? { provider: model.provider, id: model.id } : null,
    openaiFamily,
    tier: available && openaiFamily ? (pi.getServiceTiers!().openai ?? null) : null,
    // Advertising the tier is capability evidence, not account entitlement.
    ultrafastAvailable:
      available &&
      openaiFamily &&
      model?.serviceTiers?.includes("ultrafast") === true &&
      (model.provider === "openai" || model.api === "openai-codex-responses"),
  };
}

export function applyNativeServiceTier(
  pi: NativeServiceTierApi,
  model: ServiceTierModel | undefined,
  expectedModel: { provider: string; id: string },
  value: "off" | "on" | "ultrafast",
): NativeServiceTierSnapshot {
  const before = readNativeServiceTier(pi, model);
  if (!model || model.provider !== expectedModel.provider || model.id !== expectedModel.id) {
    throw new Error("OMP model changed before the service tier update");
  }
  if (!before.ultrafastAvailable) {
    throw new Error("OMP Ultrafast is unavailable for the current model");
  }
  if (
    value === "on" &&
    model.api === "openai-codex-responses" &&
    model.serviceTiers?.length &&
    !model.serviceTiers.includes("priority")
  ) {
    throw new Error("OMP Fast is unavailable for the current model");
  }
  if (before.tier !== null && !["auto", "default", "priority", "ultrafast"].includes(before.tier)) {
    throw new Error("OMP has a native service tier outside the Fast selector");
  }
  // Validation, the single native mutation, and readback are synchronous. No
  // user turn or model switch can interleave an off -> ultra intermediate tier.
  let tier: "priority" | "ultrafast" | undefined;
  if (value !== "off") tier = value === "on" ? "priority" : "ultrafast";
  pi.setServiceTier!("openai", tier);
  const after = readNativeServiceTier(pi, model);
  const expectedTier = tier ?? null;
  if (after.tier !== expectedTier) throw new Error("OMP did not apply the requested service tier");
  return after;
}

/** Private control plane only: never registers a prompt, tool, or user message. */
export default function desktopServiceTier(pi: NativeServiceTierApi): void {
  const token = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  if (!token) throw new Error("Desktop service tier control token is unavailable");
  let stop: (() => void) | undefined;
  pi.on("session_start", async (_event, context) => {
    stop?.();
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin) {
        response.writeHead(403).end('{"error":"Forbidden"}');
        return;
      }
      if (request.url !== "/tier" || !["GET", "POST"].includes(request.method ?? "")) {
        response.writeHead(404).end('{"error":"Not found"}');
        return;
      }
      void (async () => {
        if (request.method === "GET") {
          response.writeHead(200).end(JSON.stringify(readNativeServiceTier(pi, context.model)));
          return;
        }
        const buffers: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 1024) throw new Error("OMP service tier request is too large");
          buffers.push(Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(Buffer.concat(buffers).toString("utf8"));
        if (
          typeof body !== "object" ||
          body === null ||
          !("value" in body) ||
          (body.value !== "off" && body.value !== "on" && body.value !== "ultrafast") ||
          !("model" in body) ||
          typeof body.model !== "object" ||
          body.model === null ||
          !("provider" in body.model) ||
          typeof body.model.provider !== "string" ||
          !("id" in body.model) ||
          typeof body.model.id !== "string"
        )
          throw new Error("Invalid OMP service tier update");
        const result = applyNativeServiceTier(
          pi,
          context.model,
          { provider: body.model.provider, id: body.model.id },
          body.value,
        );
        response.writeHead(200).end(JSON.stringify(result));
      })().catch((error: unknown) => {
        const message =
          error instanceof Error && /^(OMP |Invalid OMP )/.test(error.message)
            ? error.message
            : "OMP service tier update failed";
        response.writeHead(400).end(JSON.stringify({ error: message }));
      });
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    const ready = Promise.withResolvers<void>();
    server.once("error", ready.reject);
    server.listen(0, "127.0.0.1", () => ready.resolve());
    await ready.promise;
    server.removeListener("error", ready.reject);
    server.unref();
    stop = () => {
      server.closeAllConnections();
      server.close();
      stop = undefined;
    };
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("OMP service tier endpoint did not bind");
    process.stdout.write(
      `${JSON.stringify({ type: "desktop_service_tier_ready", port: address.port })}\n`,
    );
  });
  pi.on("session_shutdown", () => stop?.());
}

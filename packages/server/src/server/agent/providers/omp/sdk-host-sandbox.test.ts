import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSandbox } from '@omp-desktop/protocol/messages';
import { OMP_SDK_LAUNCH_ENV } from "./sdk-host-protocol.js";
import { runOmpSdkHost } from "./sdk-host.js";

const mocks = vi.hoisted(() => ({ load: vi.fn(), start: vi.fn() }));
vi.mock("node:module", () => ({ createRequire: () => mocks.load }));
vi.mock("./sdk-installation.js", () => ({ resolveOmpSdkInstallation: async () => ({ root: "/sdk", version: "old", rpcEntry: "/sdk/rpc.mjs" }) }));
vi.mock("./cli-runtime.js", () => ({ resolveOmpCodexCatalogPreloadPath: () => "/trusted-preload" }));
const originalArgv = process.argv;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  process.argv = originalArgv.slice(0, 2);
  globalThis.fetch = originalFetch;
  mocks.load.mockReset(); mocks.start.mockReset();
  mocks.start.mockRejectedValue(new Error("Reached SDK startup"));
});
afterEach(() => { process.argv = originalArgv; globalThis.fetch = originalFetch; vi.unstubAllEnvs(); });
function configure(sandbox: boolean | AgentSandbox, version?: number) {
  vi.stubEnv(OMP_SDK_LAUNCH_ENV, JSON.stringify({ cwd: process.cwd(), ...(sandbox ? { sandbox: sandbox === true ? { root: `${process.cwd()}/qq-files` } : sandbox } : {}) }));
  mocks.load.mockImplementation((entry: string) => entry === "/trusted-preload" ? undefined : { startNodeRpcHost: mocks.start, NODE_RPC_SANDBOX_VERSION: version });
}
describe("mandatory SDK sandbox capability handshake", () => {
  it.each([undefined, 0, 4])("refuses unsupported capability %s before entering SDK startup", async (version) => {
    configure(true, version);
    await expect(runOmpSdkHost()).rejects.toThrow("lacks mandatory sandbox support");
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it.each([1, 2, 3])("admits supported profile %s for file-only sessions", async (version) => {
    configure(true, version);
    await expect(runOmpSdkHost()).rejects.toThrow("Reached SDK startup");
  });
  it.each([{ javascript: true }, { network: 'public' as const }, { javascript: true, network: 'public' as const }])('requires profile 2 for requested capabilities %s', async (capabilities) => {
    configure({ root: `${process.cwd()}/qq-files`, ...capabilities }, 1);
    await expect(runOmpSdkHost()).rejects.toThrow('NODE_RPC_SANDBOX_VERSION=2');
    configure({ root: `${process.cwd()}/qq-files`, ...capabilities }, 2);
    await expect(runOmpSdkHost()).rejects.toThrow('Reached SDK startup');
  });
  it.each([1, 2])("requires profile 3 for image generation, independently of public network (%s)", async version => {
    configure({ root: `${process.cwd()}/qq-files`, imageGeneration: true }, version);
    await expect(runOmpSdkHost()).rejects.toThrow("NODE_RPC_SANDBOX_VERSION=3");
    expect(mocks.start).not.toHaveBeenCalled();
    configure({ root: `${process.cwd()}/qq-files`, imageGeneration: true }, 3);
    await expect(runOmpSdkHost()).rejects.toThrow("Reached SDK startup");
  });
  it("keeps ordinary Desktop startup compatible with SDKs predating the sandbox profile", async () => {
    configure(false);
    await expect(runOmpSdkHost()).rejects.toThrow("Reached SDK startup");
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it("re-wraps globalThis.fetch after SDK bootstrap replaces it with its Node proxy fetch", async () => {
    vi.stubEnv(OMP_SDK_LAUNCH_ENV, JSON.stringify({ cwd: process.cwd() }));
    let underlyingCalls = 0;
    const sdkReplacedFetch: typeof fetch = async () => {
      underlyingCalls += 1;
      return Response.json({ models: [{ slug: "research" }] });
    };
    mocks.load.mockImplementation((entry: string) => {
      if (entry === "/trusted-preload") return undefined;
      globalThis.fetch = sdkReplacedFetch;
      return { startNodeRpcHost: mocks.start };
    });

    await expect(runOmpSdkHost()).rejects.toThrow("Reached SDK startup");
    await expect(
      globalThis.fetch("https://chatgpt.com/backend-api/models?client_version=0.169.1"),
    ).rejects.toThrow("The generic ChatGPT model catalog is not a Codex discovery endpoint");
    expect(underlyingCalls).toBe(0);
  });
});

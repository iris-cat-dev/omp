import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { execCommandMock, findExecutableMock } = vi.hoisted(() => ({
  execCommandMock: vi.fn(),
  findExecutableMock: vi.fn(),
}));

vi.mock("../../../../executable-resolution/executable-resolution.js", () => ({
  findExecutable: findExecutableMock,
}));
vi.mock("../../../../utils/spawn.js", () => ({
  execCommand: execCommandMock,
}));

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { OmpAgentClient } from "./agent.js";
import { cancelOmpInstall, resolveOmpUpdatePaths } from "./installer.js";

const releasePath = "/can1357/oh-my-pi/releases";
const oldBinary = Buffer.from("omp/18.1.5\nexisting runtime\n");
const newBinary = Buffer.from("omp/18.1.8\nverified replacement runtime\n");
const checksum = createHash("sha256").update(newBinary).digest("hex");
const proxyAuthorization = `Basic ${Buffer.from("update-user:update-password").toString("base64")}`;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("OMP_COMMAND", "");
  vi.stubEnv("PASEO_DESKTOP_MANAGED", "0");
  vi.stubEnv("PI_INSTALL_DIR", "");
  vi.stubEnv("PATH", process.env.PATH ?? "");
});

afterEach(async () => {
  try {
    await cancelOmpInstall();
  } finally {
    try {
      while (cleanups.length > 0) await cleanups.pop()!();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  }
});

interface ObservedRequest {
  path: string;
  method: string | undefined;
  proxied: boolean;
  authorization: string | undefined;
  proxyAuthorization: string | undefined;
}

interface ProxyFixture {
  client(mode?: "enabled" | "unconfigured" | "disabled"): OmpAgentClient;
  directory: string;
  installPath: string;
  requests: ObservedRequest[];
  tunnels: Array<{ target: string | undefined; authorization: string | undefined }>;
  origin: string;
  assetOrigin: string;
  firstChunk: Buffer;
  bodyStarted: Promise<void>;
  bodyClosed: Promise<void>;
  finishBody(): void;
  paths: { stagedPath: string; checksumPath: string; previousPath: string };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function createFixture(
  options: { holdBody?: boolean; badChecksum?: boolean } = {},
): Promise<ProxyFixture> {
  const directory = await mkdtemp(join(tmpdir(), "omp-installer-proxy-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const installPath = join(directory, process.platform === "win32" ? "omp.exe" : "omp");
  await writeFile(installPath, oldBinary);
  vi.stubEnv("OMP_COMMAND", installPath);
  vi.stubEnv("PI_INSTALL_DIR", directory);
  findExecutableMock.mockResolvedValue(installPath);
  // Version checks read the actual downloaded file; no downloaded code is executed.
  execCommandMock.mockImplementation(async (command: string) => ({
    stdout: (await readFile(command, "utf8")).split("\n")[0],
    stderr: "",
  }));

  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const proxiedPorts = new Set<number>();
  const requests: ObservedRequest[] = [];
  const tunnels: Array<{ target: string | undefined; authorization: string | undefined }> = [];
  let bodyResponse: ServerResponse | undefined;
  let markBodyStarted!: () => void;
  let markBodyClosed!: () => void;
  const bodyStarted = new Promise<void>((resolve) => {
    markBodyStarted = resolve;
  });
  const bodyClosed = new Promise<void>((resolve) => {
    markBodyClosed = resolve;
  });
  const firstChunk = newBinary.subarray(0, 8);

  function track(socket: Socket) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  }
  function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
    const server = createServer(handler);
    server.on("connection", track);
    servers.push(server);
    return server;
  }
  function observe(request: IncomingMessage) {
    requests.push({
      path: request.url ?? "",
      method: request.method,
      proxied: proxiedPorts.has(request.socket.remotePort ?? -1),
      authorization: request.headers.authorization,
      proxyAuthorization: request.headers["proxy-authorization"],
    });
  }
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      ),
    );
  });

  const assetOrigin = await listen(
    serve((request, response) => {
      observe(request);
      if (request.url !== "/binary") {
        response.writeHead(404).end();
        return;
      }
      bodyResponse = response;
      response.once("close", markBodyClosed);
      response.writeHead(200, { "Content-Length": newBinary.length });
      response.write(firstChunk);
      markBodyStarted();
      if (!options.holdBody) response.end(newBinary.subarray(firstChunk.length));
    }),
  );
  const origin = await listen(
    serve((request, response) => {
      observe(request);
      const path = request.url ?? "";
      if (path === `${releasePath}/latest`) {
        response.writeHead(302, { Location: `${releasePath}/tag/v18.1.8` }).end();
      } else if (path === `${releasePath}/tag/v18.1.8`) {
        response.writeHead(200).end();
      } else if (path === `${releasePath}/download/v18.1.8/SHA256SUMS.txt`) {
        const digest = options.badChecksum ? "0".repeat(64) : checksum;
        // Include each supported release target so the test follows the host's real selection.
        const targets = [
          "darwin-arm64",
          "darwin-x64",
          "linux-arm64",
          "linux-x64",
          "linux-musl-arm64",
          "linux-musl-x64",
          "windows-arm64.exe",
          "windows-x64.exe",
        ];
        response.writeHead(200).end(targets.map((target) => `${digest}  omp-${target}`).join("\n"));
      } else if (path.startsWith(`${releasePath}/download/v18.1.8/omp-`)) {
        response.writeHead(302, { Location: `${assetOrigin}/binary` }).end();
      } else {
        response.writeHead(404).end();
      }
    }),
  );

  const proxy = serve((_request, response) => response.writeHead(405).end());
  proxy.on("connect", (request, downstream, head) => {
    tunnels.push({ target: request.url, authorization: request.headers["proxy-authorization"] });
    if (request.headers["proxy-authorization"] !== proxyAuthorization) {
      downstream.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=updates\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    // Refuse non-fixture destinations rather than allowing accidental external traffic.
    const target = `http://${request.url}`;
    if (target !== origin && target !== assetOrigin) {
      downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const destination = new URL(target);
    const upstream = connect(Number(destination.port), destination.hostname);
    track(upstream);
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
    downstream.once("close", () => upstream.destroy());
    upstream.once("connect", () => {
      if (upstream.localPort !== undefined) proxiedPorts.add(upstream.localPort);
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
  });
  const proxyOrigin = await listen(proxy);
  const proxyUrl = proxyOrigin.replace("http://", "http://update-user:update-password@");

  // Only remap canonical GitHub URLs. All I/O (including redirects, dispatcher and
  // cancellation) remains native fetch against the real origins and CONNECT proxy.
  const nativeFetch = globalThis.fetch;
  const localFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== "https://github.com")
      throw new Error(`Unexpected external URL: ${url.origin}`);
    const localUrl = `${origin}${url.pathname}${url.search}`;
    const response = await nativeFetch(
      input instanceof Request ? new Request(localUrl, input) : localUrl,
      init,
    );
    if (response.url.startsWith(`${origin}${releasePath}/tag/`)) {
      Object.defineProperty(response, "url", {
        value: response.url.replace(origin, "https://github.com"),
      });
    }
    return response;
  };
  vi.stubGlobal("fetch", localFetch);

  function client(mode: "enabled" | "unconfigured" | "disabled" = "enabled") {
    return new OmpAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        ompBackend: "cli",
        ...(mode === "unconfigured" ? {} : {
          proxyPolicy: {
            enabled: mode !== "disabled",
            default: { mode: "proxy" as const, url: proxyUrl },
          },
        }),
      },
    });
  }

  return {
    client,
    directory,
    installPath,
    requests,
    tunnels,
    origin,
    assetOrigin,
    firstChunk,
    bodyStarted,
    bodyClosed,
    finishBody: () => bodyResponse?.end(newBinary.subarray(firstChunk.length)),
    paths: resolveOmpUpdatePaths(installPath),
  };
}

function expectDownloadRequests(requests: ObservedRequest[], proxied: boolean) {
  expect(requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: `${releasePath}/latest`, method: "HEAD", proxied }),
      expect.objectContaining({ path: `${releasePath}/tag/v18.1.8`, method: "HEAD", proxied }),
      expect.objectContaining({
        path: `${releasePath}/download/v18.1.8/SHA256SUMS.txt`,
        method: "GET",
        proxied,
      }),
      expect.objectContaining({
        path: expect.stringMatching(/\/download\/v18\.1\.8\/omp-/),
        method: "GET",
        proxied,
      }),
      expect.objectContaining({ path: "/binary", method: "GET", proxied }),
    ]),
  );
  expect(requests.every((request) => request.proxied === proxied)).toBe(true);
  for (const request of requests) {
    expect(request.authorization).toBeUndefined();
    expect(request.proxyAuthorization).toBeUndefined();
    expect(request.path).not.toContain("update-password");
  }
}

function expectAuthenticatedTunnels(fixture: ProxyFixture) {
  expect(fixture.tunnels).toEqual(
    expect.arrayContaining([
      { target: new URL(fixture.origin).host, authorization: proxyAuthorization },
      { target: new URL(fixture.assetOrigin).host, authorization: proxyAuthorization },
    ]),
  );
  expect(fixture.tunnels.every((tunnel) => tunnel.authorization === proxyAuthorization)).toBe(true);
}

async function expectOnlyExistingBinary(fixture: ProxyFixture) {
  await expect(readFile(fixture.installPath)).resolves.toEqual(oldBinary);
  await expect(readdir(fixture.directory)).resolves.toEqual([
    process.platform === "win32" ? "omp.exe" : "omp",
  ]);
}

describe("OMP runtime updates through the application proxy", () => {
  test.each([true, false])(
    "checks and downloads through authenticated CONNECT (defer=%s)",
    async (defer) => {
      const fixture = await createFixture({ holdBody: true });
      const client = fixture.client();
      await expect(
        client.getOmpInstallationStatus({ checkForUpdates: true }),
      ).resolves.toMatchObject({
        installed: true,
        version: "omp/18.1.5",
        latestVersion: "18.1.8",
        updateAvailable: true,
      });
      expect(fixture.requests.every((request) => request.proxied)).toBe(true);

      const installation = client.installOmp({ defer });
      await Promise.race([
        fixture.bodyStarted,
        installation.then(() => {
          throw new Error("Installation finished without starting the asset body");
        }),
      ]);
      await vi.waitFor(async () => {
        await expect(client.getOmpInstallationStatus()).resolves.toMatchObject({
          updatePhase: "downloading",
          downloadedBytes: fixture.firstChunk.length,
          totalBytes: newBinary.length,
          updateProgress: Math.floor((fixture.firstChunk.length / newBinary.length) * 100),
        });
      });
      fixture.finishBody();
      const status = await installation;
      expect(status).toMatchObject({
        installed: true,
        latestVersion: "18.1.8",
        pendingUpdate: defer,
        updatePhase: defer ? "pending-restart" : "complete",
        updateProgress: 100,
        version: defer ? "omp/18.1.5" : "omp/18.1.8",
      });
      expect(JSON.stringify(status)).not.toContain("update-password");
      if (defer) {
        expect(status).toMatchObject({
          downloadedBytes: newBinary.length,
          totalBytes: newBinary.length,
        });
        await expect(readFile(fixture.installPath)).resolves.toEqual(oldBinary);
        await expect(readFile(fixture.paths.stagedPath)).resolves.toEqual(newBinary);
        await expect(readFile(fixture.paths.checksumPath, "utf8")).resolves.toBe(`${checksum}\n`);
      } else {
        await expect(readFile(fixture.installPath)).resolves.toEqual(newBinary);
        await expect(access(fixture.paths.stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(fixture.paths.checksumPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expectDownloadRequests(fixture.requests, true);
      expectAuthenticatedTunnels(fixture);
    },
  );

  test.each(["unconfigured", "disabled"] as const)(
    "keeps %s explicit proxy traffic direct",
    async (mode) => {
      const fixture = await createFixture();
      const client = fixture.client(mode);
      await expect(
        client.getOmpInstallationStatus({ checkForUpdates: true }),
      ).resolves.toMatchObject({
        latestVersion: "18.1.8",
        updateAvailable: true,
      });
      await expect(client.installOmp({ defer: true })).resolves.toMatchObject({
        pendingUpdate: true,
        updatePhase: "pending-restart",
        updateProgress: 100,
        downloadedBytes: newBinary.length,
      });
      await expect(readFile(fixture.paths.stagedPath)).resolves.toEqual(newBinary);
      await expect(readFile(fixture.paths.checksumPath, "utf8")).resolves.toBe(`${checksum}\n`);
      expectDownloadRequests(fixture.requests, false);
      expect(fixture.tunnels).toEqual([]);
    },
  );

  test("cancels an in-flight proxied asset body without replacing or staging the runtime", async () => {
    const fixture = await createFixture({ holdBody: true });
    const client = fixture.client();
    const installation = client.installOmp({ defer: true });
    await Promise.race([
      fixture.bodyStarted,
      installation.then(() => {
        throw new Error("Installation finished without starting the asset body");
      }),
    ]);
    await vi.waitFor(async () => {
      await expect(client.getOmpInstallationStatus()).resolves.toMatchObject({
        updatePhase: "downloading",
        downloadedBytes: fixture.firstChunk.length,
      });
    });
    await expect(client.cancelOmpInstall()).resolves.toMatchObject({
      installed: true,
      version: "omp/18.1.5",
      updatePhase: "canceled",
      message: "OMP update canceled",
    });
    await expect(installation).resolves.toMatchObject({ updatePhase: "canceled" });
    await fixture.bodyClosed;
    await expectOnlyExistingBinary(fixture);
    expectDownloadRequests(fixture.requests, true);
    expectAuthenticatedTunnels(fixture);
  });

  test("rejects a proxied checksum mismatch without replacing or staging the runtime", async () => {
    const fixture = await createFixture({ badChecksum: true });
    const client = fixture.client();
    await expect(client.installOmp({ defer: true })).rejects.toThrow("failed SHA-256 verification");
    await expectOnlyExistingBinary(fixture);
    await expect(client.getOmpInstallationStatus()).resolves.toMatchObject({
      installed: true,
      version: "omp/18.1.5",
    });
    expectDownloadRequests(fixture.requests, true);
    expectAuthenticatedTunnels(fixture);
  });
});

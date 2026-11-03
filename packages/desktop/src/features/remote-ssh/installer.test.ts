import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeRemoteBackendFixture } from "../../../test-utils/remote-backend.js";
import { RemoteSshDeployment, type RemoteSshSession } from "./installer.js";
import type { RemoteSshEvent } from "./types.js";

vi.mock("electron", () => ({ app: {}, net: {} }));
vi.mock("node-pty", () => ({}));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "omp-ssh-lifecycle-"));
  await writeRemoteBackendFixture(directory);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function reusableSession(): RemoteSshSession {
  const offer = {
    v: 2,
    serverId: "managed-remote",
    daemonPublicKeyB64: Buffer.alloc(32).toString("base64"),
    relay: { endpoint: "relay.example.test:443", useTls: true },
  };
  const url = `https://app.example.test/#offer=${Buffer.from(JSON.stringify(offer)).toString("base64url")}`;
  return {
    writeInput() {},
    close() {},
    finishAuthentication() {},
    async waitForLine(marker) {
      if (!marker.startsWith("__OMP_READY_")) throw new Error("Unexpected installation on a reusable host");
      return `Linux|aarch64|${Buffer.from("/home/deploy").toString("base64")}|glibc 2.35`;
    },
    async executeCommand() {
      return `${Buffer.from(JSON.stringify({ url })).toString("base64")}|${Buffer.from("remote-host").toString("base64")}`;
    },
    writeCommand() { throw new Error("A reusable deployment must not be reinstalled"); },
    async uploadFile() { throw new Error("A reusable deployment must not upload files"); },
  };
}

describe("remote SSH deployment lifecycle", () => {
  it("reuses a matching Linux arm64 host without downloading or reinstalling its SDK", async () => {
    const events: RemoteSshEvent[] = [];
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("Network unavailable"); });
    const session = reusableSession();
    const closed = vi.spyOn(session, "close");
    const deployment = new RemoteSshDeployment(
      { operationId: randomUUID(), target: { host: "remote.example.test" }, expectedServerId: "managed-remote" },
      (event) => events.push(event),
      { bundleDirectory: directory, cacheDirectory: path.join(directory, "cache"), fetch: fetcher, createSession: () => session },
    );
    await deployment.run();
    expect(fetcher).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "phase").map((event) => event.phase)).toEqual(["connecting", "inspecting", "pairing", "complete"]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("does not open SSH or download an asset after cancellation before run", async () => {
    const createSession = vi.fn(() => reusableSession());
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const events: RemoteSshEvent[] = [];
    const deployment = new RemoteSshDeployment(
      { operationId: randomUUID(), target: { host: "remote.example.test" } },
      (event) => events.push(event),
      { bundleDirectory: directory, cacheDirectory: path.join(directory, "cache"), fetch: fetcher, createSession },
    );
    deployment.cancel();
    await expect(deployment.run()).rejects.toThrow("SSH deployment was cancelled");
    expect(createSession).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "failed")).toHaveLength(1);
  });
});

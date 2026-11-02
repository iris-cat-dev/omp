import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildRemoteInstallScript } from "./bootstrap-script.js";

describe("buildRemoteInstallScript", () => {
  it("produces a valid POSIX shell program", () => {
    const script = buildRemoteInstallScript({
      token: "8f61b165-56ff-405d-a20f-01f2f35f9003",
      backendVersion: "0.3.0",
      nodeVersion: "22.20.0",
      bundleHash: "a".repeat(64),
      relayAddress: "wss://relay.example.test/ws",
    });
    const shell = process.platform === "win32" ? "sh.exe" : "/bin/sh";
    const result = spawnSync(shell, ["-n"], { input: script, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

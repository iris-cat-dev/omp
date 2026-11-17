import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSshArguments,
  parseRemoteTargetInfo,
  resolveSshExecutable,
  type SshArgumentOptions,
} from "./target.js";

const fileDoesNotExist = () => false;

describe("buildSshArguments", () => {
  function effectiveOptions(options: SshArgumentOptions): Record<string, string> {
    const directory = mkdtempSync(path.join(os.tmpdir(), "omp-ssh-config-"));
    const config = path.join(directory, "config");
    try {
      writeFileSync(
        config,
        "Host *\n  ControlMaster auto\n  ControlPath ~/.ssh/control-%h\n  ControlPersist 60\n",
      );
      const output = execFileSync(
        resolveSshExecutable(),
        ["-G", "-F", config, ...buildSshArguments({ host: "build-server" }, options)],
        { encoding: "utf8", timeout: 10_000 },
      );
      return Object.fromEntries(
        output
          .trim()
          .split(/\r?\n/u)
          .map((line) => {
            const separator = line.indexOf(" ");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("disables connection sharing even when the user config enables it", () => {
    const options = effectiveOptions({ controlMaster: false, controlPath: "/tmp/ignored.sock" });
    expect(options.controlmaster).toMatch(/^(?:false|no)$/u);
    expect(options.controlpath ?? "none").toBe("none");
    expect(options.controlpersist).toBe("no");
  });

  it("preserves explicit master sockets for Unix sessions", () => {
    const options = effectiveOptions({ controlMaster: true, controlPath: "/tmp/omp.sock" });
    expect(options.controlmaster).toMatch(/^(?:true|yes)$/u);
    expect(options.controlpath).toBe("/tmp/omp.sock");
    expect(options.controlpersist).toBe("no");
  });

  it.each(["-oProxyCommand=evil", "host\ncommand", "host with-space"])(
    "rejects unsafe host %j",
    (host) => {
      expect(() => buildSshArguments({ host })).toThrow();
    },
  );
});

describe("resolveSshExecutable", () => {
  it("resolves the Windows OpenSSH client to an absolute path", () => {
    const executable = String.raw`C:\Windows\System32\OpenSSH\ssh.exe`;

    expect(
      resolveSshExecutable("win32", { SystemRoot: String.raw`C:\Windows` }, (candidate) => {
        return candidate === executable;
      }),
    ).toBe(executable);
  });

  it("reports a missing Windows OpenSSH client directly", () => {
    expect(() => resolveSshExecutable("win32", {}, fileDoesNotExist)).toThrow(
      "Install the Windows OpenSSH Client feature",
    );
  });
});

describe("parseRemoteTargetInfo", () => {
  const home = Buffer.from("/home/deploy user").toString("base64");
  it.each([
    ["Darwin", "x86_64", "none", "darwin", "x64"],
    ["Darwin", "arm64", "none", "darwin", "arm64"],
    ["Linux", "x86_64", "glibc 2.35", "linux", "x64"],
    ["Linux", "aarch64", "glibc 2.35", "linux", "arm64"],
  ])(
    "selects %s %s from SSH inspection rather than the client",
    (system, machine, libc, platform, arch) => {
      expect(parseRemoteTargetInfo(`${system}|${machine}|${home}|${libc}`)).toEqual({
        platform,
        arch,
        home: "/home/deploy user",
      });
    },
  );

  it.each(["musl 1.2.5", "unknown", ""])("rejects unsupported Linux libc %j explicitly", (libc) => {
    expect(() => parseRemoteTargetInfo(`Linux|x86_64|${home}|${libc}`)).toThrow(
      "Linux remote hosts require glibc; musl is unsupported",
    );
  });

  it.each(["Windows_NT|x86_64", "Linux|riscv64", "Darwin|unknown"])(
    "rejects unsupported host %s",
    (target) => {
      expect(() => parseRemoteTargetInfo(`${target}|${home}|none`)).toThrow(
        "Unsupported SSH host platform",
      );
    },
  );
});

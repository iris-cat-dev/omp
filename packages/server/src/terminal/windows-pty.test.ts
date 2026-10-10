import { describe, expect, it } from "vitest";
import { resolveTerminalWindowsPtyOptions } from "./windows-pty.js";

describe("resolveTerminalWindowsPtyOptions", () => {
  it("describes the ConPTY backend and Windows build", () => {
    expect(
      resolveTerminalWindowsPtyOptions({ platform: "win32", osRelease: "10.0.26200" }),
    ).toEqual({ backend: "conpty", buildNumber: 26_200 });
  });

  it("keeps ConPTY resize behavior enabled when the build cannot be parsed", () => {
    expect(resolveTerminalWindowsPtyOptions({ platform: "win32", osRelease: "unknown" })).toEqual({
      backend: "conpty",
    });
  });

  it("does not advertise Windows PTY behavior on Unix hosts", () => {
    expect(
      resolveTerminalWindowsPtyOptions({ platform: "darwin", osRelease: "25.0.0" }),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { MarkerBuffer } from "./marker-buffer.js";

describe("MarkerBuffer", () => {
  it("resolves markers split across PTY chunks and normalizes carriage returns", async () => {
    const buffer = new MarkerBuffer();
    const result = buffer.waitForLine("__OMP_RESULT__");
    buffer.push("noise\r\n__OMP_RES");
    buffer.push("ULT__payload\r\n");
    await expect(result).resolves.toBe("payload");
  });

  it("removes split ConPTY erase sequences and ignores markers inside window titles", async () => {
    const buffer = new MarkerBuffer();
    const result = buffer.waitForBlock("__START__", "__END__");
    buffer.push("\x1b]0;__START__spoof\x1b");
    buffer.push("\\__START__\r\n0\x1b[4");
    buffer.push("5X\r\nYWJj\x1b[26X\r\n__END__");
    await expect(result).resolves.toBe("\n0\nYWJj\n");
  });

  it("collects multiline frames split across terminal chunks without consuming later phases", async () => {
    const buffer = new MarkerBuffer();
    const result = buffer.waitForBlock("__START__", "__END__");
    buffer.push("prompt\r\n__STA");
    buffer.push("RT__\r\n0\r\nYWJj\r\n__EN");
    buffer.push("D__\r\n__PHASE__installing\r\n");
    await expect(result).resolves.toBe("\n0\nYWJj\n");
    await expect(buffer.waitForLine("__PHASE__")).resolves.toBe("installing");
  });

  it("rejects an incomplete frame on session close", async () => {
    const buffer = new MarkerBuffer();
    const result = buffer.waitForBlock("__START__", "__END__");
    buffer.push("__START__\r\npartial");
    buffer.rejectAll(new Error("SSH exited"));
    await expect(result).rejects.toThrow("SSH exited");
  });

  it("rejects pending operations when the SSH process exits", async () => {
    const buffer = new MarkerBuffer();
    const result = buffer.waitForLine("__OMP_READY__");
    buffer.rejectAll(new Error("SSH exited"));
    await expect(result).rejects.toThrow("SSH exited");
  });
});

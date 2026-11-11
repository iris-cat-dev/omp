import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { PluginSessionSocket } from "./session-socket.js";

describe("PluginSessionSocket", () => {
  it("closes a disconnected real child IPC channel once without escaping errors", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('message',()=>{});process.on('disconnect',()=>process.exit(0));"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const ipcErrors: Error[] = [];
    child.on("error", error => ipcErrors.push(error));
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      const socket = new PluginSessionSocket(child);
      const socketErrors: unknown[] = [];
      let closes = 0;
      socket.on("error", error => socketErrors.push(error));
      socket.on("close", () => { closes += 1; });
      child.disconnect();
      socket.close();
      socket.close();
      await exited;
      expect(socket.readyState).toBe(3);
      expect(closes).toBe(1);
      expect(ipcErrors).toEqual([]);
      expect(socketErrors).toEqual([]);
      const lateSendError = await new Promise<Error | undefined>(resolve => socket.send("late", resolve));
      expect(lateSendError?.message).toBe("Plugin session socket is closed");
    } finally {
      child.kill();
      await exited;
    }
  });

  it("absorbs asynchronous EPIPE after local close and reports unrelated IPC failures", async () => {
    for (const code of ["EPIPE", "ERR_IPC_CHANNEL_CLOSED", "EIO"]) {
      const sent = Promise.withResolvers<void>();
      const failure = Object.assign(new Error(code), { code });
      const socket = new PluginSessionSocket({ connected: true, send(_message, callback) {
        queueMicrotask(() => { callback?.(failure); sent.resolve(); });
        return false;
      } });
      const errors: unknown[] = [];let closes = 0;
      socket.on("error", error => errors.push(error));
      socket.on("close", () => { closes += 1; });
      socket.close();socket.close();
      await sent.promise;
      expect(closes).toBe(1);
      expect(errors).toEqual(code === "EIO" ? [failure] : []);
    }
  });

  it("reports bytes queued in child-process IPC for terminal backpressure", () => {
    const callbacks: Array<(error: Error | null) => void> = [];
    const socket = new PluginSessionSocket({
      send(_message, callback) {
        if (callback) callbacks.push(callback);
        return true;
      },
    });

    socket.send("hello");
    socket.send(new Uint8Array([1, 2, 3]));
    expect(socket.bufferedAmount).toBe(8);

    callbacks[0]?.(null);
    expect(socket.bufferedAmount).toBe(3);
    callbacks[1]?.(null);
    expect(socket.bufferedAmount).toBe(0);
  });
});

import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  inspectOmpSessionHistoryAvailability,
  listOmpImportableSessions,
  readOmpImportSessionConfig,
} from "./session-descriptor.js";

async function writeSession(root: string, relativePath: string, lines: unknown[]): Promise<string> {
  const filePath = path.join(root, "sessions", relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

describe("OMP session descriptor", () => {
  test("classifies missing, malformed, and valid session histories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-availability-"));
    const cwd = path.join(root, "repo");
    const malformedFile = await writeSession(root, "project/malformed.jsonl", [
      { type: "custom", customType: "session_exit" },
    ]);
    const validFile = await writeSession(root, "project/valid.jsonl", [
      { type: "title", title: "Title before header" },
      { type: "session", version: 3, id: "valid-session", cwd },
    ]);

    await expect(
      inspectOmpSessionHistoryAvailability(path.join(root, "sessions", "missing.jsonl")),
    ).resolves.toEqual({ status: "unavailable", reason: "missing" });
    await expect(inspectOmpSessionHistoryAvailability(malformedFile)).resolves.toEqual({
      status: "unavailable",
      reason: "malformed",
    });
    await expect(inspectOmpSessionHistoryAvailability(validFile)).resolves.toEqual({
      status: "available",
    });
  });

  test("cwd filtering continues past the global candidate overscan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-cwd-limit-"));
    const sessionsDir = path.join(root, "sessions");
    const requestedCwd = path.join(root, "requested");
    const otherCwd = path.join(root, "other");
    const requestedFile = await writeSession(root, "requested/requested.jsonl", [
      {
        type: "session",
        id: "requested-session",
        timestamp: "2026-06-01T00:00:00.000Z",
        cwd: requestedCwd,
      },
    ]);
    await utimes(requestedFile, new Date("2026-06-01"), new Date("2026-06-01"));

    await Promise.all(
      Array.from({ length: 400 }, async (_, index) => {
        const file = await writeSession(root, `other/${index}.jsonl`, [
          {
            type: "session",
            id: `other-${index}`,
            timestamp: "2026-06-02T00:00:00.000Z",
            cwd: otherCwd,
          },
        ]);
        await utimes(file, new Date("2026-06-02"), new Date("2026-06-02"));
      }),
    );

    await expect(
      listOmpImportableSessions({ sessionDir: sessionsDir, cwd: requestedCwd, limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({ providerHandleId: requestedFile, cwd: requestedCwd }),
    ]);
  });

  test("lists the complete history beyond the recent window when limit is null", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-all-"));
    try {
      const files = await Promise.all(
        Array.from({ length: 405 }, async (_, index) => {
          const timestamp = new Date(Date.UTC(2026, 5, 1, 0, 0, index));
          const file = await writeSession(root, `project/${index}/session.jsonl`, [
            { type: "session", id: `session-${index}`, timestamp, cwd: root },
          ]);
          await utimes(file, timestamp, timestamp);
          return file;
        }),
      );
      const options = { sessionDir: path.join(root, "sessions") };
      const newestFirst = files.toReversed();
      const recent = await listOmpImportableSessions({ ...options, limit: 15 });
      expect(recent.map((session) => session.providerHandleId)).toEqual(newestFirst.slice(0, 15));
      const all = await listOmpImportableSessions({ ...options, limit: null });
      expect(all.map((session) => session.providerHandleId)).toEqual(newestFirst);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads title-first sessions and OMP combined model identifiers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-title-first-"));
    const cwd = path.join(root, "repo");
    const sessionFile = await writeSession(root, "project/session.jsonl", [
      {
        type: "title",
        id: "title-1",
        timestamp: "2026-06-09T00:00:00.000Z",
        title: "Deploy Paseo and verify",
      },
      {
        type: "session",
        version: 3,
        id: "session-title-first",
        timestamp: "2026-06-09T00:00:00.100Z",
        cwd,
      },
      {
        type: "model_change",
        id: "model-1",
        timestamp: "2026-06-09T00:00:00.200Z",
        model: "openai-codex/gpt-5.1",
      },
      {
        type: "message",
        id: "user-1",
        timestamp: "2026-06-09T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "import me" }] },
      },
    ]);

    await expect(
      listOmpImportableSessions({ sessionDir: path.join(root, "sessions") }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerHandleId: sessionFile,
        cwd,
        title: "Deploy Paseo and verify",
        firstPromptPreview: "import me",
      }),
    ]);
    await expect(readOmpImportSessionConfig(sessionFile)).resolves.toEqual({
      title: "Deploy Paseo and verify",
      model: "openai-codex/gpt-5.1",
    });
  });

  test("derives a bounded conversation title when the native session is unnamed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-unnamed-"));
    const prompt = `Fix the import workflow ${"without changing existing sessions ".repeat(8)}`;
    const sessionFile = await writeSession(root, "project/2026-09-24T00-00-00-session.jsonl", [
      { type: "title", title: "" },
      { type: "session", id: "unnamed-session", cwd: root },
      { type: "message", message: { role: "user", content: prompt } },
    ]);

    await expect(readOmpImportSessionConfig(sessionFile)).resolves.toMatchObject({
      title: prompt.slice(0, 60).trim(),
    });
  });

  test("keeps recent nested OMP subagent sessions importable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-nested-"));
    const cwd = path.join(root, "repo");
    const parent = await writeSession(root, "project/parent.jsonl", [
      { type: "session", id: "parent", timestamp: "2026-06-10T00:00:00.000Z", cwd },
      {
        type: "message",
        id: "parent-user",
        timestamp: "2026-06-10T00:00:01.000Z",
        message: { role: "user", content: "parent prompt" },
      },
    ]);
    const child = await writeSession(root, "project/parent/Explore.jsonl", [
      { type: "session", id: "child", timestamp: "2026-06-09T00:00:00.000Z", cwd },
      {
        type: "message",
        id: "child-user",
        timestamp: "2026-06-09T00:00:01.000Z",
        message: { role: "user", content: "child prompt" },
      },
    ]);
    await utimes(parent, new Date("2026-06-08"), new Date("2026-06-08"));
    await utimes(child, new Date("2026-06-09"), new Date("2026-06-09"));

    await expect(
      listOmpImportableSessions({ sessionDir: path.join(root, "sessions"), limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({
        providerHandleId: child,
        title: "Explore",
        firstPromptPreview: "child prompt",
      }),
    ]);
  });

  test("uses OMP's own default session directory", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-omp-session-home-"));
    const cwd = path.join(home, "repo");
    const sessionFile = path.join(home, ".omp", "agent", "sessions", "project", "session.jsonl");
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", id: "default-dir", timestamp: "2026-06-09", cwd })}\n`,
      "utf8",
    );

    await expect(listOmpImportableSessions({ homeDir: home, env: {} })).resolves.toEqual([
      expect.objectContaining({ providerHandleId: sessionFile, cwd }),
    ]);
  });
});

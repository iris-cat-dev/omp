import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  taskAnalyze,
  taskCommandInfo,
  taskEditHunks,
  taskFailures,
  taskMaskedStatus,
  taskReadResult,
} from "./task-parser.js";
import { OmpTaskLineReader } from "./task-reader.js";

const sha16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

describe("OMP task tool interpretation", () => {
  it("parses POSIX context, wrappers, targeting, pipeline status and shell kinds", () => {
    const command = "bash -lc 'cd sub; env KEY=value npm test -- --grep iso'";
    expect(taskCommandInfo(command, "/work")).toMatchObject({
      class: "test",
      suite: "npm test",
      targeted: true,
      masked: false,
      background: false,
      key: sha16("@sub\x1fnpm\x1frun\x1ftest\x1f--\x1f--grep\x1fiso"),
    });
    expect(taskCommandInfo("set -o pipefail; cargo test | tee log")).toMatchObject({
      class: "test",
      suite: "cargo test",
      masked: false,
    });
    expect(taskCommandInfo("cargo test | tail -20")).toMatchObject({ masked: true });
    expect(taskMaskedStatus("cargo test; echo status:$?", "status:1", null)).toEqual({
      exitCode: 1,
      failed: true,
    });
    expect(taskCommandInfo("pytest &")).toMatchObject({ class: "test", background: true });
    expect(taskAnalyze("BaSh", { command: "git -C folder diff" }).kind).toBe("read");
    expect(taskAnalyze("bash", { command: "grep -R iso src" }).kind).toBe("search");
    expect(taskAnalyze("bash", { command: "sed -i s/a/b/ src/a" }).kind).toBe("command");
    expect(taskAnalyze("mcp__bash", { command: "pytest" }).kind).toBe("other");
    expect(taskCommandInfo("pytest foo:bar").targeted).toBe(false);
  });

  it.each([
    ["python -m pytest tests/a.py", "pytest", true],
    ["cargo nextest run -E test(iso)", "cargo nextest", true],
    ["swift test --filter ISO", "swift test", true],
    ["go test ./...", "go test", false],
    ["dotnet test --filter ISO", "dotnet test", true],
    ["gradle :api:test --tests ISO", "gradle test", true],
    ["mvn verify -DskipTests", "mvn verify", false],
    ["cmake --build . --target test", "cmake --build", true],
    ["npx vitest run tests/a.test.ts", "vitest", true],
    ["bun test -t ISO", "bun test", true],
    ["pnpm run typecheck", "pnpm run typecheck", false],
    ["make check TESTS=iso", "make check", true],
    ["deno test --filter ISO", "deno test", true],
    ["ctest -R ISO", "ctest", true],
  ] as const)("preserves original runner suite for %s", (command, suite, targeted) => {
    expect(taskCommandInfo(command)).toMatchObject({ suite, targeted });
  });

  it("does not turn a masked success, start, timeout or cancellation into a pass", () => {
    const text = "cargo test | tail -10",
      info = taskCommandInfo(text);
    expect(
      taskReadResult(
        { content: [{ type: "text", text: "output" }], details: { exitCode: 0 }, isError: false },
        42,
        text,
        info,
      ).outcome,
    ).toEqual({ exitCode: 0, failed: null, t: 42 });
    for (const details of [
      { status: "running" },
      { async: { type: "bash", jobId: "bg_1", state: "running" } },
      { async: { state: "unknown" } },
      { service: { name: "fixture", ready: true, state: "running" } },
    ])
      expect(taskReadResult({ content: [], details, isError: false }, 42).outcome).toEqual({
        exitCode: null,
        failed: null,
        t: 42,
      });
    expect(
      taskReadResult({ content: [], details: { timedOut: true, exitCode: 124 }, isError: true }, 42)
        .outcome,
    ).toEqual({ exitCode: 124, failed: null, t: 42 });
    expect(
      taskReadResult(
        { content: [{ type: "text", text: "Command aborted by user" }], isError: true },
        42,
      ).outcome,
    ).toEqual({ exitCode: null, failed: null, t: 42 });
    expect(
      taskReadResult({ content: [{ type: "text", text: "Command exited with code 2" }] }, 42)
        .outcome,
    ).toEqual({ exitCode: 2, failed: true, t: 42 });
    expect(
      taskReadResult(
        {
          content: [
            {
              type: "text",
              text: "Backgrounded as job bg_1 (no deadline); its output is injected later.",
            },
          ],
          isError: false,
        },
        42,
      ).outcome.failed,
    ).toBeNull();
  });

  it("normalizes edit reversals, handles Pi/hashline/patch modes, and never invents AST or replacement old text", () => {
    const a = taskEditHunks(
      "edit",
      { path: "/work/src/a.ts", oldText: "context\nold\nend", newText: "context\nnew\nend" },
      "/work",
    )[0]!;
    const b = taskEditHunks(
      "edit",
      { path: "src/a.ts", edits: JSON.stringify([{ oldText: "new", newText: "old" }]) },
      "/work",
    )[0]!;
    expect(a).toEqual({ file: sha16("src/a.ts"), old: sha16("old"), new: sha16("new") });
    expect(b).toEqual({ file: a.file, old: a.new, new: a.old });
    const hunks = taskEditHunks(
      "edit",
      {
        input:
          "*** Begin Patch\n[src/a.ts#ABCD]\nPUT 3.=5:\n+replacement without old\nPUT >5:\n+inserted\nCUT 2*\n*** End Patch",
      },
      "/work",
    );
    expect(hunks).toEqual([{ file: a.file, old: sha16(""), new: sha16("inserted") }]);
    expect(taskEditHunks("ast_edit", { path: "src/a.ts", replacement: "new" })).toEqual([]);
    expect(taskEditHunks("edit", { input: "*** Edit File: src/a.ts\n-old\n+new" })).toEqual([]);
    expect(
      taskEditHunks("edit", {
        path: "src/a.ts",
        edits: [{ op: "update", diff: "@@\n-old\n+new" }],
      }),
    ).toEqual([a]);
    expect(taskEditHunks("write", { path: "src/a.ts", content: "new" })[0]?.old).toBeNull();
  });

  it("preserves exact raw JSON argument digests and the Pi-family guard", () => {
    const reader = new OmpTaskLineReader();
    reader.read('{"type":"session","timestamp":"2026-10-27T10:00:00Z","cwd":"/work"}');
    const rawInput = '{ "path" : "src/a.ts" }';
    reader.read(
      '{"type":"message","id":"response","timestamp":"2026-10-27T10:00:01Z","message":{"role":"assistant","api":"a","provider":"p","model":"m","usage":{},"content":[{"type":"toolCall","id":"call","name":"read","arguments":' +
        rawInput +
        "}]}}",
    );
    reader.read(
      '{"type":"message","id":"unguarded","timestamp":"2026-10-27T10:00:02Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"bad","name":"bash","arguments":{"command":"pytest"}}]}}',
    );
    const events = reader.snapshotEvents(() => true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "action", kind: "read", digest: sha16(rawInput) });
  });
});

describe("Agent Speed failure recognizers", () => {
  const cases: [string, string, string, string][] = [
    [
      "pytest",
      "pytest",
      "FAILED tests/date.py::test_iso - AssertionError\n1 failed, 1 passed in 0.05s",
      "pytest|test|tests/date.py|test_iso|",
    ],
    [
      "unittest",
      "unittest",
      "FAIL: test_iso (tests.date.DateTests)\nRan 2 tests in 0.1s\nFAILED (failures=1)",
      "unittest|test||tests.date.DateTests.test_iso|",
    ],
    [
      "cargo",
      "cargo test",
      "test date::iso ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
      "cargo|test||date::iso|",
    ],
    [
      "rustc",
      "cargo build",
      "error[E0308]: expected date\n --> /work/src/date.rs:14:7\nerror: could not compile `fixture` due to 1 previous error",
      "rustc|error|src/date.rs|E0308|expected date",
    ],
    [
      "xctest",
      "swift test",
      "Test Case '-[DateTests testISO]' failed (0.1 seconds).\nExecuted 2 tests, with 1 failures (0 unexpected) in 0.1 (0.1) seconds",
      "xctest|test||DateTests.testISO|",
    ],
    [
      "go",
      "go test",
      "--- FAIL: TestDate/ISO (0.00s)\n--- PASS: TestDate/Local (0.00s)\nFAIL\tfixture/pkg\t0.01s",
      "go|test||TestDate/ISO|",
    ],
    [
      "jest",
      "jest",
      "FAIL tests/date.test.js\n  ● date > iso\nTest Suites: 1 failed, 1 total\nTests: 1 failed, 1 passed, 2 total",
      "jest|test|tests/date.test.js|date > iso|",
    ],
    [
      "tsc",
      "tsc",
      "src/date.ts(4,2): error TS2322: Type mismatch\nFound 1 error in src/date.ts:4",
      "tsc|error|src/date.ts|TS2322|Type mismatch",
    ],
    [
      "dotnet",
      "dotnet test",
      "Failed DateTests.ISO [12 ms]\nFailed! - Failed: 1, Passed: 1, Skipped: 0, Total: 2",
      "dotnet|test||DateTests.ISO|",
    ],
    [
      "gradle",
      "gradle test",
      "fixture.DateTests > acceptsISO() FAILED\n2 tests completed, 1 failed",
      "junit|test||DateTests.acceptsISO|",
    ],
    [
      "rspec",
      "rspec",
      "rspec ./spec/date_spec.rb:18 # parses ISO\n2 examples, 1 failure",
      "rspec|test|spec/date_spec.rb|parses ISO|",
    ],
    [
      "phpunit",
      "phpunit",
      "There was 1 failure:\n1) DateTests::testISO\nTests: 2, Assertions: 2, Failures: 1.",
      "phpunit|test||DateTests::testISO|",
    ],
    [
      "ctest",
      "ctest",
      "The following tests FAILED:\n\t1 - iso (Failed)\n50% tests passed, 1 tests failed out of 2",
      "ctest|test||iso|",
    ],
    [
      "cc",
      "cc",
      "src/date.c:10:3: error: unknown type name 'date' [-Werror=types]\n1 error generated.",
      "cc|error|src/date.c|-Wtypes|unknown type name 'date'",
    ],
  ];
  it.each(cases)(
    "recognizes %s with stable original canonical fingerprints",
    (framework, suite, output, canonical) => {
      const result = taskFailures({ suite }, output, "/work", true);
      expect(result.fingerprints).toContain(sha16(canonical));
      expect(result.failedCount).toBe(1);
      expect(result.framework).toBe(framework);
    },
  );
  it("leaves missing counts unknown and claims warnings before generic fallback", () => {
    expect(taskFailures({ suite: "pytest" }, "still collecting", null, null)).toEqual({
      fingerprints: [],
      failedCount: null,
      passedCount: null,
      framework: null,
    });
    expect(
      taskFailures({ suite: "tsc" }, "src/a.c:3:2: warning: harmless", null, true).fingerprints,
    ).toEqual([]);
    expect(
      taskFailures({ suite: "cargo build" }, "Finished dev target(s) in 0.1s", null, null),
    ).toMatchObject({ failedCount: 0, passedCount: null, framework: "cargo" });
  });
});

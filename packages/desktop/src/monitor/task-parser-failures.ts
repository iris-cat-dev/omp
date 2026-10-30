// Agent Speed v1.5.0 failure recognizers (MIT), TASK-PARSERS §5. Content is transient; only hashes/counts escape.
import type { MonitorTaskFailures } from "./task-events.js";
import type { TaskCommandInfo } from "./task-parser-shell.js";
import {
  taskCut,
  taskCwd,
  taskLf,
  taskNumber,
  taskRelative,
  taskScalars,
  taskSha16,
  taskTrim,
} from "./task-parser-common.js";

const TMP =
  /(?<![A-Za-z0-9._~/\\-])(?:(?:\/private)?\/var\/folders\/|(?:\/private)?\/tmp\/|[A-Za-z]:[\\/]Users[\\/][^\\/ \t]+[\\/]AppData[\\/]Local[\\/]Temp[\\/])[^ \t'"()[\]{}<>,;|`]*/g;
const HOME =
  /(?<![A-Za-z0-9._~/\\-])(?:\/Users\/[^/ \t'"]+\/|\/home\/[^/ \t'"]+\/|[A-Za-z]:[\\/]Users[\\/][^\\/ \t'"]+[\\/])/g;
export function taskOutputBudget(text: string): string[] {
  const bytes = Buffer.from(taskScalars(text));
  if (bytes.length <= 262_144) return [taskScalars(text)];
  let end = 65_536,
    start = bytes.length - 196_608;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let head = bytes.subarray(0, end).toString("utf8"),
    tail = bytes.subarray(start).toString("utf8");
  if (head.includes("\n")) head = head.slice(0, head.lastIndexOf("\n") + 1);
  if (tail.includes("\n")) tail = tail.slice(tail.indexOf("\n") + 1);
  return [head, tail];
}
function terminalOscEnd(text: string, start: number): number {
  if (text.charCodeAt(start + 1) !== 0x5d) return start;
  let end = start + 2;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code === 0x07) return end + 1;
    if (code === 0x1b) return text.charCodeAt(end + 1) === 0x5c ? end + 2 : end;
    end++;
  }
  return end;
}
function terminalCsiEnd(text: string, start: number): number {
  if (text.charCodeAt(start + 1) !== 0x5b) return start;
  let end = start + 2,
    code = text.charCodeAt(end);
  while (code >= 0x30 && code <= 0x3f) code = text.charCodeAt(++end);
  while (code >= 0x20 && code <= 0x2f) code = text.charCodeAt(++end);
  return code >= 0x40 && code <= 0x7e ? end + 1 : start;
}
function terminalEscapeEnd(text: string, start: number): number {
  const code = text.charCodeAt(start + 1);
  return (code >= 0x40 && code <= 0x5a) || (code >= 0x5c && code <= 0x5f) ? start + 2 : start;
}
function stripTerminalCodes(
  text: string,
  sequenceEnd: (text: string, start: number) => number,
): string {
  let result = "",
    kept = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 0x1b) continue;
    const end = sequenceEnd(text, i);
    if (end === i) continue;
    result += text.slice(kept, i);
    kept = end;
    i = end - 1;
  }
  return kept ? result + text.slice(kept) : text;
}
function stripControls(text: string): string {
  let result = "",
    kept = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x7f || (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      result += text.slice(kept, i);
      kept = i + 1;
    }
  }
  return kept ? result + text.slice(kept) : text;
}
function cleanLines(text: string): string[] {
  // Keep the OSC, CSI and two-byte escape passes ordered: stripping can join escape fragments.
  const oscStripped = stripTerminalCodes(text, terminalOscEnd),
    csiStripped = stripTerminalCodes(oscStripped, terminalCsiEnd);
  const lines = stripControls(taskLf(stripTerminalCodes(csiStripped, terminalEscapeEnd)))
    .replace(/[\u0085\u2028\u2029]/g, " ")
    .split("\n")
    .map((line) => taskCut(line.replace(/[ \t]+$/, ""), 2000));
  const prefix =
    /^((?:@[A-Za-z0-9._-]+\/|[A-Za-z0-9._-]*\/)[A-Za-z0-9._/-]* [A-Za-z][A-Za-z0-9:._-]*|@?[A-Za-z0-9._/-]+:[A-Za-z][A-Za-z0-9._-]*): ?/;
  const prefixCounts = new Map<string, number>();
  for (const line of lines) {
    const m = prefix.exec(line);
    if (
      m &&
      (m[0].length === line.length ||
        line.slice(m[1].length + 1, m[1].length + 2) === " " ||
        line.slice(m[1].length + 1, m[1].length + 2) === "")
    )
      prefixCounts.set(m[1], (prefixCounts.get(m[1]) ?? 0) + 1);
  }
  return lines.map((line) => {
    const m = prefix.exec(line);
    return m &&
      (prefixCounts.get(m[1]) ?? 0) >= 3 &&
      [" ", ""].includes(line.slice(m[1].length + 1, m[1].length + 2))
      ? line.slice(m[1].length + 1).replace(/^ /, "")
      : line;
  });
}
function stripCwd(text: string, cwd: string | null): string {
  const root = taskCwd(cwd);
  if (!root) return text;
  const body =
    root
      .split("/")
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\\\/]") + "[\\\\/]";
  return text.replace(
    new RegExp("(?<![A-Za-z0-9._~/\\\\-])" + body, /^[A-Za-z]:\//.test(root + "/") ? "gi" : "g"),
    "",
  );
}
function mask(text: string, cwd: string | null, name = false): string {
  let t = stripCwd(text.replace(TMP, "<tmp>"), cwd).replace(HOME, "~/");
  if (!name)
    t = t
      .replace(
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        "<uuid>",
      )
      .replace(
        /[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:[.,][0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?/g,
        "<time>",
      )
      .replace(/(?<![0-9])[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:[.,][0-9]+)?(?![0-9])/g, "<time>")
      .replace(/(?<![0-9])[0-9]{4}-[0-9]{2}-[0-9]{2}(?![0-9])/g, "<date>")
      .replace(/0x[0-9A-Fa-f]+/g, "0x?")
      .replace(/(\.[A-Za-z][A-Za-z0-9+]{0,9}):\[[0-9]+,[0-9]+\]/g, "$1:[N]")
      .replace(/(\.[A-Za-z][A-Za-z0-9+]{0,9}):[0-9]+(?::[0-9]+)?/g, "$1:N")
      .replace(/(\.[A-Za-z][A-Za-z0-9+]{0,9})\([0-9]+(?:,[0-9]+)?\)/g, "$1(N)")
      .replace(
        /(?<![A-Za-z0-9_])(line|Line|LINE|lines|col|column|Column|col\.)( ?)[0-9]+(?![0-9])/g,
        "$1$2N",
      )
      .replace(
        /(?<![A-Za-z0-9_.])[0-9]+(?:\.[0-9]+)? ?(?:ns|us|\u00b5s|ms|s|sec|secs|seconds|second|m|min|mins|minutes|minute|h|hr|hrs|hours|hour)(?![A-Za-z0-9_])/g,
        "<dur>",
      )
      .replace(/(?<![A-Za-z0-9_])[0-9A-Fa-f]{8,}(?![A-Za-z0-9_])/g, "<hex>")
      .replace(/(?<![A-Za-z0-9_])(pid|PID|port)([ =:#]+)[0-9]+/g, "$1 N");
  return taskCut(t.replace(/[ \t]+/g, " ").replace(/^ +| +$/g, ""), 200);
}
function normFile(text: string, cwd: string | null): string {
  let p = taskTrim(text).replace(/^['"`]+|['"`]+$/g, "");
  if (p.startsWith("file://")) p = p.slice(7);
  p = taskRelative(p.replace(/\\/g, "/").replace(TMP, "<tmp>"), cwd)[0]
    .replace(HOME, "~/")
    .replace(/\/{2,}/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  return p;
}
function counts(text: string, separator = ","): Record<string, number> {
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const part of text.split(separator)) {
    const m = /^[ \t]*([0-9]+) ([A-Za-z][A-Za-z ]*?)[ \t]*$/.exec(part);
    if (m) result[m[2]] = (result[m[2]] ?? 0) + taskNumber(m[1]);
  }
  return result;
}
interface Summary {
  framework: string;
  family: "test" | "error";
  failed: number | null;
  passed: number | null;
  sum: boolean;
}
class Found {
  fingerprints: string[] = [];
  summaries: Summary[] = [];
  constructor(readonly cwd: string | null) {}
  error(framework: string, file: string, code: string, message: string): void {
    this.fingerprints.push(
      [
        framework,
        "error",
        file ? normFile(file, this.cwd) : "",
        code || "",
        message ? mask(message, this.cwd) : "",
      ].join("|"),
    );
  }
  test(framework: string, name: string, file = ""): void {
    this.fingerprints.push(
      [
        framework,
        "test",
        file ? normFile(file, this.cwd) : "",
        mask(name, this.cwd, true),
        "",
      ].join("|"),
    );
  }
  summary(
    framework: string,
    family: "test" | "error",
    failed: number | null,
    passed: number | null,
    sum = false,
  ): void {
    this.summaries.push({ framework, family, failed, passed, sum });
  }
}
type Step = (lines: string[], index: number) => number;
function recognizers(f: Found): { steps: Step[]; finish: () => void } {
  let unittestRan: number | null = null,
    cargoList = false;
  const pytest: Step = (lines, i) => {
    const l = lines[i];
    let m = /^(?:\[gw[0-9]+\] \[ *[0-9]+%\] )?(FAILED|ERROR) (?!\()([^ ]+?)(?: - (.*))?$/.exec(l),
      node = m?.[2];
    if (!m) {
      m = /^([^ ]+::.+?) (FAILED|ERROR)(?: +\[ *[0-9]+%\])?$/.exec(l);
      node = m?.[1];
    }
    if (node !== undefined) {
      const at = node.indexOf("::");
      f.test("pytest", at < 0 ? "" : node.slice(at + 2), at < 0 ? node : node.slice(0, at));
      return 1;
    }
    m =
      /^(?:=+ )?((?:[0-9]+ (?:failed|passed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun|reruns|subtests passed|subtests failed)(?:, )?)+) in [0-9]+(?:\.[0-9]+)?s(?: \([0-9:.]+\))?(?: =+)?$/.exec(
        l,
      );
    if (m) {
      const c = counts(m[1]);
      f.summary(
        "pytest",
        "test",
        (c.failed ?? 0) + (c.error ?? 0) + (c.errors ?? 0),
        c.passed ?? 0,
      );
      return 1;
    }
    if (/^(?:=+ )?no tests ran in [0-9]+(?:\.[0-9]+)?s(?: =+)?$/.test(l)) {
      f.summary("pytest", "test", 0, 0);
      return 1;
    }
    return 0;
  };
  const unittest: Step = (lines, i) => {
    const l = lines[i];
    let m =
      /^(FAIL|ERROR|UNEXPECTED SUCCESS): ([A-Za-z_][A-Za-z0-9_]*) \(([A-Za-z0-9_.]+)\)(?: .*)?$/.exec(
        l,
      );
    if (m) {
      f.test("unittest", m[3].endsWith("." + m[2]) ? m[3] : m[3] + "." + m[2]);
      return 1;
    }
    m = /^Ran ([0-9]+) tests? in [0-9]+(?:\.[0-9]+)?s$/.exec(l);
    if (m) {
      unittestRan = taskNumber(m[1]);
      return 1;
    }
    if (unittestRan !== null && (m = /^(?:OK(?: \((.*)\))?|FAILED \((.*)\))$/.exec(l))) {
      const c: Record<string, number> = {};
      for (const part of (m[1] ?? m[2] ?? "").split(",")) {
        const kv = /^[ \t]*([a-z ]+)=([0-9]+)[ \t]*$/.exec(part);
        if (kv) c[kv[1]] = taskNumber(kv[2]);
      }
      const failed = (c.failures ?? 0) + (c.errors ?? 0) + (c["unexpected successes"] ?? 0);
      f.summary(
        "unittest",
        "test",
        failed,
        Math.max(0, unittestRan - failed - (c.skipped ?? 0) - (c["expected failures"] ?? 0)),
      );
      unittestRan = null;
      return 1;
    }
    return 0;
  };
  const cargo: Step = (lines, i) => {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if (cargoList) {
      m = /^    ([^ ].*)$/.exec(l);
      if (m && !m[1].split(" - ")[0].includes(" ")) {
        f.test("cargo", m[1].replace(/\(line [0-9]+\)/g, "(line N)"));
        return 1;
      }
      cargoList = false;
    }
    m = /^test (.+) \.\.\. (FAILED|ok|ignored(?:, .*)?|bench: .*)$/.exec(l);
    if (m) {
      if (m[2] === "FAILED") f.test("cargo", m[1].replace(/\(line [0-9]+\)/g, "(line N)"));
      return 1;
    }
    m = /^---- (.+) (?:stdout|stderr) ----$/.exec(l);
    if (m) {
      f.test("cargo", m[1].replace(/\(line [0-9]+\)/g, "(line N)"));
      return 1;
    }
    m =
      /^test result: (?:ok|FAILED)\. ([0-9]+) passed; ([0-9]+) failed; ([0-9]+) ignored; ([0-9]+) measured; ([0-9]+) filtered out(?:; finished in .*)?$/.exec(
        l,
      );
    if (m) {
      f.summary("cargo", "test", taskNumber(m[2]), taskNumber(m[1]), true);
      return 1;
    }
    if (l === "failures:" && /^    ([^ ].*)$/.test(lines[i + 1] ?? "")) {
      cargoList = true;
      return 1;
    }
    m =
      /^ *(?:FAIL|SIGSEGV|SIGABRT|SIGKILL|SIGBUS|TIMEOUT|LEAK-FAIL|ABORT) \[ *[0-9.]+m?s\] (?:\( *[0-9]+\/[0-9]+\) )?([^ ]+) (.+)$/.exec(
        l,
      );
    if (m) {
      f.test("cargo", m[2].replace(/\(line [0-9]+\)/g, "(line N)"));
      return 1;
    }
    if (/^ *(?:PASS|SKIP|LEAK|SLOW|FLAKY|START|RETRY|TRY [0-9]+ [A-Z-]+) \[.*$/.test(l)) return 1;
    m = /^ *Summary \[[^\]]*\] +([0-9]+) tests? run: (.*)$/.exec(l);
    if (m) {
      const c = counts(m[2].replace(/ \([^)]*\)/g, ""));
      f.summary(
        "nextest",
        "test",
        (c.failed ?? 0) +
          (c["timed out"] ?? 0) +
          (c["exec failed"] ?? 0) +
          (c["leaky failed"] ?? 0),
        c.passed ?? 0,
      );
      return 1;
    }
    return 0;
  };
  const rustc: Step = (lines, i) => {
    const l = lines[i];
    let m =
      /^error: could not compile `[^`]+`(?: \([^)]*\))?(?:;.*)?(?: due to ([0-9]+) previous errors?| due to previous error)?(?:;.*)?$/.exec(
        l,
      ) ?? /^error: aborting due to (?:([0-9]+) )?previous errors?(?:;.*)?$/.exec(l);
    if (m) {
      f.summary("rustc", "error", taskNumber(m[1] ?? "1"), null, true);
      return 1;
    }
    if (
      /^error: (?:test failed|build failed|failed to run|[0-9]+ targets? failed|process didn't exit successfully|Recipe ).*$/.test(
        l,
      )
    )
      return 1;
    m = /^error(?:\[(E[0-9]{4})\])?: (.+)$/.exec(l);
    const warning = /^warning(?:\[[A-Za-z0-9_:]+\])?: .+$/.test(l);
    if (m || warning)
      for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
        const loc = /^ *--> (.+?):([0-9]+):([0-9]+)$/.exec(lines[k]);
        if (loc) {
          if (m) f.error("rustc", loc[1], m[1] ?? "", m[2]);
          return k - i + 1;
        }
        if (/^(?:error(?:\[E[0-9]{4}\])?|warning(?:\[[A-Za-z0-9_:]+\])?): .+$/.test(lines[k]))
          break;
      }
    return 0;
  };
  const stFailed = new Set<string>(),
    xcFailed = new Set<string>();
  let swiftList = false,
    swiftCommands = false;
  const xcId = (name: string): string =>
    name
      .replace(/^-\[|\]$/g, "")
      .replace(/[ /]/g, ".")
      .replace(/\(\)/g, "")
      .split(".")
      .filter(Boolean)
      .slice(-2)
      .join(".");
  const swiftContext = (l: string): number => {
    let m: RegExpExecArray | null;
    if (swiftList) {
      m = /^[ \t]+(.+?)(?: \(.*\))?$/.exec(l);
      if (m) {
        if (!m[1].endsWith(":")) {
          const t = xcId(m[1]);
          xcFailed.add(t);
          f.test("xctest", t);
        }
        return 1;
      }
      swiftList = false;
    }
    if (swiftCommands) {
      m = /^\(([0-9]+) failures?\)$/.exec(l);
      if (m) {
        f.summary("xcodebuild", "error", taskNumber(m[1]), null);
        swiftCommands = false;
        return 1;
      }
      if (/^[ \t]/.test(l)) return 1;
      swiftCommands = false;
    }
    return 0;
  };
  const swiftTesting = (l: string): number => {
    let m: RegExpExecArray | null;
    m =
      /^[^ \tA-Za-z0-9]+ Test (.+?) failed after [0-9]+(?:\.[0-9]+)? seconds(?: with [0-9]+ issues?)?(?: \(including [0-9]+ known issues?\))?\.$/.exec(
        l,
      );
    if (m && !m[1].startsWith("run with ")) {
      const t = m[1].replace(/ with [0-9]+ test cases?$/, "");
      stFailed.add(t);
      f.test("swift-testing", t);
      return 1;
    }
    m =
      /^[^ \tA-Za-z0-9]+ Test run with ([0-9]+) tests?(?: in [0-9]+ suites?)? (passed|failed) after [0-9]+(?:\.[0-9]+)? seconds(?: with ([0-9]+) issues?)?(?: \(including [0-9]+ known issues?\))?\.$/.exec(
        l,
      );
    if (m) {
      const total = taskNumber(m[1]),
        failed = m[2] === "passed" ? 0 : stFailed.size || taskNumber(m[3] ?? "1");
      f.summary("swift-testing", "test", failed, Math.max(0, total - failed));
      return 1;
    }
    if (
      /^[^ \tA-Za-z0-9]+ (?:Test .+? recorded an issue.*|Test .+? (?:passed after .*|started\.|skipped.*)|Suite .+? (?:passed|failed|started).*|Test run started\.|Testing Library Version: .*|Target Platform: .*)$/.test(
        l,
      )
    )
      return 1;
    return 0;
  };
  const xctest = (l: string): number => {
    let m: RegExpExecArray | null;
    m =
      /^Test [Cc]ase '(-\[[^\]]+\]|[^']+)' (failed|passed|started|skipped)(?: on '[^']*')?(?: \([0-9.]+ seconds\))?\.?$/.exec(
        l,
      );
    if (m) {
      if (m[2] === "failed") {
        const t = xcId(m[1]);
        xcFailed.add(t);
        f.test("xctest", t);
      }
      return 1;
    }
    m = /^(.+?):([0-9]+): error: (-\[[^\]]+\]|[A-Za-z0-9_.()/]+) : .*$/.exec(l);
    if (m) {
      const t = xcId(m[3]);
      xcFailed.add(t);
      f.test("xctest", t);
      return 1;
    }
    if (/^Test [Ss]uite '.+' (?:started|passed|failed).*$/.test(l)) return 1;
    m =
      /^[ \t]*Executed ([0-9]+) tests?, with (?:([0-9]+) tests? skipped and )?([0-9]+) failures? \(([0-9]+) unexpected\) in [0-9.]+ \([0-9.]+\) seconds$/.exec(
        l,
      );
    if (m) {
      const failed = xcFailed.size || taskNumber(m[3]);
      f.summary(
        "xctest",
        "test",
        failed,
        Math.max(0, taskNumber(m[1]) - failed - taskNumber(m[2] ?? "0")),
      );
      return 1;
    }
    if (l === "Failing tests:") {
      swiftList = true;
      return 1;
    }
    return 0;
  };
  const swiftBuild = (l: string): number => {
    let m: RegExpExecArray | null;
    if (
      /^\*\* (?:TEST|BUILD|ANALYZE|ARCHIVE|CLEAN|TEST BUILD|INSTALL) (?:FAILED|SUCCEEDED|INTERRUPTED) \*\*$/.test(
        l,
      )
    )
      return 1;
    if (l === "The following build commands failed:") {
      swiftCommands = true;
      return 1;
    }
    m = /^(.+\.swift):([0-9]+):([0-9]+): error: (.+)$/.exec(l);
    if (m) {
      f.error("swiftc", m[1], "", m[4]);
      return 1;
    }
    return /^(?:.+\.swift:[0-9]+:[0-9]+: (?:warning|note): .+|error: (?:emit-module command failed|fatalError|compile command failed|link command failed).*)$/.test(
      l,
    )
      ? 1
      : 0;
  };
  const swift: Step = (lines, i) => {
    const l = lines[i];
    return swiftContext(l) || swiftTesting(l) || xctest(l) || swiftBuild(l);
  };
  const goFailed = new Set<string>(),
    goPassed = new Set<string>();
  let goOk = 0,
    goPkgs = 0,
    goBroken = 0;
  const go: Step = (lines, i) => {
    const l = lines[i];
    let m = /^[ \t]*--- FAIL: ([^ ]+) \([0-9.]+s\)$/.exec(l);
    if (m) {
      goFailed.add(m[1]);
      f.test("go", m[1]);
      return 1;
    }
    m = /^[ \t]*--- (PASS|SKIP): ([^ ]+) \([0-9.]+s\)$/.exec(l);
    if (m) {
      if (m[1] === "PASS") goPassed.add(m[2]);
      return 1;
    }
    if (
      /^(?:=== (?:RUN|PAUSE|CONT|NAME) .*|FAIL|PASS|\?[ \t]+[^ \t]+[ \t]+\[no test files\]|# [^ ]+(?: \[[^\]]+\])?)$/.test(
        l,
      )
    )
      return 1;
    m = /^(FAIL|ok)[ \t]+([^ \t]+)[ \t]+(?:[0-9.]+s|\(cached\)|\[([^\]]+)\])(?:[ \t].*)?$/.exec(l);
    if (m) {
      goPkgs++;
      if (m[1] === "ok") goOk++;
      else if (["build failed", "setup failed"].includes(m[3])) goBroken++;
      return 1;
    }
    m = /^([^ \t][^ \t:]*\.go):([0-9]+)(?::([0-9]+))?: (.+)$/.exec(l);
    if (m) {
      f.error("go", m[1], "", m[4]);
      return 1;
    }
    return 0;
  };
  let jestFile = "",
    vitestFile = "",
    jestTests: Record<string, number> | null = null,
    jestSuites: Record<string, number> | null = null,
    vitestTests: Record<string, number> | null = null,
    vitestFiles: Record<string, number> | null = null,
    mochaPassing: number | null = null,
    mochaFailing: number | null = null,
    mochaDetails = false;
  const bun: Record<string, number> = {};
  const flush = (
    framework: string,
    tests: Record<string, number> | null,
    files: Record<string, number> | null,
  ): void => {
    if (!tests && !files) return;
    f.summary(framework, "test", tests?.failed || files?.failed || 0, tests?.passed ?? 0, true);
  };
  const mochaDetail: Step = (lines, i) => {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if (mochaDetails && (m = /^([ \t]*)([0-9]+)\) (.*)$/.exec(l))) {
      const parts = [m[3]];
      let k = i;
      while (
        !parts.at(-1)!.endsWith(":") &&
        k + 1 < lines.length &&
        taskTrim(lines[k + 1]) &&
        lines[k + 1].length - lines[k + 1].replace(/^ +/, "").length > m[1].length
      )
        parts.push(taskTrim(lines[++k]));
      const title = parts.map(taskTrim).join(" ");
      if (title.endsWith(":")) {
        f.test("mocha", title.slice(0, -1));
        return k - i + 1;
      }
    }
    return 0;
  };
  const jestVitest = (l: string): number => {
    let m: RegExpExecArray | null;
    m = /^ *FAIL +([^ ]+) \[ (.+) \]$/.exec(l);
    if (m) {
      f.test("vitest", "", m[1]);
      return 1;
    }
    m = /^ *FAIL +(.+?) > (.+?)(?: \[[^\]]*\])?$/.exec(l);
    if (m) {
      f.test("vitest", m[2], m[1]);
      return 1;
    }
    m = /^ ?(FAIL|PASS) +([^ ]+)(?: \([0-9.]+ ?m?s\))?$/.exec(l);
    if (m) {
      jestFile = m[1] === "FAIL" ? m[2] : "";
      return 1;
    }
    m = /^  ● (.+)$/.exec(l);
    if (m) {
      if (m[1] !== "Console") f.test("jest", m[1], jestFile);
      return 1;
    }
    m = /^Test Suites:[ \t]+(.*[0-9]+ total)$/.exec(l);
    if (m) {
      flush("jest", jestTests, jestSuites);
      jestTests = null;
      jestSuites = counts(m[1]);
      return 1;
    }
    m = /^Tests:[ \t]+(.*[0-9]+ total)$/.exec(l);
    if (m) {
      jestTests = counts(m[1]);
      flush("jest", jestTests, jestSuites);
      jestTests = jestSuites = null;
      return 1;
    }
    if (
      /^(?:(?:Snapshots:|Time:|Ran all test suites).*|[ \t]+[✓✕○✎] .*|Summary of all failing tests)$/.test(
        l,
      )
    )
      return 1;
    m = /^ *[❯>✓] ([^ ]+) \([0-9]+ tests?(?: \|.*)?\)(?: [0-9.]+m?s)?$/.exec(l);
    if (m) {
      vitestFile = m[1];
      return 1;
    }
    m = /^ +[×✗] (.+?)(?: [0-9.]+m?s)?$/.exec(l);
    if (m && vitestFile) {
      f.test("vitest", m[1], vitestFile);
      return 1;
    }
    m = /^ *Test Files +(.+?) \(([0-9]+)\)$/.exec(l);
    if (m) {
      flush("vitest", vitestTests, vitestFiles);
      vitestTests = null;
      vitestFiles = counts(m[1], "|");
      return 1;
    }
    m = /^ *Tests +(.+?) \(([0-9]+)\)$/.exec(l);
    if (m) {
      vitestTests = counts(m[1], "|");
      flush("vitest", vitestTests, vitestFiles);
      vitestTests = vitestFiles = null;
      return 1;
    }
    return 0;
  };
  const jsOther = (l: string): number => {
    let m: RegExpExecArray | null;
    m = /^[ \t]*([0-9]+) passing \([0-9a-z.]+\)$/.exec(l);
    if (m) {
      mochaPassing = taskNumber(m[1]);
      return 1;
    }
    m = /^[ \t]*([0-9]+) failing$/.exec(l);
    if (m) {
      mochaFailing = taskNumber(m[1]);
      mochaDetails = true;
      return 1;
    }
    if (/^[ \t]*([0-9]+) pending$/.test(l)) return 1;
    m = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?$/.exec(l);
    if (m) {
      f.test("bun", m[1]);
      return 1;
    }
    m = /^ *([0-9]+) (pass|fail)$/.exec(l);
    if (m) {
      bun[m[2]] = taskNumber(m[1]);
      return 1;
    }
    m =
      /^(?:ok|FAILED) \| ([0-9]+) passed(?: \([0-9]+ steps?\))? \| ([0-9]+) failed(?: \([0-9]+ steps?\))?.*$/.exec(
        l,
      );
    if (m) {
      f.summary("deno", "test", taskNumber(m[2]), taskNumber(m[1]));
      return 1;
    }
    m = /^(.+?) => (.+?):[0-9]+:[0-9]+$/.exec(l);
    if (m) {
      f.test("deno", m[1], m[2]);
      return 1;
    }
    return 0;
  };
  const js: Step = (lines, i) => {
    const l = lines[i];
    return mochaDetail(lines, i) || jestVitest(l) || jsOther(l);
  };
  let eslintFile: string | null = null,
    tscTable = false;
  const tscAndFoundErrors = (l: string): number => {
    let m: RegExpExecArray | null;
    if (tscTable) {
      if (/^[ \t]+[0-9]+[ \t]+.+:[0-9]+$/.test(l)) return 1;
      tscTable = false;
    }
    m =
      /^(.+?)\(([0-9]+),([0-9]+)\): error (TS[0-9]+): (.*)$/.exec(l) ??
      /^(.+?):([0-9]+):([0-9]+) - error (TS[0-9]+): (.*)$/.exec(l);
    if (m) {
      f.error("tsc", m[1], m[4], m[5]);
      return 1;
    }
    m =
      /^Found ([0-9]+) errors? in [0-9]+ files? \((?:checked [0-9]+ source files?|errors prevented further checking)\)$/.exec(
        l,
      );
    if (m) {
      f.summary("mypy", "error", taskNumber(m[1]), null);
      return 1;
    }
    m = /^Found ([0-9]+) errors? in .*$/.exec(l);
    if (m) {
      f.summary("tsc", "error", taskNumber(m[1]), null);
      return 1;
    }
    m = /^Found ([0-9]+) errors?(?: \(([0-9]+) fixed, ([0-9]+) remaining\))?\.$/.exec(l);
    if (m) {
      f.summary("found-errors", "error", taskNumber(m[3] ?? m[1]), null);
      return 1;
    }
    if (/^Errors +Files$/.test(l)) {
      tscTable = true;
      return 1;
    }
    return 0;
  };
  const eslint: Step = (lines, i) => {
    const l = lines[i];
    let m: RegExpExecArray | null;
    m = /^(.+?):([0-9]+):([0-9]+): (.+) \[(Error|Warning)\/(.+)\]$/.exec(l);
    if (m) {
      if (m[5] === "Error") f.error("eslint", m[1], m[6], m[4]);
      return 1;
    }
    const eslintMsg =
      /^[ \t]+([0-9]+):([0-9]+)[ \t]+(error|warning)[ \t]+(.+?)(?:[ \t]{2,}([^ \t]+))?$/;
    if (/^(?:\/[^:]*|[A-Za-z]:[\\/][^:]*)$/.test(l) && eslintMsg.test(lines[i + 1] ?? "")) {
      eslintFile = l;
      return 1;
    }
    if (eslintFile !== null && (m = eslintMsg.exec(l))) {
      if (m[3] === "error") f.error("eslint", eslintFile, m[5] ?? "", m[4]);
      return 1;
    }
    m = /^✖ ([0-9]+) problems? \(([0-9]+) errors?, ([0-9]+) warnings?\)$/.exec(l);
    if (m) {
      f.summary("eslint", "error", taskNumber(m[2]), null);
      return 1;
    }
    if (/^[ \t]+[0-9]+ errors? and [0-9]+ warnings? potentially fixable.*$/.test(l)) return 1;
    return 0;
  };
  const ruff: Step = (lines, i) => {
    const l = lines[i];
    let m: RegExpExecArray | null;
    m =
      /^(.+?\.(?:py|pyi|ipynb)):([0-9]+):([0-9]+): ([A-Z]+[0-9]+|SyntaxError|invalid-syntax):? (?:\[\*\] )?(.*)$/.exec(
        l,
      );
    if (m) {
      f.error("ruff", m[1], m[4], m[5]);
      return 1;
    }
    m = /^([A-Z]{1,4}[0-9]{1,4}|invalid-syntax|SyntaxError):? (?:\[\*\] )?(.+)$/.exec(l);
    if (m)
      for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
        const loc = /^ *--> (.+?):([0-9]+):([0-9]+)$/.exec(lines[k]);
        if (loc) {
          f.error("ruff", loc[1], m[1], m[2]);
          return k - i + 1;
        }
      }
    if (l === "All checks passed!") {
      f.summary("ruff", "error", 0, null);
      return 1;
    }
    m = /^Would reformat: (.+)$/.exec(l);
    if (m) {
      f.error("ruff", m[1], "format", "");
      return 1;
    }
    return 0;
  };
  const pythonFormatAndMypy = (l: string): number => {
    let m: RegExpExecArray | null;
    m = /^would reformat (.+)$/.exec(l);
    if (m) {
      f.error("black", m[1], "format", "");
      return 1;
    }
    m =
      /^(?:Oh no! .*)?([0-9]+) files? would be reformatted(?:, [0-9]+ files? (?:already formatted|would be left unchanged))?\.?$/.exec(
        l,
      );
    if (m) {
      f.summary("format", "error", taskNumber(m[1]), null);
      return 1;
    }
    m = /^(.+?\.pyi?):([0-9]+)(?::([0-9]+))?: error: (.+?)(?:  \[([a-z0-9-]+)\])?$/.exec(l);
    if (m) {
      f.error("mypy", m[1], m[5] ?? "", m[4]);
      return 1;
    }
    if (/^.+?\.pyi?:[0-9]+(?::[0-9]+)?: note: .*$/.test(l)) return 1;
    if (/^Success: no issues found in [0-9]+ source files?$/.test(l)) {
      f.summary("mypy", "error", 0, null);
      return 1;
    }
    return 0;
  };
  const pyright: Step = (lines, i) => {
    const l = lines[i];
    let m: RegExpExecArray | null;
    const pyError = /^[ \t]*(.+?):([0-9]+):([0-9]+) - error: (.+?)(?: \((report[A-Za-z]+)\))?$/,
      pyOther = /^[ \t]*(.+?):([0-9]+):([0-9]+) - (?:warning|information|info|note): .*$/;
    m = pyError.exec(l);
    if (m) {
      const indent = l.length - l.replace(/^[ \t]+/, "").length;
      let k = i,
        code = m[5] ?? "";
      while (
        k + 1 < lines.length &&
        lines[k + 1].length - lines[k + 1].replace(/^[ \t]+/, "").length > indent &&
        !pyError.test(lines[k + 1]) &&
        !pyOther.test(lines[k + 1])
      )
        k++;
      if (k > i && !code) code = / \((report[A-Za-z]+)\)$/.exec(lines[k])?.[1] ?? "";
      f.error("pyright", m[1], code, m[4].replace(/ \((report[A-Za-z]+)\)$/, ""));
      return k - i + 1;
    }
    if (pyOther.test(l)) return 1;
    m = /^([0-9]+) errors?, ([0-9]+) warnings?, ([0-9]+) (?:informations?|infos?|notes?) ?$/.exec(
      l,
    );
    if (m) {
      f.summary("pyright", "error", taskNumber(m[1]), null);
      return 1;
    }
    return 0;
  };
  const checkers: Step = (lines, i) => {
    const l = lines[i];
    return (
      tscAndFoundErrors(l) ||
      eslint(lines, i) ||
      ruff(lines, i) ||
      pythonFormatAndMypy(l) ||
      pyright(lines, i)
    );
  };
  const dotnet: Step = (lines, i) => {
    const l = lines[i];
    let m =
      /^[ \t]*(.+?)\(([0-9]+)(?:,([0-9]+))?(?:,[0-9]+,[0-9]+)?\): error ([A-Za-z]+[0-9]+): (.*?)(?: \[([^\]]+)\])?$/.exec(
        l,
      );
    if (m) {
      f.error("msbuild", m[1], m[4], m[5]);
      return 1;
    }
    m = /^[ \t]*([A-Za-z][A-Za-z0-9_.-]*) : error ([A-Za-z]+[0-9]+): (.*?)(?: \[([^\]]+)\])?$/.exec(
      l,
    );
    if (m) {
      f.error("msbuild", "", m[2], m[3]);
      return 1;
    }
    if (
      /^(?:[ \t]*.+?(?:\([0-9,]+\))? : warning [A-Za-z]+[0-9]+: .*|[ \t]*.+?\([0-9,]+\): warning [A-Za-z]+[0-9]+: .*)$/.test(
        l,
      )
    )
      return 1;
    m = /^[ \t]*([0-9]+) Error\(s\)$/.exec(l);
    if (m) {
      f.summary("msbuild", "error", taskNumber(m[1]), null);
      return 1;
    }
    m =
      /^Build (?:failed|succeeded)(?: with ([0-9]+) error\(s\)(?: and [0-9]+ warning\(s\))?)?(?: and [0-9]+ warning\(s\))? in [0-9.]+s$/.exec(
        l,
      );
    if (m) {
      if (m[1]) f.summary("msbuild", "error", taskNumber(m[1]), null);
      return 1;
    }
    if (/^(?:[ \t]*[0-9]+ Warning\(s\)|Build FAILED\.|Build succeeded\.|Time Elapsed .*)$/.test(l))
      return 1;
    m = /^[ \t]*Failed ([^ ]+) \[[^\]]*\]$/.exec(l);
    if (m) {
      f.test("dotnet", m[1]);
      return 1;
    }
    if (/^[ \t]*(?:Passed|Skipped) ([^ ]+) \[[^\]]*\]$/.test(l)) return 1;
    m =
      /^(?:Failed|Passed)![ \t]*-[ \t]*Failed:[ \t]*([0-9]+),[ \t]*Passed:[ \t]*([0-9]+),[ \t]*Skipped:[ \t]*([0-9]+),[ \t]*Total:[ \t]*([0-9]+).*$/.exec(
        l,
      );
    if (m) {
      f.summary("dotnet", "test", taskNumber(m[1]), taskNumber(m[2]), true);
      return 1;
    }
    m =
      /^[ \t]*Test summary: total: ([0-9]+), failed: ([0-9]+), succeeded: ([0-9]+), skipped: ([0-9]+).*$/.exec(
        l,
      );
    if (m) {
      f.summary("dotnet-mtp", "test", taskNumber(m[2]), taskNumber(m[3]));
      return 1;
    }
    m = /^[ \t]*failed (.+?) \([0-9.]+m?s\)$/.exec(l);
    if (m) {
      f.test("dotnet", m[1]);
      return 1;
    }
    return 0;
  };
  let junitList = false;
  const junitId = (cls: string, method: string): string =>
    cls.split(".").at(-1)! + "." + method.replace(/\(\)$/, "");
  const surefireRun =
    /^\[(?:ERROR|WARNING|INFO)\] Tests run: ([0-9]+), Failures: ([0-9]+), Errors: ([0-9]+), Skipped: ([0-9]+)(?:, Flakes: [0-9]+)?(.*)$/;
  const junitListing = (l: string): number => {
    let m: RegExpExecArray | null;
    if (junitList) {
      if (surefireRun.test(l) || l.startsWith("[INFO]") || ["[ERROR] ", "[ERROR]"].includes(l))
        junitList = false;
      else {
        m = /^\[ERROR\][ \t]+([A-Za-z0-9_$]+)\.([A-Za-z0-9_$[\]]+)(?::[0-9]+)?(?:[ \t].*)?$/.exec(
          l,
        );
        if (m && !l.startsWith("[ERROR]   Run ")) {
          f.test("junit", junitId(m[1], m[2]));
          return 1;
        }
        if (l.startsWith("[ERROR]") || l.startsWith("[WARNING]")) return 1;
        junitList = false;
      }
    }
    return 0;
  };
  const gradle = (l: string): number => {
    let m: RegExpExecArray | null;
    m = /^([^ ]+) > (.+?) (FAILED|PASSED|SKIPPED)$/.exec(l);
    if (m) {
      if (m[3] === "FAILED") f.test("junit", junitId(m[1], m[2]));
      return 1;
    }
    m = /^([0-9]+) tests? completed, ([0-9]+) failed(?:, ([0-9]+) skipped)?$/.exec(l);
    if (m) {
      const failed = taskNumber(m[2]);
      f.summary(
        "gradle",
        "test",
        failed,
        Math.max(0, taskNumber(m[1]) - failed - taskNumber(m[3] ?? "0")),
        true,
      );
      return 1;
    }
    if (
      /^(?:> Task [^ ]+(?: [A-Z-]+)?|FAILURE: Build failed with an exception\.|BUILD (?:SUCCESSFUL|FAILED) in .*|\* What went wrong:|\* Try:)$/.test(
        l,
      )
    )
      return 1;
    return 0;
  };
  const surefire = (l: string): number => {
    let m: RegExpExecArray | null;
    m =
      /^\[ERROR\] ([A-Za-z0-9_.$]+)\.([A-Za-z0-9_$[\]]+)(?:\(.*\))? -- Time elapsed: .* <<< (?:FAILURE|ERROR)!$/.exec(
        l,
      );
    if (m) {
      f.test("junit", junitId(m[1], m[2]));
      return 1;
    }
    m =
      /^(?:\[ERROR\] )?([A-Za-z0-9_$]+)\(([A-Za-z0-9_.$]+)\)[ \t]+Time elapsed: .* <<< (?:FAILURE|ERROR)!$/.exec(
        l,
      );
    if (m) {
      f.test("junit", junitId(m[2], m[1]));
      return 1;
    }
    if (/^\[ERROR\] (?:Failures|Errors): ?$/.test(l)) {
      junitList = true;
      return 1;
    }
    m = surefireRun.exec(l);
    if (m) {
      if (!taskTrim(m[5])) {
        const failed = taskNumber(m[2]) + taskNumber(m[3]);
        f.summary(
          "maven",
          "test",
          failed,
          Math.max(0, taskNumber(m[1]) - failed - taskNumber(m[4])),
        );
      }
      return 1;
    }
    return 0;
  };
  const jvmCompiler = (l: string): number => {
    let m: RegExpExecArray | null;
    m = /^\[ERROR\] (.+?\.(?:java|kt|scala)):\[([0-9]+),([0-9]+)\] (.+)$/.exec(l);
    if (m) {
      f.error("javac", m[1], "", m[4]);
      return 1;
    }
    m = /^\[INFO\] ([0-9]+) errors?[ \t]*$/.exec(l);
    if (m) {
      f.summary("javac", "error", taskNumber(m[1]), null);
      return 1;
    }
    if (/^(?:\[ERROR\] COMPILATION ERROR :?|\[INFO\] BUILD (?:FAILURE|SUCCESS))$/.test(l)) return 1;
    m = /^(.+?\.java):([0-9]+): error: (.+)$/.exec(l);
    if (m) {
      f.error("javac", m[1], "", m[3]);
      return 1;
    }
    if (/^(.+?\.java):([0-9]+): warning: .*$/.test(l)) return 1;
    m = /^([0-9]+) errors?$/.exec(l);
    if (m) {
      f.summary("javac", "error", taskNumber(m[1]), null);
      return 1;
    }
    m =
      /^e: (?:file:\/\/)?(.+?\.kts?):([0-9]+):([0-9]+) (.+)$/.exec(l) ??
      /^e: (.+?\.kts?): \(([0-9]+), ([0-9]+)\): (.+)$/.exec(l);
    if (m) {
      f.error("kotlinc", m[1], "", m[4]);
      return 1;
    }
    return /^w: .*$/.test(l) ? 1 : 0;
  };
  const jvm: Step = (lines, i) => {
    const l = lines[i];
    return junitListing(l) || gradle(l) || surefire(l) || jvmCompiler(l);
  };
  let phpSection: string | null = null,
    ctestList: string | null = null;
  const ctestListing = (l: string): number => {
    let m: RegExpExecArray | null;
    if (ctestList !== null) {
      m = /^[ \t]+[0-9]+ - (.+?) \((.+)\)$/.exec(l);
      if (m) {
        if (ctestList === "FAILED") f.test("ctest", m[1]);
        return 1;
      }
      ctestList = null;
    }
    return 0;
  };
  const rspec = (l: string): number => {
    let m: RegExpExecArray | null;
    m = /^rspec (?:\.\/)?(.+?)(?::[0-9]+|\[[0-9:]+\]) # (.*)$/.exec(l);
    if (m) {
      f.test("rspec", m[2], m[1]);
      return 1;
    }
    m =
      /^([0-9]+) examples?, ([0-9]+) failures?(?:, ([0-9]+) pending)?(?:, ([0-9]+) errors? occurred outside of examples)?$/.exec(
        l,
      );
    if (m) {
      const failures = taskNumber(m[2]);
      f.summary(
        "rspec",
        "test",
        failures + taskNumber(m[4] ?? "0"),
        Math.max(0, taskNumber(m[1]) - failures - taskNumber(m[3] ?? "0")),
      );
      return 1;
    }
    m = /^An error occurred while loading (?:\.\/)?(.+?)\.?$/.exec(l);
    if (m) {
      f.error("rspec", m[1], "load", "");
      return 1;
    }
    return 0;
  };
  const phpunit = (l: string): number => {
    let m: RegExpExecArray | null;
    m = /^There (?:was|were) [0-9]+ ([a-z][a-z ]*?):$/.exec(l);
    if (m) {
      phpSection = m[1];
      return 1;
    }
    m =
      /^[0-9]+\) ([A-Za-z0-9_\\]+)::([A-Za-z0-9_]+)(?: with data set (#[0-9]+|"[^"]*"))?(?: \(.*\))?$/.exec(
        l,
      );
    if (m) {
      if (["failure", "failures", "error", "errors"].includes(phpSection ?? ""))
        f.test("phpunit", m[1] + "::" + m[2] + (m[3] ? " " + m[3] : ""));
      return 1;
    }
    m = /^Tests: ([0-9]+), Assertions: [0-9]+((?:, [A-Za-z ]+: [0-9]+)*)\.$/.exec(l);
    if (m) {
      const c: Record<string, number> = {};
      for (const part of m[2].split(", ")) {
        const kv = /^([A-Za-z ]+): ([0-9]+)$/.exec(part);
        if (kv) c[kv[1]] = taskNumber(kv[2]);
      }
      const failed = (c.Errors ?? 0) + (c.Failures ?? 0);
      f.summary(
        "phpunit",
        "test",
        failed,
        Math.max(0, taskNumber(m[1]) - failed - (c.Skipped ?? 0) - (c.Incomplete ?? 0)),
      );
      return 1;
    }
    m = /^OK \(([0-9]+) tests?, [0-9]+ assertions?\)$/.exec(l);
    if (m) {
      f.summary("phpunit", "test", 0, taskNumber(m[1]));
      return 1;
    }
    if (
      /^(?:FAILURES!|ERRORS!|OK, but (?:there were issues|incomplete, skipped, or risky tests)!)$/.test(
        l,
      )
    )
      return 1;
    return 0;
  };
  const ctest = (l: string): number => {
    let m: RegExpExecArray | null;
    m =
      /^ *[0-9]+\/[0-9]+ Test +#[0-9]+: (.+?) \.*(?: +|\*\*\*)(Passed|Failed|Exception|Timeout|Not Run|Skipped)(?:[: ].*)?$/.exec(
        l,
      );
    if (m) {
      if (["Failed", "Exception", "Timeout"].includes(m[2])) f.test("ctest", m[1]);
      return 1;
    }
    if (/^The following tests (?:FAILED|did not run):$/.test(l)) {
      ctestList = l.includes("FAILED") ? "FAILED" : "notrun";
      return 1;
    }
    m = /^([0-9]+)% tests passed, ([0-9]+) tests? failed out of ([0-9]+)$/.exec(l);
    if (m) {
      const failed = taskNumber(m[2]);
      f.summary("ctest", "test", failed, Math.max(0, taskNumber(m[3]) - failed));
      return 1;
    }
    return /^(?: *Start +[0-9]+: .*|Test project .*|Errors while running CTest|Total Test time .*)$/.test(
      l,
    )
      ? 1
      : 0;
  };
  const misc: Step = (lines, i) => {
    const l = lines[i];
    return ctestListing(l) || rspec(l) || phpunit(l) || ctest(l);
  };
  let symbols = false;
  const cc: Step = (lines, i) => {
    const l = lines[i];
    let m: RegExpExecArray | null;
    if (symbols) {
      m = /^[ \t]+"(.+)", referenced from:$/.exec(l);
      if (m) {
        f.error("cc", "", "ld", "undefined symbol " + m[1]);
        return 1;
      }
      if (/^[ \t]/.test(l)) return 1;
      symbols = false;
    }
    m =
      /^(.+?\.(?:c|cc|cpp|cxx|c\+\+|C|h|hh|hpp|hxx|h\+\+|m|mm|cu|cuh|ino|S|s|ipp|tpp|inl)):([0-9]+)(?::([0-9]+))?: (?:fatal )?error: (.+?)(?: \[([^\]]+)\])?$/.exec(
        l,
      );
    if (m) {
      let code = m[5] ?? "";
      if (code.startsWith("-Werror,")) code = code.slice(8);
      if (code.startsWith("-Werror=")) code = "-W" + code.slice(8);
      f.error("cc", m[1], code, m[4]);
      return 1;
    }
    if (
      /^(?:.+?\.(?:c|cc|cpp|cxx|c\+\+|C|h|hh|hpp|hxx|h\+\+|m|mm|cu|cuh|ino|S|s|ipp|tpp|inl):[0-9]+(?::[0-9]+)?: (?:warning|note): .*|In file included from .*|[ \t]+from .*|.+?: In (?:function|member function|constructor|destructor|instantiation of|static member function) .*:)$/.test(
        l,
      )
    )
      return 1;
    m = /^([0-9]+) errors? generated\.$/.exec(l);
    if (m) {
      f.summary("cc", "error", taskNumber(m[1]), null, true);
      return 1;
    }
    if (/^Undefined symbols for architecture [^ ]+:$/.test(l)) {
      symbols = true;
      return 1;
    }
    m = /undefined reference to [`'‘](.+?)['’]/.exec(l);
    if (m) {
      f.error("cc", "", "ld", "undefined reference to " + m[1]);
      return 1;
    }
    return /^(?:(?:[^ ]*\/)?ld(?:\.[a-z]+)?: .*|collect2: error: ld returned [0-9]+ exit status|clang(?:\+\+)?: error: linker command failed.*|[ \t]+(?:_?[A-Za-z0-9_]+(?:\(.*\))? in .+\.o|in function .*)|g?make(?:\[[0-9]+\])?: \*\*\* .*|g?make(?:\[[0-9]+\])?: (?:Entering|Leaving) directory .*)$/.test(
      l,
    )
      ? 1
      : 0;
  };
  return {
    steps: [pytest, unittest, cargo, rustc, swift, go, js, checkers, dotnet, jvm, misc, cc],
    finish: () => {
      if (goPkgs || goFailed.size || goPassed.size)
        f.summary("go", "test", goFailed.size + goBroken, goPassed.size || goOk || null);
      flush("jest", jestTests, jestSuites);
      flush("vitest", vitestTests, vitestFiles);
      if (mochaPassing !== null || mochaFailing !== null)
        f.summary("mocha", "test", mochaFailing ?? 0, mochaPassing ?? 0);
      if (Object.keys(bun).length) f.summary("bun", "test", bun.fail ?? 0, bun.pass ?? 0);
    },
  };
}
const COMPLETIONS: [string, RegExp][] = [
  ["cargo", /^Finished .* target\(s\) in .+$/],
  ["swiftpm", /^Build complete!(?: \(.*\))?$/],
  ["xcodebuild", /^\*\* [A-Z]+(?: [A-Z]+)* SUCCEEDED \*\*(?: \[.*\])?$/],
  ["gradle", /^BUILD SUCCESSFUL(?: in .+)?$/],
  ["maven", /^\[INFO\] BUILD SUCCESS$/],
  ["prettier", /^All matched files use Prettier code style!$/],
  ["vite", /^✓ built in [0-9]+(?:\.[0-9]+)?(?:ms|s)$/],
];
interface FailureSegment {
  lines: string[];
  claimed: Set<number>;
}
function parseFailureSegment(found: Found, text: string): FailureSegment {
  const lines = cleanLines(text),
    claimed = new Set<number>(),
    recs = recognizers(found);
  for (let i = 0; i < lines.length; ) {
    let used = 0;
    for (const rec of recs.steps) {
      used = rec(lines, i);
      if (used) break;
    }
    for (let k = i; k < i + used; k++) claimed.add(k);
    i += used || 1;
  }
  recs.finish();
  return { lines, claimed };
}
function recognizeGenericFailure(found: Found, line: string): void {
  let m =
    /^(.+?\.[A-Za-z0-9]+):([0-9]+)(?::([0-9]+))?:? (?:fatal )?error(?:\[([^\]]+)\])?:? (.+)$/.exec(
      line,
    );
  if (m) {
    found.error("generic", m[1], m[4] ?? "", m[5]);
    return;
  }
  m = /^(?:error|ERROR|Error|fatal|FATAL)(?:\[([^\]]+)\])?: (.+)$/.exec(line);
  if (m) {
    found.error("generic", "", m[1] ?? "", m[2]);
    return;
  }
  m = /^(?:Uncaught )?([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception)): (.*)$/.exec(line);
  if (m) found.error("generic", "", m[1], m[2]);
}
function collectGenericFailures(found: Found, segments: FailureSegment[]): void {
  for (const { lines, claimed } of segments)
    for (let i = 0; i < lines.length; i++) {
      if (!claimed.has(i)) recognizeGenericFailure(found, lines[i]);
    }
}
function combineFailureSummaries(
  found: Found,
  suite: TaskCommandInfo["suite"],
): Map<string, Summary> {
  const hasTsc = found.fingerprints.some((fp) => fp.startsWith("tsc|")),
    combined = new Map<string, Summary>(),
    present = new Set(found.summaries.map((s) => s.framework));
  for (const s of found.summaries) {
    if (s.framework === "found-errors")
      s.framework = hasTsc || suite === "tsc" || suite === "vue-tsc" ? "tsc" : "ruff";
    if (s.framework === "cargo" && present.has("nextest")) continue;
    const prior = combined.get(s.framework);
    if (prior && s.sum) {
      prior.failed = (prior.failed ?? 0) + (s.failed ?? 0);
      prior.passed =
        prior.passed === null && s.passed === null ? null : (prior.passed ?? 0) + (s.passed ?? 0);
    } else combined.set(s.framework, { ...s });
  }
  return combined;
}
function applyFailureSummaries(
  result: MonitorTaskFailures,
  combined: Map<string, Summary>,
): boolean {
  const tests = [...combined.values()].filter((s) => s.family === "test"),
    errors = [...combined.values()].filter((s) => s.family === "error"),
    chosen = tests.length ? tests : errors;
  if (!chosen.length) return false;
  result.failedCount = chosen.reduce((n, s) => n + (s.failed ?? 0), 0);
  const passes = chosen.filter((s) => s.passed !== null);
  result.passedCount =
    tests.length && passes.length ? passes.reduce((n, s) => n + s.passed!, 0) : null;
  result.framework = (
    chosen.find((s) => s.failed) ??
    chosen.find((s) => s.passed) ??
    chosen[0]
  ).framework;
  return true;
}
function completionFramework(segments: FailureSegment[]): string | null {
  for (const { lines } of segments)
    for (const line of lines) {
      const completed = COMPLETIONS.find(([, pattern]) => pattern.test(taskTrim(line)));
      if (completed) return completed[0];
    }
  return null;
}
export function taskFailures(
  info: Pick<TaskCommandInfo, "suite"> & Partial<Pick<TaskCommandInfo, "errorFilter">>,
  output: string,
  cwd: string | null = null,
  failed: boolean | null = null,
): MonitorTaskFailures {
  const found = new Found(cwd),
    segments: FailureSegment[] = [];
  for (const text of taskOutputBudget(output)) segments.push(parseFailureSegment(found, text));
  if (!found.fingerprints.length && failed === true) collectGenericFailures(found, segments);
  const combined = combineFailureSummaries(found, info.suite),
    canonical = [...new Set(found.fingerprints)].sort();
  const result: MonitorTaskFailures = {
    fingerprints: [...new Set(canonical.map(taskSha16))].sort().slice(0, 256),
    failedCount: null,
    passedCount: null,
    framework: null,
  };
  if (applyFailureSummaries(result, combined)) return result;
  if (canonical.length) {
    result.failedCount = canonical.length;
    result.framework = found.fingerprints[0].split("|")[0];
    return result;
  }
  result.framework = completionFramework(segments);
  if (result.framework) result.failedCount = 0;
  if (
    result.failedCount === null &&
    failed === false &&
    info.errorFilter &&
    (!output.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") ||
      taskTrim(output) === "(Bash completed with no output)")
  )
    result.failedCount = 0;
  return result;
}

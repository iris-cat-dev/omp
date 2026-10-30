// Agent Speed v1.5.0 POSIX command subset (MIT). TASK-PARSERS §§3.1–3.10, OMP tools only.
import type { MonitorTaskActionKind, MonitorTaskCommand } from "./task-events.js";
import {
  taskArgs,
  taskLf,
  taskLower,
  taskNumber,
  taskRelative,
  taskScalars,
  taskSha16,
  taskTrim,
} from "./task-parser-common.js";

export interface TaskCommandInfo extends MonitorTaskCommand {
  masked: boolean;
  background: boolean;
  errorFilter: boolean;
}
type RunClass = MonitorTaskCommand["class"];
type Classification = [RunClass, string | null, boolean];
interface Segment {
  words: string[];
  redirs: [string, string][];
  heredocs: string[];
  ops: string[];
  before: string | null;
  after: string | null;
  background: boolean;
  ctx: string;
}
export interface TaskShell {
  segments: Segment[];
  patches: string[];
  applyPatch: boolean;
  pipefail: boolean;
}
const WORD_LISTS: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
const words = (text: string): string[] => (WORD_LISTS[text] ??= text.split(" ").filter(Boolean));
const has = (values: readonly string[], value: string): boolean => values.includes(value);
const RANK: Record<RunClass, number> = { other: 0, check: 1, build: 2, test: 3 };
const OTHER = (): Classification => ["other", null, false];
const NAME_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NEUTRAL = words(
  "cd pushd popd export set unset source . true : echo printf sleep clear alias shopt ulimit umask wait trap exit return local declare typeset read false",
);
const LEADING = words("! if then else elif do while until {");
const CLOSING = words("fi done esac } for case select function");
const COSMETIC = words(
  "-q -qq -v -vv -vvv --quiet --verbose --color --no-color --colors --no-colors --ansi --no-ansi --nocapture --no-capture --show-output --silent",
);
const COSMETIC_PREFIX = words("--color= --colour= --colors= --tb=");
const ENV_VALUE = words("-u --unset -C --chdir -S --split-string");
const SUDO_VALUE = words("-u -g -h -p -C -D -r -t -U --user --group");
const NPX_VALUE = words("-p --package -c --call --cache --userconfig");
const PY_VALUE = words("-W -X --check-hash-based-pycs");
const UV_VALUE = words(
  "--with --with-requirements --with-editable --python -p --extra --group --only-group --package --directory --project --env-file --index --index-url --default-index --extra-index-url -C --config-setting --no-group --script --gui-script -n --name -p --prefix --cwd",
);
const COVERAGE_VALUE = words(
  "--source --rcfile --data-file --concurrency --include --omit --context",
);
const PM_NARROW = words("-w --workspace --filter -F");
const PM_VALUE = new Set([...PM_NARROW, ...words("--prefix -C --dir --cwd")]);
const PYTEST_VALUE = words(
  "-k -m -p -c -o -n -W -r --maxfail --tb --rootdir --basetemp --junitxml --junit-xml --durations --deselect --ignore --ignore-glob --log-level --log-cli-level --timeout --confcutdir --import-mode --dist --cov --cov-report --cov-config --cov-fail-under --reruns --reruns-delay --count -p --override-ini --capture --html --randomly-seed",
);
const CARGO_VALUE = words(
  "-p --package --test --bin --example --bench -F --features --target --target-dir --manifest-path -j --jobs --profile --exclude --color --message-format --config -Z --timings",
);
const CARGO_NARROW = words(
  "-p --package --test --lib --bin --bins --example --examples --doc --bench --benches",
);
const SWIFT_TEST_VALUE = words(
  "--filter --skip -s --specifier -c --configuration --package-path --scratch-path -j --jobs --num-workers --xunit-output --test-product --sanitize --triple --sdk",
);
const DOTNET_VALUE = words(
  "--filter -c --configuration -f --framework -r --runtime -o --output -v --verbosity -s --settings -l --logger --results-directory -a --test-adapter-path --collect -p --property",
);
const GO_VALUE = words(
  "-run -skip -bench -count -timeout -tags -p -parallel -cpu -coverprofile -coverpkg -covermode -o -exec -benchtime -blockprofile -cpuprofile -memprofile -mutexprofile -outputdir -trace -shuffle -fuzz -fuzztime -vet -ldflags -gcflags -mod -modfile -C -asmflags -buildmode -compiler -gccgoflags -installsuffix -pkgdir -toolexec -overlay -pgo",
);
const GRADLE_VALUE = words(
  "-p --project-dir -b --build-file -c --settings-file -x --exclude-task --tests --max-workers -I --init-script -g --gradle-user-home --console --warning-mode --priority -D -P --include-build",
);
const MVN_VALUE = words(
  "-pl --projects -f --file -s --settings -P --activate-profiles -T --threads -rf --resume-from -gs --global-settings -t --toolchains -l --log-file",
);
const CTEST_FILTERS = words(
  "-R --tests-regex -E --exclude-regex -L --label-regex -LE --label-exclude -I --tests-information --rerun-failed",
);
const JEST_VALUE = words(
  "-c --config -w --maxWorkers --testTimeout --reporters --coverageReporters --rootDir --roots --env --testEnvironment --outputFile --seed -t --testNamePattern --testPathPattern --testPathPatterns --testPathIgnorePatterns --changedSince --selectProjects --shard --coverageDirectory --collectCoverageFrom --json",
);
const VITEST_VALUE = words(
  "-c --config --root -r --dir --reporter --outputFile --environment --pool --project --shard -t --testNamePattern --maxWorkers --minWorkers --testTimeout --mode --exclude",
);
const MOCHA_VALUE = words(
  "-r --require -R --reporter -t --timeout -s --slow -u --ui --config --package --extension --ignore --file -g --grep -f --fgrep --spec --retries -j --jobs --reporter-option -O",
);
const TSC_VALUE = words(
  "-p --project --outDir --target --module --lib --jsx --moduleResolution --rootDir --declarationDir --tsBuildInfoFile",
);
const RUFF_VALUE = words(
  "--select --ignore --extend-select --extend-ignore --config --output-format --target-version --exclude --extend-exclude --line-length --per-file-ignores --cache-dir --stdin-filename --fixable --unfixable",
);
const BUN_TEST_VALUE = words(
  "-t --test-name-pattern --timeout --preload --coverage-reporter --reporter --rerun-each",
);
const PHPUNIT_VALUE = words(
  "--filter --group --exclude-group --testsuite -c --configuration --bootstrap --log-junit --order-by --cache-directory --coverage-html --coverage-clover --coverage-text --test-suffix --exclude-testsuite",
);
const FORWARD_FILTERS = words(
  "-t --testNamePattern -k --grep -g --filter -run --run --testPathPattern --spec --tests -E -R --findRelatedTests --only-testing -only-testing --skip --exact -p --package -m",
);
const FORWARD_VALUE = words(
  "--reporter -r --config -c --maxWorkers -w --timeout --testTimeout --env --outputFile --coverageReporters --pool --environment --seed --tb -n --workers -j --jobs",
);
const NPM_BUILTINS = words(
  "install i ci add uninstall remove rm update up outdated ls list link publish pack init create audit config cache version view info why explain dedupe prune rebuild start restart stop store fetch patch import deploy licenses doctor setup env approve-builds self-update workspaces workspace dlx exec x set plugin constraints unplug stage npm node upgrade pm repl help login logout whoami search owner access token team org profile star stars unstar fund sbom query run-script run rum urn test t tst build global",
);
const PROGRAM_ALIASES: Readonly<Record<string, string>> = {
  gradlew: "gradle",
  mvnw: "mvn",
  "py.test": "pytest",
  nodejs: "node",
  gmake: "make",
  bazelisk: "bazel",
};
const SCRIPT_ALIASES: Readonly<Record<string, string>> = {
  t: "test",
  tst: "test",
  tests: "test",
  "type-check": "typecheck",
  types: "typecheck",
  compile: "build",
};
const SCRIPT_CLASSES: Readonly<Record<string, RunClass>> = {
  test: "test",
  build: "build",
  lint: "check",
  typecheck: "check",
  check: "check",
};

export function taskProgram(word: string): string {
  const base = taskLower(word.split(/[/\\]/).at(-1) ?? "").replace(/\.(?:exe|cmd|bat|ps1)$/, "");
  if (/^(?:python[0-9.]*|py|pypy[0-9.]*)$/.test(base)) return "python";
  if (/^(?:gcc|g\+\+|cc|c\+\+|clang|clang\+\+)(?:-[0-9.]+)?$/.test(base)) return "cc";
  return Object.hasOwn(PROGRAM_ALIASES, base) ? PROGRAM_ALIASES[base] : base;
}
type ShellWord = [string, number];
function readSingleQuotedWord(text: string, word: ShellWord): void {
  const start = word[1],
    end = text.indexOf("'", start + 1);
  word[0] += text.slice(start + 1, end < 0 ? text.length : end);
  word[1] = end < 0 ? text.length : end + 1;
}
function readAnsiQuotedWord(text: string, word: ShellWord): void {
  let i = word[1] + 2;
  while (i < text.length && text[i] !== "'") {
    if (text[i] === "\\" && i + 1 < text.length) i++;
    word[0] += text[i++];
  }
  word[1] = i + 1;
}
function readDoubleQuotedWord(text: string, word: ShellWord): void {
  let i = word[1] + 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
      if (text[i + 1] !== "\n") word[0] += text[i + 1];
      i += 2;
    } else word[0] += text[i++];
  }
  word[1] = i + 1;
}
function readExpansionWord(text: string, word: ShellWord): void {
  const start = word[1],
    open = text[start + 1],
    close = open === "(" ? ")" : "}";
  let level = 0,
    end = start + 1;
  for (; end < text.length; end++) {
    if (text[end] === open) level++;
    else if (text[end] === close && --level === 0) break;
  }
  word[0] += text.slice(start, end + 1);
  word[1] = end + 1;
}
function readWord(text: string, start: number): ShellWord {
  const word: ShellWord = ["", start];
  while (word[1] < text.length) {
    const i = word[1],
      c = text[i];
    if (" \t\n;&|()<>".includes(c)) break;
    if (c === "\\") {
      if (i + 1 < text.length && text[i + 1] !== "\n") word[0] += text[i + 1];
      word[1] += 2;
      continue;
    }
    if (c === "'") {
      readSingleQuotedWord(text, word);
      continue;
    }
    if (c === "$" && text[i + 1] === "'") {
      readAnsiQuotedWord(text, word);
      continue;
    }
    if (c === '"') {
      readDoubleQuotedWord(text, word);
      continue;
    }
    if (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{")) {
      readExpansionWord(text, word);
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      word[0] += text.slice(i, end < 0 ? text.length : end + 1);
      word[1] = end < 0 ? text.length : end + 1;
      continue;
    }
    word[0] += c;
    word[1]++;
  }
  return word;
}
type ShellToken = [string, string, string?];
type PendingHereDoc = [string, boolean, number];
function readHereDocs(
  text: string,
  start: number,
  pending: PendingHereDoc[],
  tokens: ShellToken[],
): number {
  let i = start;
  for (const [delimiter, tabs, index] of pending) {
    let body = "";
    while (i < text.length) {
      const end = text.indexOf("\n", i),
        line = text.slice(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end + 1;
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
      body += line + "\n";
    }
    tokens[index] = ["heredoc", body];
  }
  pending.length = 0;
  return i;
}
function tokenize(text: string): ShellToken[] {
  const tokens: ShellToken[] = [],
    pending: PendingHereDoc[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\\" && text[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === "\n") {
      tokens.push(["op", ";"]);
      i = readHereDocs(text, i + 1, pending, tokens);
      continue;
    }
    if (c === "#") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (has(["&&", "||", "|&", ";;"], two)) {
      let op = two;
      if (two === "|&") op = "|";
      else if (two === ";;") op = ";";
      tokens.push(["op", op]);
      i += 2;
      continue;
    }
    const redir = /^[0-9]*(<<<|<<-|<<|>>|>&|<&|>\||<>|&>>|&>|>|<)/.exec(text.slice(i));
    if (redir) {
      i += redir[0].length;
      while (text[i] === " " || text[i] === "\t") i++;
      const [word, next] = readWord(text, i);
      i = next;
      if (redir[1] === "<<" || redir[1] === "<<-") {
        pending.push([word, redir[1] === "<<-", tokens.length]);
        tokens.push(["heredoc", ""]);
      } else tokens.push(["redir", redir[1], word]);
      continue;
    }
    if (";&|()".includes(c)) {
      tokens.push(["op", c]);
      i++;
      continue;
    }
    const [word, next] = readWord(text, i);
    tokens.push(["word", word]);
    i = next > i ? next : i + 1;
  }
  return tokens;
}
const segment = (): Segment => ({
  words: [],
  redirs: [],
  heredocs: [],
  ops: [],
  before: null,
  after: null,
  background: false,
  ctx: "",
});
function splitSegments(text: string): [Segment[], string[]] {
  const segments: Segment[] = [];
  let current = segment(),
    ops: string[] = [];
  for (const [kind, value, target] of tokenize(text)) {
    if (kind === "word") current.words.push(value);
    else if (kind === "redir") current.redirs.push([value, target ?? ""]);
    else if (kind === "heredoc") current.heredocs.push(value);
    else {
      if (current.words.length || current.heredocs.length) {
        current.ops = ops;
        segments.push(current);
        ops = [];
      }
      current = segment();
      ops.push(value);
    }
  }
  if (current.words.length || current.heredocs.length) {
    current.ops = ops;
    segments.push(current);
    ops = [];
  }
  return [segments, ops];
}
function dropOptions(
  values: string[],
  start: number,
  withValue: readonly string[] = [],
  stop = true,
): number {
  let i = start;
  while (i < values.length) {
    const w = values[i];
    if (w === "--" && stop) return i + 1;
    if (!w.startsWith("-") || w === "-") return i;
    i += has(withValue, w) ? 2 : 1;
  }
  return i;
}
function stripPrefixes(seg: Segment): void {
  const list = seg.words;
  let i = 0;
  const prefixes: Record<string, string[]> = {
    env: ENV_VALUE,
    sudo: SUDO_VALUE,
    doas: SUDO_VALUE,
    time: [],
    nice: words("-n --adjustment"),
    stdbuf: words("-i -o -e"),
    caffeinate: words("-t -w"),
    "xvfb-run": words(
      "-s --server-args -n --server-num -e --error-file -f --auth-file -p --xauth-protocol",
    ),
    timeout: words("-s --signal -k --kill-after"),
    gtimeout: words("-s --signal -k --kill-after"),
    nohup: [],
    setsid: [],
    exec: [],
    command: [],
    builtin: [],
    noglob: [],
    unbuffer: [],
    chronic: [],
  };
  while (i < list.length) {
    if (NAME_ASSIGN.test(list[i])) {
      i++;
      continue;
    }
    const p = taskProgram(list[i]);
    if (!Object.hasOwn(prefixes, p)) break;
    if (p === "nohup" || p === "setsid") seg.background = true;
    i = dropOptions(list, i + 1, prefixes[p]);
    if (p === "timeout" || p === "gtimeout") i++;
  }
  seg.words = list.slice(i);
}
function dropKeywords(seg: Segment): void {
  while (has(LEADING, seg.words[0])) seg.words.shift();
  while (seg.words.at(-1) === "}") seg.words.pop();
}
function shellScript(seg: Segment): string | null {
  if (!seg.words.length) return null;
  const p = taskProgram(seg.words[0]),
    rest = seg.words.slice(1);
  if (has(words("bash sh zsh dash ksh fish"), p)) {
    for (let k = 0; k < rest.length; k++) {
      if (!rest[k].startsWith("-")) return null;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(rest[k]) && k + 1 < rest.length) return rest[k + 1];
    }
  } else if (p === "pwsh" || p === "powershell" || p === "cmd") {
    const k = rest.findIndex((w) =>
      p === "cmd" ? taskLower(w) === "/c" : has(["-command", "-c"], taskLower(w)),
    );
    if (k >= 0 && k + 1 < rest.length) return rest.slice(k + 1).join(" ");
  }
  return null;
}
function skipModule(list: string[], start: number, values: string[]): number {
  let i = start;
  while (i < list.length && list[i].startsWith("-") && list[i] !== "-m" && list[i] !== "-")
    i += has(values, list[i]) ? 2 : 1;
  return i;
}
function optionWrapperStart(list: string[], program: string): number | null {
  const sub = list[1];
  if (has(["npx", "pnpx", "bunx"], program)) return dropOptions(list, 1, NPX_VALUE);
  if (has(["npm", "pnpm", "yarn", "bun"], program) && has(["exec", "dlx", "x"], sub))
    return dropOptions(list, 2, NPX_VALUE);
  if (program === "mise" && has(["exec", "x"], sub)) {
    const separator = list.indexOf("--", 1);
    return separator < 0 ? 2 : separator + 1;
  }
  if (
    has(words("uv poetry pipenv pdm rye pixi conda mamba micromamba hatch"), program) &&
    sub === "run"
  )
    return dropOptions(list, 2, UV_VALUE);
  return null;
}
function interpreterWrapperStart(list: string[], program: string): number | null {
  if (program === "python" || (program === "coverage" && list[1] === "run")) {
    const python = program === "python",
      k = skipModule(list, python ? 1 : 2, python ? PY_VALUE : COVERAGE_VALUE);
    if (list[k] !== "-m" || k + 1 >= list.length) return null;
    return k + 1;
  }
  if (program === "bundle" && list[1] === "exec") return 2;
  if (program === "xcrun") return dropOptions(list, 1, words("--sdk -sdk --toolchain -toolchain"));
  if (program === "dotnet" && list[1] === "tool" && list[2] === "run") return 3;
  if (
    program === "php" &&
    list[1] &&
    !list[1].startsWith("-") &&
    has(["phpunit", "pest", "phpstan", "psalm"], taskProgram(list[1]))
  )
    return 1;
  return null;
}
function unwrap(list: string[]): string[] {
  for (let n = 0; n < 8 && list.length; n++) {
    const program = taskProgram(list[0]),
      start = optionWrapperStart(list, program) ?? interpreterWrapperStart(list, program);
    if (start === null) return list;
    list = list.slice(start);
  }
  return list;
}
function normDir(target: string, ctx: string, cwd: string | null): string {
  const t = target.replace(/\\/g, "/");
  if (!t) return ctx;
  const [rel, inside] = taskRelative(t, cwd);
  let joined = t;
  if (inside) joined = rel;
  else if (
    t !== "~" &&
    !t.startsWith("~/") &&
    !t.startsWith("/") &&
    !/^[A-Za-z]:\//.test(t) &&
    t !== "-" &&
    ctx
  )
    joined = ctx + "/" + t;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return (joined.startsWith("/") ? "/" : "") + parts.join("/");
}
const significant = (ops: string[]): string[] => ops.filter((op) => op !== "(" && op !== ")");
export function taskParseShell(text: string, cwd: string | null = null): TaskShell {
  const parsed: TaskShell = { segments: [], patches: [], applyPatch: false, pipefail: false };
  const st = { ctx: "", parens: [] as string[], dirs: [] as string[], carry: [] as string[] };
  const parens = (ops: string[]): void => {
    for (const op of ops) {
      if (op === "(") st.parens.push(st.ctx);
      else if (op === ")" && st.parens.length) st.ctx = st.parens.pop()!;
    }
  };
  const isPatch = (value: string): boolean =>
    value.split("\n").some((line) => /^[ \t]*\*\*\* Begin Patch[ \t]*$/.test(line));
  const parse = (script: string, depth: number): void => {
    if (depth > 4) return;
    const [segs, tail] = splitSegments(taskLf(script));
    for (const seg of segs) {
      parens(seg.ops);
      const ops = [...st.carry, ...seg.ops];
      st.carry = [];
      dropKeywords(seg);
      stripPrefixes(seg);
      dropKeywords(seg);
      if (has(CLOSING, seg.words[0])) seg.words = [];
      parsed.patches.push(...seg.heredocs.filter(isPatch));
      const nestedScript = shellScript(seg);
      if (nestedScript !== null) {
        st.carry = ops;
        const before = parsed.segments.length;
        parse(nestedScript, depth + 1);
        if (seg.background && parsed.segments.length > before)
          parsed.segments.at(-1)!.background = true;
        continue;
      }
      parsed.patches.push(...seg.words.filter((w) => w.includes("\n") && isPatch(w)));
      seg.words = unwrap(seg.words);
      seg.ctx = st.ctx;
      if (seg.words.length) {
        const p = taskProgram(seg.words[0]);
        if (p === "apply_patch" || p === "applypatch") parsed.applyPatch = true;
        if (
          p === "set" &&
          seg.words.some((w, k) => /^-[A-Za-z]*o$/.test(w) && seg.words[k + 1] === "pipefail")
        )
          parsed.pipefail = true;
        if (p === "cd" || p === "pushd") {
          if (p === "pushd") st.dirs.push(st.ctx);
          st.ctx = normDir(
            seg.words.slice(1).find((w) => !w.startsWith("-") || w === "-") ?? "~",
            st.ctx,
            cwd,
          );
        } else if (p === "popd" && st.dirs.length) st.ctx = st.dirs.pop()!;
      }
      if (seg.words.length || seg.heredocs.length) {
        seg.ops = ops;
        parsed.segments.push(seg);
      } else st.carry = ops;
    }
    parens(tail);
    st.carry.push(...tail);
  };
  parse(taskScalars(text), 0);
  for (let k = 0; k < parsed.segments.length; k++) {
    const seg = parsed.segments[k],
      following = k + 1 < parsed.segments.length ? parsed.segments[k + 1].ops : st.carry;
    seg.before = k ? (significant(seg.ops).at(-1) ?? null) : null;
    seg.after = significant(following).at(-1) ?? null;
    if (significant(following)[0] === "&") seg.background = true;
  }
  return parsed;
}
interface Options {
  pos: string[];
  opts: Record<string, string | true>;
  after: string[];
}
function parseOpts(args: string[], values: readonly string[] = [], stop = true): Options {
  const out: Options = {
    pos: [],
    opts: Object.create(null) as Record<string, string | true>,
    after: [],
  };
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--" && stop) {
      out.after = args.slice(i + 1);
      break;
    }
    if (w.startsWith("-") && w !== "-") {
      if (w.startsWith("--") && w.includes("=")) {
        const p = w.indexOf("=");
        out.opts[w.slice(0, p)] = w.slice(p + 1);
      } else if (has(values, w) && i + 1 < args.length) out.opts[w] = args[++i];
      else {
        const prefix = values.find((o) => o.length === 2 && w.startsWith(o) && w.length > 2);
        out.opts[prefix ?? w] = prefix ? w.slice(2) : true;
      }
    } else out.pos.push(w);
  }
  return out;
}
const opt = (options: Record<string, unknown>, text: string): boolean =>
  words(text).some((key) => Object.hasOwn(options, key));
const extension = (value: string): boolean => /\.[A-Za-z0-9]{1,10}$/.test(value);
function broadPath(arg: string, cwd: string | null): boolean {
  let a = taskRelative(arg.replace(/\\/g, "/"), cwd)[0];
  while (a.startsWith("./")) a = a.slice(2);
  a = a.replace(/\/+$/, "");
  return (
    !a ||
    a === "." ||
    (!a.includes("*") &&
      !a.includes("?") &&
      !a.includes("::") &&
      !a.startsWith("/") &&
      !/^[A-Za-z]:/.test(a) &&
      !a.includes("/") &&
      !extension(a))
  );
}
const pathTargeted = (pos: string[], cwd: string | null): boolean =>
  pos.some((p) => !broadPath(p, cwd));
const nameTargeted = (pos: string[], cwd: string | null): boolean =>
  pos.some((p) => {
    const a = taskRelative(p.replace(/\\/g, "/").replace(/\/+$/, ""), cwd)[0];
    return a !== "" && a !== ".";
  });

type Handler = (args: string[], cwd: string | null) => Classification;
const PROGRAMS: Record<string, Handler> = Object.create(null) as Record<string, Handler>;
function pathRule(cls: RunClass, suite: string, values: string[] = [], filters = ""): Handler {
  return (args, cwd) => {
    const o = parseOpts(args, values);
    return [cls, suite, opt(o.opts, filters) || pathTargeted([...o.pos, ...o.after], cwd)];
  };
}
function subRule(
  table: Record<string, [RunClass, string, string, boolean]>,
  values: string[] = [],
): Handler {
  return (args, cwd) => {
    if (!Object.hasOwn(table, args[0])) return OTHER();
    const rule = table[args[0]],
      o = parseOpts(args.slice(1), values);
    return [
      rule[0],
      rule[1],
      opt(o.opts, rule[2]) || (rule[3] && pathTargeted([...o.pos, ...o.after], cwd)),
    ];
  };
}
function flagRule(suite: string, flags: string[], values: string[]): Handler {
  return (args, cwd) =>
    args.some((a) => has(flags, a)) ? pathRule("check", suite, values)(args, cwd) : OTHER();
}
function gradleExcludedTasks(args: string[]): string[] {
  const excluded: string[] = [];
  for (let k = 0; k < args.length; k++) {
    if (has(["-x", "--exclude-task"], args[k]) && k + 1 < args.length)
      excluded.push(args[k + 1].split(":").at(-1)!);
    else if (args[k].startsWith("--exclude-task="))
      excluded.push(args[k].slice(15).split(":").at(-1)!);
  }
  return excluded;
}
function gradleTaskClass(base: string, excluded: string[]): RunClass {
  if (
    base === "test" ||
    /^test[A-Z0-9].*$/.test(base) ||
    base.endsWith("Test") ||
    base.endsWith("Tests") ||
    has(["check", "build"], base)
  ) {
    if (has(["check", "build"], base) && excluded.includes("test")) return "build";
    return "test";
  }
  if (
    has(words("assemble jar classes installDist bootJar shadowJar"), base) ||
    base.startsWith("assemble") ||
    base.startsWith("compile")
  )
    return "build";
  if (
    base.startsWith("lint") ||
    has(["detekt", "ktlintCheck", "spotlessCheck"], base) ||
    ["checkstyle", "pmd", "spotbugs"].some((prefix) => base.startsWith(prefix))
  )
    return "check";
  return "other";
}
function mavenGoalClass(goal: string, tests: string[], builds: string[], skip: boolean): RunClass {
  if (tests.includes(goal) || goal === "surefire:test") return skip ? "build" : "test";
  if (builds.includes(goal)) return "build";
  return goal.endsWith(":check") ? "check" : "other";
}
Object.assign(PROGRAMS, {
  pytest: (args: string[], cwd: string | null): Classification => {
    const o = parseOpts(args, PYTEST_VALUE);
    return [
      "test",
      "pytest",
      opt(o.opts, "-k -m --lf --last-failed --sw --stepwise --deselect --stepwise-skip") ||
        pathTargeted([...o.pos, ...o.after], cwd),
    ];
  },
  unittest: (args: string[]): Classification => {
    const o = parseOpts(
      args,
      words("-s -t -p -k --start-directory --top-level-directory --pattern"),
    );
    return ["test", "unittest", o.pos.some((p) => p !== "discover") || "-k" in o.opts];
  },
  cargo: (args: string[]): Classification => {
    let k = 0;
    while (k < args.length && (args[k].startsWith("-") || args[k].startsWith("+")))
      k += has(words("--color --config -Z -C --manifest-path"), args[k]) ? 2 : 1;
    const sub = args[k],
      rest = args.slice(k + 1);
    if (sub === "test" || sub === "t") {
      const o = parseOpts(rest, CARGO_VALUE),
        a = parseOpts(
          o.after,
          words("--skip --test-threads --format --color -Z --logfile --report-time"),
          false,
        );
      return [
        "test",
        "cargo test",
        CARGO_NARROW.some((v) => v in o.opts) ||
          o.pos.length > 0 ||
          a.pos.length > 0 ||
          opt(a.opts, "--exact --skip"),
      ];
    }
    if (sub === "nextest" && has(["run", "r"], rest[0])) {
      const o = parseOpts(
        rest.slice(1),
        words(
          "-E --filterset --filter-expr -p --package --test --bin --profile -P -j --test-threads --retries --partition --archive-file --cargo-profile -F --features --target-dir --manifest-path",
        ),
      );
      return [
        "test",
        "cargo nextest",
        !!o.pos.length ||
          opt(o.opts, "-E --filterset --filter-expr -p --package --test --lib --bin"),
      ];
    }
    const options = parseOpts(rest, CARGO_VALUE),
      narrow = CARGO_NARROW.some((v) => v in options.opts);
    if (has(["build", "b", "rustc"], sub)) return ["build", "cargo build", narrow];
    if (has(["check", "c", "clippy"], sub))
      return ["check", sub === "clippy" ? "cargo clippy" : "cargo check", narrow];
    return sub === "fmt" && rest.includes("--check") ? ["check", "cargo fmt", false] : OTHER();
  },
  swift: (args: string[]): Classification => {
    if (args[0] === "test")
      return [
        "test",
        "swift test",
        opt(parseOpts(args.slice(1), SWIFT_TEST_VALUE).opts, "--filter --skip -s --specifier"),
      ];
    if (args[0] === "build")
      return [
        "build",
        "swift build",
        opt(
          parseOpts(
            args.slice(1),
            words(
              "--target --product -c --configuration --package-path --scratch-path -j --jobs --triple --sdk --arch",
            ),
          ).opts,
          "--target --product",
        ),
      ];
    return OTHER();
  },
  xcodebuild: (args: string[]): Classification => {
    const actions: string[] = [];
    let narrow = false;
    const flags = words(
      "-quiet -verbose -json -allowProvisioningUpdates -allowProvisioningDeviceRegistration -skipUnavailableActions -hideShellScriptEnvironment -retry-tests-on-failure -skipPackagePluginValidation -skipMacroValidation -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile -showTestPlans -dry-run -UseModernBuildSystem -enableCodeCoverage -parallel-testing-enabled",
    );
    for (let k = 0; k < args.length; k++) {
      const w = args[k];
      if (
        has(
          words(
            "-list -showBuildSettings -version -showsdks -showdestinations -usage -help -resolvePackageDependencies -showTestPlans -showComponent",
          ),
          w,
        )
      )
        return OTHER();
      if (w.startsWith("-only-testing") || w.startsWith("-skip-testing")) {
        narrow = true;
        if (!w.includes(":")) k++;
      } else if (w.startsWith("-")) {
        if (!(has(flags, w) || w.includes(":") || w.includes("="))) k++;
      } else if (
        has(
          words(
            "build test build-for-testing test-without-building analyze archive clean install installsrc docbuild",
          ),
          w,
        )
      )
        actions.push(w);
    }
    if (actions.includes("test") || actions.includes("test-without-building"))
      return ["test", "xcodebuild test", narrow];
    if (actions.includes("analyze")) return ["check", "xcodebuild analyze", false];
    return actions.length && actions.every((a) => a === "clean")
      ? OTHER()
      : ["build", "xcodebuild build", false];
  },
  go: (args: string[]): Classification => {
    let rest = args.slice(1);
    if (rest.includes("-args")) rest = rest.slice(0, rest.indexOf("-args"));
    const o = parseOpts(
      rest.map((w) => (w.startsWith("--") && w.length > 2 ? w.slice(1) : w)),
      GO_VALUE,
      false,
    );
    const narrow = o.pos.some((p) => !has(["./...", "...", "all", "."], p)),
      opts = Object.fromEntries(Object.entries(o.opts).map(([k, v]) => [k.split("=")[0], v]));
    if (args[0] === "test") return ["test", "go test", narrow || opt(opts, "-run -skip -fuzz")];
    if (has(["build", "install"], args[0])) return ["build", "go build", narrow];
    return args[0] === "vet" ? ["check", "go vet", narrow] : OTHER();
  },
  dotnet: (args: string[]): Classification => {
    const o = parseOpts(args.slice(1), DOTNET_VALUE);
    if (args[0] === "test") return ["test", "dotnet test", "--filter" in o.opts];
    if (has(["build", "publish", "pack", "msbuild"], args[0]))
      return ["build", "dotnet " + args[0], false];
    return args[0] === "format" && "--verify-no-changes" in o.opts
      ? ["check", "dotnet format", false]
      : OTHER();
  },
  gradle: (args: string[]): Classification => {
    const o = parseOpts(args, GRADLE_VALUE),
      excluded = gradleExcludedTasks(args);
    let best = OTHER();
    for (const target of o.pos) {
      const base = target.split(":").at(-1)!,
        cls = gradleTaskClass(base, excluded);
      if (RANK[cls] > RANK[best[0]])
        best = [
          cls,
          has(["test", "check", "build", "assemble", "lint"], base) ? "gradle " + base : null,
          target.replace(/^:+|:+$/g, "").includes(":") || "--tests" in o.opts,
        ];
    }
    return best;
  },
  mvn: (args: string[]): Classification => {
    const o = parseOpts(args, MVN_VALUE),
      tests = words("test integration-test verify install deploy package"),
      builds = words("compile test-compile process-classes"),
      skip = args.some((w) =>
        has(["-DskipTests", "-DskipTests=true", "-Dmaven.test.skip=true", "-Dmaven.test.skip"], w),
      ),
      narrow =
        opt(o.opts, "-pl --projects") ||
        args.some((w) => w.startsWith("-Dtest=") || w.startsWith("-Dit.test="));
    let best = OTHER();
    for (const goal of o.pos) {
      const cls = mavenGoalClass(goal, tests, builds, skip);
      if (RANK[cls] > RANK[best[0]])
        best = [cls, tests.includes(goal) || builds.includes(goal) ? "mvn " + goal : null, narrow];
    }
    return best;
  },
  cc: (args: string[]): Classification =>
    args.includes("-E") || args.includes("--version") || args[0] === "-v"
      ? OTHER()
      : [args.includes("-fsyntax-only") ? "check" : "build", "cc", false],
  cmake: (args: string[]): Classification => {
    if (!args.includes("--build")) return OTHER();
    const o = parseOpts(args, words("--build --target -t -j --parallel --config")),
      target = o.opts["--target"] || o.opts["-t"];
    return [
      typeof target === "string" && has(["test", "check", "RUN_TESTS"], target) ? "test" : "build",
      "cmake --build",
      typeof target === "string",
    ];
  },
  ctest: (args: string[]): Classification => {
    const o = parseOpts(
      args,
      words(
        "--test-dir -C --build-config -j --parallel --timeout --output-log -R --tests-regex -E --exclude-regex -L --label-regex -LE --label-exclude -I --tests-information --repeat --stop-time -O --resource-spec-file --repeat-until-fail",
      ),
    );
    return ["test", "ctest", CTEST_FILTERS.some((v) => v in o.opts)];
  },
  jest: (args: string[], cwd: string | null): Classification => {
    const o = parseOpts(args, JEST_VALUE);
    return [
      "test",
      "jest",
      opt(
        o.opts,
        "-t --testNamePattern --testPathPattern --testPathPatterns --findRelatedTests -o --onlyChanged --changedSince --lastCommit --selectProjects --shard --onlyFailures -f",
      ) || nameTargeted([...o.pos, ...o.after], cwd),
    ];
  },
  vitest: (args: string[], cwd: string | null): Classification => {
    const sub = has(words("run watch dev related bench list init typecheck"), args[0])
      ? args[0]
      : null;
    if (sub && has(["bench", "list", "init"], sub)) return OTHER();
    const o = parseOpts(sub ? args.slice(1) : args, VITEST_VALUE);
    return [
      "test",
      "vitest",
      sub === "related" ||
        opt(o.opts, "-t --testNamePattern --changed --shard --project") ||
        nameTargeted([...o.pos, ...o.after], cwd),
    ];
  },
  mocha: (args: string[], cwd: string | null): Classification => {
    const o = parseOpts(args, MOCHA_VALUE);
    if (typeof o.opts["--spec"] === "string") o.pos.push(o.opts["--spec"]);
    return [
      "test",
      "mocha",
      opt(o.opts, "-g --grep -f --fgrep") || pathTargeted([...o.pos, ...o.after], cwd),
    ];
  },
  node: (args: string[], cwd: string | null): Classification => {
    if (!args.includes("--test")) return OTHER();
    const o = parseOpts(
      args.filter((a) => a !== "--test"),
      words(
        "--test-name-pattern --test-reporter --test-reporter-destination --test-concurrency --require -r --import --loader",
      ),
    );
    return [
      "test",
      "node --test",
      opt(o.opts, "--test-name-pattern --test-only") || pathTargeted([...o.pos, ...o.after], cwd),
    ];
  },
  python: (args: string[]): Classification => {
    args = args.slice(skipModule(args, 0, PY_VALUE));
    const file = args[0]?.replace(/\\/g, "/").split("/").at(-1);
    if (args[1] !== "test") return OTHER();
    if (file === "setup.py") return ["test", "setup.py test", false];
    if (file !== "manage.py") return OTHER();
    const o = parseOpts(
      args.slice(2),
      words("-k --settings --parallel --tag --exclude-tag --pattern -p -v --verbosity"),
    );
    return ["test", "django test", !!o.pos.length || opt(o.opts, "-k --tag")];
  },
  ruff: (args: string[], cwd: string | null): Classification => {
    const sub = has(words("check format rule config linter clean server analyze version"), args[0])
        ? args[0]
        : null,
      rest = sub ? args.slice(1) : args;
    if (
      sub !== null &&
      sub !== "check" &&
      !(sub === "format" && (rest.includes("--check") || rest.includes("--diff")))
    )
      return OTHER();
    const o = parseOpts(rest, RUFF_VALUE);
    return [
      "check",
      sub === "format" ? "ruff format" : "ruff",
      pathTargeted([...o.pos, ...o.after], cwd),
    ];
  },
  swiftlint: (args: string[]): Classification =>
    has(["autocorrect", "analyze"], args[0]) || args.includes("--fix")
      ? OTHER()
      : ["check", "swiftlint", false],
});
for (const name of ["tsc", "vue-tsc"])
  PROGRAMS[name] = (args, cwd) => {
    if (args.some((a) => has(words("--watch -w --version -v --init --help -h --showConfig"), a)))
      return OTHER();
    const o = parseOpts(args, TSC_VALUE);
    return [
      "check",
      name,
      args.includes("-b") || args.includes("--build")
        ? false
        : pathTargeted([...o.pos, ...o.after], cwd),
    ];
  };
for (const [cls, names] of [
  ["build", "swiftc msbuild javac kotlinc webpack rollup esbuild tsup rustc"],
  ["test", "vstest.console"],
  ["check", "svelte-check clang-tidy cppcheck shellcheck hadolint"],
] as const)
  for (const name of words(names))
    PROGRAMS[name] = () => [cls, name === "vstest.console" ? "vstest" : name, false];
PROGRAMS.dmypy = () => ["check", "mypy", false];
for (const [name, cls, values, filters] of [
  ["ava", "test", "--match -m --timeout -T", "--match -m"],
  ["tap", "test", "--grep -g --reporter -R", "--grep -g"],
  [
    "eslint",
    "check",
    "-c --config --ext -f --format -o --output-file --rule --parser --resolve-plugins-relative-to --max-warnings --ignore-path --ignore-pattern --cache-location --env --global --plugin --rulesdir --parser-options --report-unused-disable-directives-severity --cache-strategy",
    "",
  ],
  ["oxlint", "check", "-c --config -A -D -W --format -f", ""],
  ["stylelint", "check", "--config -c --formatter -f --ignore-path", ""],
  [
    "mypy",
    "check",
    "--config-file -p --package -m --module --python-version --cache-dir --exclude --follow-imports --platform --junit-xml --python-executable",
    "",
  ],
  [
    "pyright",
    "check",
    "-p --project --pythonpath --pythonversion --level --threads --pythonplatform -t --typeshedpath --venvpath",
    "",
  ],
  [
    "basedpyright",
    "check",
    "-p --project --pythonpath --pythonversion --level --threads --pythonplatform -t --typeshedpath --venvpath",
    "",
  ],
  [
    "flake8",
    "check",
    "--config --select --ignore --extend-ignore --max-line-length --exclude --format",
    "",
  ],
  ["pylint", "check", "--rcfile --disable --enable -j --jobs --output-format --load-plugins", ""],
  [
    "rspec",
    "test",
    "-e --example -E --example-matches -t --tag -f --format -o --out -r --require -I --seed --order -P --pattern --exclude-pattern --default-path",
    "-e --example -E --example-matches -t --tag --only-failures --next-failure -P --pattern",
  ],
  ["rubocop", "check", "-c --config -f --format --only --except --require -r -o --out", ""],
  ["phpunit", "test", PHPUNIT_VALUE.join(" "), "--filter --group --testsuite"],
  ["pest", "test", PHPUNIT_VALUE.join(" "), "--filter --group --testsuite"],
  ["psalm", "check", "-c --config --threads --output-format", ""],
  ["staticcheck", "check", "-checks -f -tags", ""],
] as const)
  PROGRAMS[name] = pathRule(cls, name, words(values), filters);
for (const [name, flags, values] of [
  ["prettier", "--check -c --list-different -l", "--config --ignore-path --plugin --parser"],
  ["black", "--check --diff", "--config -l --line-length -t --target-version --include --exclude"],
  ["isort", "--check --check-only -c --diff", "--settings-path --sp --profile"],
] as const)
  PROGRAMS[name] = flagRule(name, words(flags), words(values));
for (const name of ["tox", "nox"])
  PROGRAMS[name] = (args) => [
    "test",
    name,
    args.includes("--") && args.indexOf("--") < args.length - 1,
  ];
const SUB_RULES: [string, Record<string, [RunClass, string, string, boolean]>, string][] = [
  [
    "playwright",
    { test: ["test", "playwright test", "-g --grep --last-failed --only-changed", true] },
    "-g --grep --project -c --config --reporter --workers -j --shard --retries --timeout --grep-invert",
  ],
  [
    "cypress",
    { run: ["test", "cypress run", "--spec -s", false] },
    "--spec -s --browser -b --config -c --env -e --project -P",
  ],
  [
    "biome",
    {
      check: ["check", "biome", "", true],
      lint: ["check", "biome", "", true],
      ci: ["check", "biome", "", true],
    },
    "--config-path --reporter --max-diagnostics",
  ],
  ["astro", { check: ["check", "astro check", "", false] }, ""],
  [
    "rails",
    { test: ["test", "rails test", "-n --name", true] },
    "-n --name -e --environment --seed",
  ],
  [
    "phpstan",
    { analyse: ["check", "phpstan", "", true], analyze: ["check", "phpstan", "", true] },
    "-c --configuration -l --level --memory-limit --error-format",
  ],
  [
    "mix",
    {
      test: ["test", "mix test", "--only --failed --stale --include", true],
      compile: ["build", "mix compile", "", false],
      credo: ["check", "mix credo", "", false],
      dialyzer: ["check", "mix dialyzer", "", false],
    },
    "--only --include --exclude --seed --max-failures --partitions",
  ],
  ["zig", { test: ["test", "zig test", "", false], build: ["build", "zig build", "", false] }, ""],
  [
    "stack",
    {
      test: ["test", "stack test", "--ta --test-arguments", false],
      build: ["build", "stack build", "", false],
    },
    "--ta --test-arguments",
  ],
  [
    "cabal",
    {
      test: ["test", "cabal test", "--test-options --test-option", false],
      build: ["build", "cabal build", "", false],
    },
    "--test-options --test-option",
  ],
  [
    "dart",
    {
      test: ["test", "dart test", "-n --name -N --plain-name -t --tags", true],
      analyze: ["check", "dart analyze", "", false],
    },
    "-n --name -N --plain-name -t --tags -p --platform -j --concurrency -r --reporter",
  ],
  [
    "flutter",
    {
      test: ["test", "flutter test", "-n --name --plain-name -t --tags", true],
      analyze: ["check", "flutter analyze", "", false],
      build: ["build", "flutter build", "", false],
    },
    "-n --name --plain-name -t --tags -r --reporter --flavor",
  ],
  [
    "golangci-lint",
    { run: ["check", "golangci-lint", "", true] },
    "-c --config --timeout -E --enable -D --disable --out-format",
  ],
  ["swift-format", { lint: ["check", "swift-format", "", false] }, ""],
  ["terraform", { validate: ["check", "terraform validate", "", false] }, ""],
  [
    "pre-commit",
    { run: ["check", "pre-commit", "--files", false] },
    "--files --hook-stage --from-ref --to-ref",
  ],
  ["vite", { build: ["build", "vite build", "", false] }, ""],
  [
    "next",
    { build: ["build", "next build", "", false], lint: ["check", "next lint", "", false] },
    "",
  ],
  ["nuxt", { build: ["build", "nuxt build", "", false] }, ""],
  [
    "ng",
    {
      build: ["build", "ng build", "", false],
      test: ["test", "ng test", "--include", false],
      lint: ["check", "ng lint", "", false],
    },
    "--include --configuration -c --project",
  ],
];
for (const [name, table, values] of SUB_RULES) PROGRAMS[name] = subRule(table, words(values));
PROGRAMS.bazel = (args) => {
  if (!has(["test", "build"], args[0])) return OTHER();
  const o = parseOpts(args.slice(1), words("--config --test_filter --test_output --jobs -j"));
  return [
    args[0] as "test" | "build",
    "bazel " + args[0],
    o.pos.some((p) => !has(["//...", "...", "//:all"], p)) ||
      args.some((a) => a.startsWith("--test_filter")),
  ];
};
PROGRAMS.meson = (args) => {
  if (args[0] === "compile") return ["build", "meson compile", false];
  if (args[0] !== "test") return OTHER();
  const o = parseOpts(
    args.slice(1),
    words("-C --suite --no-suite --num-processes --repeat --timeout-multiplier --setup --wrapper"),
  );
  return ["test", "meson test", !!o.pos.length || "--suite" in o.opts];
};
const SCRIPT_LABELS: Record<string, [string, string]> = {
  npm: ["npm test", "npm run "],
  pnpm: ["pnpm test", "pnpm run "],
  yarn: ["yarn test", "yarn run "],
  bun: ["bun run test", "bun run "],
  deno: ["deno task test", "deno task "],
  composer: ["composer test", "composer "],
  make: ["make test", "make "],
  ninja: ["ninja test", "ninja "],
  just: ["just test", "just "],
  task: ["task test", "task "],
  rake: ["rake test", "rake "],
  mise: ["mise run test", "mise run "],
  turbo: ["turbo test", "turbo "],
  nx: ["nx test", "nx "],
};
function scriptClass(runner: string, name: string): [RunClass, string | null] {
  const n = taskLower(name),
    canon = Object.hasOwn(SCRIPT_ALIASES, n) ? SCRIPT_ALIASES[n] : n;
  if (has(["make", "ninja"], runner) && canon === "check") return ["test", runner + " check"];
  if (has(["make", "ninja"], runner) && canon === "all") return ["build", runner];
  const cls = Object.hasOwn(SCRIPT_CLASSES, canon) ? SCRIPT_CLASSES[canon] : null;
  if (cls)
    return [cls, canon === "test" ? SCRIPT_LABELS[runner][0] : SCRIPT_LABELS[runner][1] + canon];
  const first = n.split(/[:._/-]/)[0];
  if (
    has(
      words(
        "test tests spec specs unit e2e integration coverage cov jest vitest mocha pytest ctest playwright cypress",
      ),
      first,
    )
  )
    return ["test", null];
  if (has(words("build compile bundle dist all"), first)) return ["build", null];
  if (
    has(
      words(
        "lint typecheck types tsc check eslint ruff mypy pyright clippy vet analyze analyse verify validate",
      ),
      first,
    )
  )
    return ["check", null];
  return ["other", null];
}
function forwardedTargeted(args: string[], cwd: string | null): boolean {
  const list = args.filter((a) => a !== "--");
  for (let k = 0; k < list.length; k++) {
    const w = list[k];
    if (
      FORWARD_FILTERS.includes(w) ||
      FORWARD_FILTERS.some((f) => f.startsWith("--") && w.startsWith(f + "="))
    )
      return true;
    if (w.startsWith("-")) {
      if (FORWARD_VALUE.includes(w)) k++;
    } else if (nameTargeted([w], cwd)) return true;
  }
  return false;
}
function packageScript(
  runner: string,
  rest: string[],
  cwd: string | null,
  narrow: boolean,
): Classification {
  const sub = rest[0],
    before = rest.slice(1, rest.includes("--") ? rest.indexOf("--") : rest.length);
  if (
    before.some(
      (w) => PM_NARROW.includes(w) || w.startsWith("--workspace=") || w.startsWith("--filter="),
    )
  ) {
    narrow = true;
    rest = rest.filter(
      (w, i) =>
        !(
          PM_NARROW.includes(w) ||
          (i > 0 && PM_NARROW.includes(rest[i - 1]) && i <= before.length) ||
          w.startsWith("--workspace=") ||
          w.startsWith("--filter=")
        ),
    );
  }
  let name: string, fwd: string[];
  if (has(["test", "t", "tst"], sub)) {
    name = "test";
    fwd = rest.slice(1);
  } else if (has(["run", "run-script", "rum", "urn"], sub)) {
    const j = dropOptions(rest.slice(1), 0, PM_NARROW, false) + 1;
    if (j >= rest.length) return OTHER();
    name = rest[j];
    fwd = rest.slice(j + 1);
  } else if (
    has(["pnpm", "yarn", "bun"], runner) &&
    !NPM_BUILTINS.includes(sub) &&
    !extension(sub)
  ) {
    const program = taskProgram(sub);
    if (PROGRAMS[program] && !(program in SCRIPT_LABELS)) return classify(rest, cwd);
    name = sub;
    fwd = rest.slice(1);
  } else return OTHER();
  const result = scriptClass(runner, name);
  return result[0] === "other"
    ? OTHER()
    : [result[0], result[1], narrow || forwardedTargeted(fwd, cwd)];
}
function packageManager(runner: string): Handler {
  const handler: Handler = (args, cwd) => {
    let k = 0,
      narrow = false;
    while (k < args.length && args[k].startsWith("-")) {
      const w = args[k];
      if (PM_VALUE.has(w)) {
        narrow ||= PM_NARROW.includes(w);
        k += 2;
      } else {
        narrow ||= w.startsWith("--workspace=") || w.startsWith("--filter=");
        k++;
      }
    }
    const rest = args.slice(k);
    if (!rest.length) return OTHER();
    const sub = rest[0];
    if (runner === "yarn" && sub === "workspace" && rest.length >= 3) {
      const result = handler(rest.slice(2), cwd);
      return [result[0], result[1], true];
    }
    if (runner === "bun" && sub === "test") {
      const o = parseOpts(rest.slice(1), BUN_TEST_VALUE);
      return [
        "test",
        "bun test",
        opt(o.opts, "-t --test-name-pattern") || nameTargeted([...o.pos, ...o.after], cwd),
      ];
    }
    if (runner === "bun" && sub === "build") return ["build", "bun build", false];
    return packageScript(runner, rest, cwd, narrow);
  };
  return handler;
}
for (const runner of ["npm", "pnpm", "yarn", "bun"]) PROGRAMS[runner] = packageManager(runner);
const TASK_RUN_PREFIXES: Record<string, string[]> = {
  mise: words("run r"),
  deno: words("task"),
  turbo: words("run"),
  composer: words("run-script run"),
};
function nxTaskRunner(rest: string[]): Classification | null {
  if (has(["run-many", "affected"], rest[0])) {
    const o = parseOpts(rest.slice(1), words("-t --target --targets -p --projects")),
      target = o.opts["-t"] || o.opts["--target"] || o.opts["--targets"];
    if (typeof target !== "string") return OTHER();
    const result = scriptClass("nx", target.split(",")[0]);
    return result[0] === "other"
      ? OTHER()
      : [result[0], result[1], typeof (o.opts["-p"] || o.opts["--projects"]) === "string"];
  }
  if (rest[0] === "run" && rest[1]?.includes(":")) {
    const result = scriptClass("nx", rest[1].split(":")[1]);
    return result[0] === "other" ? OTHER() : [result[0], result[1], true];
  }
  return null;
}
function taskRunnerTargets(
  runner: string,
  pos: string[],
  assignments: string[],
  cwd: string | null,
): Classification {
  let best = scriptClass(runner, pos[0]),
    narrow: boolean;
  if (has(["make", "ninja", "rake"], runner)) {
    for (let k = 1; k < pos.length; k++) {
      const result = scriptClass(runner, pos[k]);
      if (RANK[result[0]] > RANK[best[0]]) best = result;
    }
    narrow = assignments.some((a) =>
      /^(?:TESTS?|T|TEST_?ARGS|TEST_?FILTER|FILTER|RUN|ONLY|K|PKG|PACKAGE|FILES?|SPEC|ARGS|PYTEST_?ARGS|TESTNAME|CASE|TESTOPTS)$/.test(
        a.replace(/[a-z]/g, (c) => c.toUpperCase()),
      ),
    );
  } else
    narrow =
      pos.length > 1 &&
      (runner === "just" || runner === "nx" || forwardedTargeted(pos.slice(1), cwd));
  return best[0] === "other" ? OTHER() : [best[0], best[1], narrow];
}
function taskRunner(
  runner: string,
  values: string[],
  fallback: Classification | null = null,
): Handler {
  return (args, cwd) => {
    let rest = args;
    if (TASK_RUN_PREFIXES[runner]?.includes(rest[0])) rest = rest.slice(1);
    if (runner === "nx") {
      const result = nxTaskRunner(rest);
      if (result !== null) return result;
    }
    const pos: string[] = [],
      assignments: string[] = [];
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k];
      if (w.startsWith("-")) {
        if (values.includes(w)) k += runner === "just" && w === "--set" ? 2 : 1;
      } else if (NAME_ASSIGN.test(w)) assignments.push(w.split("=")[0]);
      else pos.push(w);
    }
    if (
      runner === "composer" &&
      has(
        words(
          "install update require remove dump-autoload dumpautoload show outdated validate create-project init config global exec search why why-not licenses audit status archive diagnose self-update depends prohibits fund reinstall bump check-platform-reqs clear-cache browse suggests",
        ),
        pos[0],
      )
    )
      return OTHER();
    if (!pos.length) return fallback ? [...fallback] : OTHER();
    return taskRunnerTargets(runner, pos, assignments, cwd);
  };
}
for (const [runner, values, defaultSuite] of [
  [
    "make",
    "-C --directory -f --file --makefile -I --include-dir -o --old-file -W --what-if -j -l",
    "make",
  ],
  ["ninja", "-C -f -j -k -l -d -t -w", "ninja"],
  [
    "just",
    "-f --justfile -d --working-directory --set --dotenv-path --dotenv-filename --shell --shell-arg --chooser --color --command --list-heading --list-prefix",
    null,
  ],
  ["task", "-d --dir -t --taskfile -o --output -c --color", null],
  ["rake", "-f --rakefile -I --libdir -r --require -C --directory", null],
  ["mise", "-C --cd -E --env -j --jobs", null],
  ["turbo", "--filter -F --concurrency --output-logs --cache-dir", null],
  ["nx", "-c --configuration --parallel --output-style", null],
  ["composer", "-d --working-dir", null],
] as const)
  PROGRAMS[runner] = taskRunner(
    runner,
    words(values),
    defaultSuite ? ["build", defaultSuite, false] : null,
  );
PROGRAMS.deno = (args, cwd) => {
  const sub = args[0],
    rest = args.slice(1);
  if (sub === "test") {
    const o = parseOpts(
      rest,
      words(
        "--filter --allow-read --allow-net --allow-env --config -c --reporter --coverage --jobs --shuffle --seed",
      ),
    );
    return ["test", "deno test", "--filter" in o.opts || pathTargeted([...o.pos, ...o.after], cwd)];
  }
  if (sub === "check" || sub === "lint" || (sub === "fmt" && rest.includes("--check")))
    return ["check", "deno " + sub, false];
  return sub === "task" ? taskRunner("deno", [])(args, cwd) : OTHER();
};
function classify(list: string[], cwd: string | null): Classification {
  return list.length ? (PROGRAMS[taskProgram(list[0])]?.(list.slice(1), cwd) ?? OTHER()) : OTHER();
}
function choose(
  parsed: TaskShell,
  cwd: string | null,
): { classes: Classification[]; index: number | null; best: Classification } {
  let best = OTHER(),
    index: number | null = null;
  const classes = parsed.segments.map((seg, k) => {
    const c =
      seg.words.length && !NEUTRAL.includes(taskProgram(seg.words[0]))
        ? classify(seg.words, cwd)
        : OTHER();
    if (RANK[c[0]] > RANK[best[0]]) {
      best = c;
      index = k;
    }
    return c;
  });
  return { classes, index, best };
}
function segmentTokens(seg: Segment): string[] {
  if (!seg.words.length) return [];
  const p = taskProgram(seg.words[0]);
  let tokens = [
    p,
    ...seg.words
      .slice(1)
      .filter(
        (w) =>
          !COSMETIC.includes(w) &&
          !COSMETIC_PREFIX.some((prefix) => w.startsWith(prefix)) &&
          !(p === "pytest" && (w === "-s" || /^-r[A-Za-z]+$/.test(w) || w === "--capture=no")),
      ),
  ];
  if (has(["npm", "pnpm", "yarn"], p) && has(["test", "t", "tst"], tokens[1]))
    tokens = [p, "run", "test", ...tokens.slice(2)];
  else if (has(["npm", "pnpm", "yarn", "bun"], p) && has(["run-script", "rum", "urn"], tokens[1]))
    tokens = [p, "run", ...tokens.slice(2)];
  else if (
    has(["pnpm", "yarn"], p) &&
    tokens[1] &&
    !NPM_BUILTINS.includes(tokens[1]) &&
    !tokens[1].startsWith("-")
  )
    tokens = [p, "run", ...tokens.slice(1)];
  return seg.ctx ? ["@" + seg.ctx, ...tokens] : tokens;
}
function pipelineEnd(segs: Segment[], k: number): number {
  while (k + 1 < segs.length && segs[k].after === "|") k++;
  return k;
}
function appendGrepArgument(
  word: string,
  name: string,
  patterns: string[],
  positional: string[],
): boolean {
  if (
    word.length > 2 &&
    has(["-e", "-A", "-B", "-C", "-m"], word.slice(0, 2)) &&
    !word.startsWith("--")
  ) {
    if (word.startsWith("-e")) patterns.push(word.slice(2));
    return true;
  }
  if (
    has(
      words(
        "--ignore-case --extended-regexp --line-number --word-regexp --fixed-strings --perl-regexp --text --no-messages --no-filename --with-filename --only-matching",
      ),
      word,
    ) ||
    name === "--color" ||
    name === "--colour"
  )
    return true;
  if (word.startsWith("-") && word.length > 1 && !word.startsWith("--")) {
    for (const flag of word.slice(1)) {
      if (!"iEnwFPashHo".includes(flag)) return false;
    }
    return true;
  }
  if (word.startsWith("--")) return false;
  positional.push(word);
  return true;
}
function grepPatterns(list: string[]): string[] | null {
  const patterns: string[] = [],
    positional: string[] = [],
    values = words(
      "-e -A -B -C -m --regexp --after-context --before-context --context --max-count",
    );
  for (let i = 1; i < list.length; i++) {
    const w = list[i],
      eq = w.indexOf("="),
      name = eq < 0 ? w : w.slice(0, eq);
    if (w === "--") {
      positional.push(...list.slice(i + 1));
      break;
    }
    if (values.includes(w) || (w.startsWith("--") && eq >= 0 && values.includes(name))) {
      const arg = eq >= 0 ? w.slice(eq + 1) : list[++i];
      if (arg === undefined) return null;
      if (name === "-e" || name === "--regexp") patterns.push(arg);
    } else if (!appendGrepArgument(w, name, patterns, positional)) return null;
  }
  if (!patterns.length) {
    if (!positional.length) return null;
    patterns.push(positional.shift()!);
  }
  return positional.length ? null : patterns;
}
export function taskCommandInfo(
  text: string,
  cwd: string | null = null,
  parsed = taskParseShell(text, cwd),
): TaskCommandInfo {
  const { classes, index, best } = choose(parsed, cwd),
    segs = parsed.segments;
  let kept = segs.filter((_s, k) => classes[k][0] !== "other");
  if (!kept.length)
    kept = segs.filter((s) => s.words.length && !NEUTRAL.includes(taskProgram(s.words[0])));
  if (!kept.length) kept = segs.filter((s) => s.words.length);
  const key = taskSha16(kept.map((s) => segmentTokens(s).join("\x1f")).join("\x1e"));
  if (index === null)
    return {
      class: "other",
      suite: null,
      targeted: false,
      key,
      masked: false,
      background: segs.some((s) => s.background),
      errorFilter: false,
    };
  const chosen = segs[index],
    later = segs.slice(index + 1),
    end = pipelineEnd(segs, index),
    patterns = grepPatterns(segs[index + 1]?.words ?? []);
  const errorFilter =
    has(["build", "check"], best[0]) &&
    end !== index &&
    end === segs.length - 1 &&
    chosen.after === "|" &&
    has(["grep", "egrep"], taskProgram(segs[index + 1]?.words[0] ?? "")) &&
    !!patterns?.some((p) => taskLower(p).includes("error")) &&
    segs
      .slice(index + 2, end + 1)
      .every((s) => s.words.length && has(["head", "tail"], taskProgram(s.words[0])));
  return {
    class: best[0],
    suite: best[1],
    targeted: best[2],
    key,
    masked:
      !!later.length &&
      ((chosen.after === "|" && !parsed.pipefail) ||
        later.some((s) => has([";", "||", "&"], s.before ?? ""))),
    background: chosen.background,
    errorFilter,
  };
}
interface EchoStatus {
  prefix: string;
  suffix: string | null;
  index: number | null;
}
interface MaskedStatusResult {
  exitCode: number | null;
  failed: boolean;
}
function echoStatus(seg: Segment): EchoStatus | null {
  if (
    seg.words.length < 2 ||
    taskProgram(seg.words[0]) !== "echo" ||
    seg.redirs.length ||
    seg.heredocs.length ||
    seg.words[1].startsWith("-")
  )
    return null;
  const message = seg.words.slice(1).join(" "),
    refs = [...message.matchAll(/\$\?|\$\{\?\}|\$\{PIPESTATUS\[([0-9]+)\]\}|\$PIPESTATUS/g)];
  if (refs.length > 1) return null;
  if (!refs.length)
    return /[$`]/.test(message) || !taskTrim(message)
      ? null
      : { prefix: message, suffix: null, index: null };
  const ref = refs[0],
    prefix = message.slice(0, ref.index),
    suffix = message.slice(ref.index! + ref[0].length);
  if (/[$`]/.test(prefix + suffix)) return null;
  let index: number | null = null;
  if (ref[0] === "$PIPESTATUS") index = 0;
  else if (ref[1] !== undefined) index = Number(ref[1]);
  return { prefix, suffix, index };
}
function printedStatus(last: string, prefix: string, suffix: string): number | null {
  prefix = prefix.replace(/^[ \t]+/, "");
  suffix = suffix.replace(/[ \t]+$/, "");
  if (
    last.length < prefix.length + suffix.length ||
    !last.startsWith(prefix) ||
    !last.endsWith(suffix)
  )
    return null;
  const middle = last.slice(prefix.length, last.length - suffix.length);
  return /^-?[0-9]+$/.test(middle) ? taskNumber(middle) : null;
}
function failureEchoStatus(failure: EchoStatus, last: string): MaskedStatusResult | null {
  if (failure.suffix === null)
    return last === taskTrim(failure.prefix) ? { exitCode: null, failed: true } : null;
  const value = printedStatus(last, failure.prefix, failure.suffix);
  return value !== null && value !== 0 ? { exitCode: value, failed: true } : null;
}
function conditionalEchoStatus(
  after: Segment[],
  texts: (EchoStatus | null)[],
  last: string,
): MaskedStatusResult | null {
  const first = texts[0],
    second = texts[1];
  let failure: EchoStatus | undefined;
  if (
    after.length === 2 &&
    after[0].before === "&&" &&
    after[1].before === "||" &&
    first?.suffix === null &&
    second &&
    (second.suffix !== null || taskTrim(second.prefix) !== taskTrim(first.prefix))
  ) {
    if (last === taskTrim(first.prefix)) return { exitCode: 0, failed: false };
    failure = second;
  } else if (after.length === 1 && after[0].before === "||") failure = first ?? undefined;
  return failure ? failureEchoStatus(failure, last) : null;
}
function maskedOutputStatus(parsed: TaskShell, k: number, last: string): MaskedStatusResult | null {
  const end = pipelineEnd(parsed.segments, k),
    own = end === k || parsed.pipefail,
    after = parsed.segments.slice(end + 1);
  let start = k;
  while (start > 0 && parsed.segments[start].before === "|") start--;
  const texts = after.map(echoStatus);
  if (!texts.every((t) => t !== null)) return null;
  const first = texts[0];
  if (
    after.length === 1 &&
    after[0].before === ";" &&
    first?.suffix !== null &&
    first &&
    (first.index === null ? own : first.index === k - start)
  ) {
    const value = printedStatus(last, first.prefix, first.suffix);
    return value === null ? null : { exitCode: value, failed: value !== 0 };
  }
  return own && texts.every((t) => t!.index === null)
    ? conditionalEchoStatus(after, texts, last)
    : null;
}
export function taskMaskedStatus(
  text: string,
  output: string,
  cwd: string | null,
  parsed = taskParseShell(text, cwd),
): { exitCode: number | null; failed: boolean } | null {
  const info = taskCommandInfo(text, cwd, parsed);
  if (!info.masked) return null;
  const k = choose(parsed, cwd).index,
    lines = taskLf(output).split("\n").map(taskTrim).filter(Boolean),
    last = lines.at(-1);
  if (k !== null && last !== undefined) {
    const result = maskedOutputStatus(parsed, k, last);
    if (result) return result;
  }
  return info.errorFilter &&
    (!output.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "") ||
      taskTrim(output) === "(Bash completed with no output)")
    ? { exitCode: null, failed: false }
    : null;
}
export function taskShellKind(parsed: TaskShell, cwd: string | null): MonitorTaskActionKind {
  if (parsed.applyPatch || parsed.patches.length) return "edit";
  if (taskCommandInfo("", cwd, parsed).class !== "other") return "command";
  if (
    parsed.segments.some((s) =>
      s.redirs.some(
        ([op, target]) =>
          has([">", ">>", ">|", "&>", "&>>", "<>"], op) &&
          !has(["/dev/null", "NUL", "nul"], target) &&
          !/^[0-9-]+$/.test(target),
      ),
    )
  )
    return "command";
  const segs = parsed.segments.filter(
    (s) => s.words.length && !NEUTRAL.includes(taskProgram(s.words[0])),
  );
  if (!segs.length) return "command";
  let search = false;
  for (const seg of segs) {
    const p = taskProgram(seg.words[0]),
      args = seg.words.slice(1);
    if (p === "git") {
      const sub =
        args[
          dropOptions(
            args,
            0,
            words("-C -c --git-dir --work-tree --namespace --exec-path --config-env"),
          )
        ];
      if (
        has(
          words(
            "status diff log show blame rev-parse ls-tree cat-file describe shortlog reflog branch remote tag config",
          ),
          sub,
        )
      )
        continue;
      if (sub === "grep" || sub === "ls-files") search = true;
      else return "command";
    } else if (p === "sed" && args.some((a) => a.startsWith("-i") || a.startsWith("--in-place")))
      return "command";
    else if (
      has(
        words(
          "cat head tail less more nl wc ls tree stat file pwd bat batcat sed awk jq yq realpath readlink du basename dirname od xxd hexdump strings diff cmp sort uniq cut tr column which type whereis printenv date env exa eza lsd",
        ),
        p,
      )
    )
      continue;
    else if (has(words("rg grep egrep fgrep ag ack find fd fdfind locate mdfind"), p)) {
      if (
        p === "find" &&
        args.some((a) => has(words("-delete -exec -execdir -ok -okdir -fprint -fprintf -fls"), a))
      )
        return "command";
      search = true;
    } else return "command";
  }
  return search ? "search" : "read";
}
export function taskCommandText(tool: string, input: unknown): string | null {
  if (taskLower(tool) !== "bash") return null;
  const args = taskArgs(input);
  return typeof args?.command === "string" ? taskScalars(args.command) : null;
}

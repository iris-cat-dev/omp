// Known tool catalogs are UI hints; launch arguments are filtered against OMP's active tools.
export const OMP_BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "eval",
  "github",
  "glob",
  "grep",
  "find",
  "lsp",
  "checkpoint",
  "rewind",
  "context_notes",
  "new_context",
  "security_scan",
  "task",
  "wait",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
] as const;

export const OMP_LEGACY_BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "glob",
  "lsp",
  "python",
  "notebook",
  "browser",
  "computer",
  "task",
  "todo",
  "web_search",
  "ask",
] as const;

const ALL_KNOWN_BUILTIN_TOOL_NAMES = [
  ...OMP_BUILTIN_TOOL_NAMES,
  ...OMP_LEGACY_BUILTIN_TOOL_NAMES.filter(
    (name) => !(OMP_BUILTIN_TOOL_NAMES as readonly string[]).includes(name),
  ),
];

/** Use a known release's catalog when available, without restricting other releases. */
export function getOmpBuiltinToolNames(version: string | undefined): readonly string[] {
  const release = /\b(\d+\.\d+\.\d+)\b/.exec(version ?? "")?.[1];
  if (release === "18.2.10") return OMP_LEGACY_BUILTIN_TOOL_NAMES;
  if (/^18\.3\.\d+$/.test(release ?? "")) return OMP_BUILTIN_TOOL_NAMES;
  return ALL_KNOWN_BUILTIN_TOOL_NAMES;
}

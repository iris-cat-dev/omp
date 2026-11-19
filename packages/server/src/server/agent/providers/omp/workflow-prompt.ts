const OMP_PLAN_TURN_PREFIX = `<system-directive>
Plan mode active for this turn. The working tree and system are read-only: NEVER create, edit, delete, or rename files, and NEVER run state-changing commands. You may inspect with read-only tools. Produce or refine the requested plan only.
</system-directive>\n\n`;
const OMP_STANDARD_TURN_PREFIX = `<system-directive>
Plan mode is inactive for this turn. All earlier per-turn Plan mode directives have expired. Follow the current user request normally; working-tree changes are permitted subject to the active tool-approval policy.
</system-directive>\n\n`;
const OMP_CHAT_TURN_PREFIX = `<system-directive>
Chat mode active for this turn. Answer questions and discuss directly using only the available read-only tools (read, glob, grep). NEVER attempt to edit files, run commands, or modify system state; if changes are requested, explain the approach and suggest switching back to Standard workflow.
</system-directive>\n\n`;
const OMP_CHAT_EXIT_TURN_PREFIX = `<system-directive>
Chat mode is inactive for this turn. All earlier per-turn Chat mode directives have expired. Full tools are restored; follow the current user request normally subject to the active tool-approval policy.
</system-directive>\n\n`;

const OMP_TOOL_INTENT_LANGUAGES = {
  ar: "Arabic",
  en: "English",
  es: "Spanish",
  fr: "French",
  ja: "Japanese",
  ko: "Korean",
  "pt-BR": "Brazilian Portuguese",
  ru: "Russian",
  "zh-CN": "Simplified Chinese",
} as const;

function isOmpToolIntentLocale(locale: unknown): locale is keyof typeof OMP_TOOL_INTENT_LANGUAGES {
  return typeof locale === "string" && Object.hasOwn(OMP_TOOL_INTENT_LANGUAGES, locale);
}

function toolIntentDirective(locale: keyof typeof OMP_TOOL_INTENT_LANGUAGES): string {
  return `<system-directive>\nDesktop tool intent locale: ${locale}. When a tool's schema includes an \`i\` intent label, write it in ${OMP_TOOL_INTENT_LANGUAGES[locale]}. Do not pass \`i\` to tools whose schemas do not declare it. This instruction replaces earlier Desktop tool intent locale directives. It does not change assistant response language, commands, code, or other tool arguments.\n</system-directive>\n\n`;
}

function legacyToolIntentDirective(locale: keyof typeof OMP_TOOL_INTENT_LANGUAGES): string {
  return `<system-directive>\nDesktop tool intent locale: ${locale}. Write only tool-call i intent labels in ${OMP_TOOL_INTENT_LANGUAGES[locale]}. This instruction replaces earlier Desktop tool intent locale directives. It does not change assistant response language, commands, code, or other tool arguments.\n</system-directive>\n\n`;
}

const OMP_WORKFLOW_DISPLAY_PREFIXES = [
  OMP_PLAN_TURN_PREFIX,
  OMP_STANDARD_TURN_PREFIX,
  OMP_CHAT_TURN_PREFIX,
  OMP_CHAT_EXIT_TURN_PREFIX,
  ...Object.keys(OMP_TOOL_INTENT_LANGUAGES)
    .filter(isOmpToolIntentLocale)
    .flatMap((locale) => [toolIntentDirective(locale), legacyToolIntentDirective(locale)]),
];
const OMP_WORKFLOW_DISPLAY_DIRECTIVES = new Set(
  OMP_WORKFLOW_DISPLAY_PREFIXES.map((prefix) => prefix.trimEnd()),
);

export function buildOmpToolIntentPrompt(prompt: string, locale: unknown): string {
  if (!isOmpToolIntentLocale(locale)) return prompt;
  // Keep skill dispatch at the start; the extra separator preserves bare commands and argument whitespace.
  const skill = /^(\s*\/skill:[^\s]+)([\s\S]*)$/.exec(prompt);
  if (skill) return `${skill[1]}\n${toolIntentDirective(locale)}${skill[2]}`;
  // Preserve native workflow dispatch. Other slash commands retain their exact arguments.
  const command = /^(\s*\/(?:plan|goal)\s+)([\s\S]+)$/.exec(prompt);
  if (command) return `${command[1]}${toolIntentDirective(locale)}${command[2]}`;
  if (/^\s*\//.test(prompt)) return prompt;
  return `${toolIntentDirective(locale)}${prompt}`;
}

export function buildOmpPlanTurnPrompt(prompt: string): string {
  return `${OMP_PLAN_TURN_PREFIX}${prompt}`;
}

export function buildOmpStandardTurnPrompt(prompt: string): string {
  return `${OMP_STANDARD_TURN_PREFIX}${prompt}`;
}

export function buildOmpChatTurnPrompt(prompt: string): string {
  return `${OMP_CHAT_TURN_PREFIX}${prompt}`;
}

export function buildOmpChatExitTurnPrompt(prompt: string): string {
  return `${OMP_CHAT_EXIT_TURN_PREFIX}${prompt}`;
}

export function getOmpWorkflowDisplayText(prompt: string): string {
  let text = prompt;
  for (;;) {
    const prefix = OMP_WORKFLOW_DISPLAY_PREFIXES.find((candidate) => text.startsWith(candidate));
    if (prefix) {
      text = text.slice(prefix.length);
      continue;
    }
    // OMP trims bare skill prompts and arguments before recording them.
    if (OMP_WORKFLOW_DISPLAY_DIRECTIVES.has(text)) return "";
    const skill = /^(\s*\/skill:[^\s]+)\n([\s\S]+)$/.exec(text);
    if (skill) {
      const displayArgs = getOmpWorkflowDisplayText(skill[2]!);
      if (displayArgs !== skill[2]) return `${skill[1]}${displayArgs}`;
    }
    const command = /^(\s*\/(?:plan|goal)\s+)([\s\S]+)$/.exec(text);
    if (command) {
      const displayArgs = getOmpWorkflowDisplayText(command[2]!);
      if (displayArgs !== command[2]) return `${command[1]}${displayArgs}`;
    }
    return text;
  }
}

import { z } from "zod";
import type { PluginThemeContribution } from "@omp-desktop/plugin";
import { resolvePluginIcon } from "./icons";
import type { PluginContributions } from "./registry";

const hexColor = z.string().regex(/^#(?:[\da-fA-F]{3}|[\da-fA-F]{6}|[\da-fA-F]{8})$/);
const themeSchema: z.ZodType<PluginThemeContribution> = z.strictObject({
  id: z.string(), name: z.string().trim().min(1).max(60), appearance: z.enum(["light", "dark"]),
  colors: z.strictObject({ background: hexColor, foreground: hexColor, raised: hexColor, control: hexColor, border: hexColor, accent: hexColor.optional(), mutedForeground: hexColor, ring: hexColor }),
});

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Plugin ${label} must be a non-empty string`);
  return value.trim();
}
function requireId(value: unknown, label: string): string {
  const id = requireText(value, label);
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(id)) throw new Error(`Invalid plugin ${label}: ${id}`);
  return id;
}

export function validatePluginContribution<K extends keyof PluginContributions>(kind: K, value: PluginContributions[K]): PluginContributions[K] {
  const id = requireId(value.id, `${kind} id`);
  const parsed: Record<string, unknown> = { ...value, id };
  const needsTitle = kind === "sidebar" || kind === "panel" || kind === "command" || kind === "attachment" || kind === "settings" || kind === "menu";
  const needsIcon = kind === "sidebar" || kind === "panel" || kind === "command" || kind === "attachment";
  if (needsTitle || parsed.title !== undefined) parsed.title = requireText(parsed.title, `${kind} ${id} title`);
  if (needsIcon || parsed.icon !== undefined) {
    parsed.icon = requireText(parsed.icon, `${kind} ${id} icon`);
    resolvePluginIcon(parsed.icon as string);
  }
  if (kind === "surface" || kind === "panel" || kind === "settings" || kind === "overlay" || kind === "metric") {
    const component = kind === "metric" ? parsed.component : parsed.Component;
    if (typeof component !== "function" && !(typeof component === "object" && component !== null && "$$typeof" in component)) throw new Error(`Plugin ${kind} ${id} has no React component`);
  }
  if ((kind === "command" || kind === "menu") && typeof parsed.onSelect !== "function") throw new Error(`Plugin ${kind} ${id} has no action callback`);
  if (kind === "panel" && parsed.context !== "workspace" && parsed.context !== "agent") throw new Error(`Plugin panel ${id} has invalid context`);
  if (kind === "command" && parsed.context !== "global" && parsed.context !== "workspace" && parsed.context !== "agent") throw new Error(`Plugin command ${id} has invalid context`);
  if (kind === "menu" && !["workspace", "agent", "tab", "application"].includes(parsed.position as string)) throw new Error(`Plugin menu ${id} has invalid position`);
  if (kind === "sidebar") parsed.surface = requireId(parsed.surface, `sidebar ${id} surface`);
  if (kind === "command" && parsed.keywords !== undefined) parsed.keywords = (parsed.keywords as string[]).map((keyword) => keyword.trim()).filter(Boolean);
  if (kind === "attachment") {
    parsed.pickerTitle = requireText(parsed.pickerTitle, `attachment ${id} picker title`);
    parsed.searchPlaceholder = requireText(parsed.searchPlaceholder, `attachment ${id} search placeholder`);
    const search = parsed.search as PluginContributions["attachment"]["search"];
    parsed.search = { ...search, name: requireText(search?.name, `attachment ${id} search RPC`) };
  }
  if (kind === "theme") return themeSchema.parse(parsed) as PluginContributions[K];
  return parsed as unknown as PluginContributions[K];
}

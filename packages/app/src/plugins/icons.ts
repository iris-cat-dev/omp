import * as LucideIcons from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";

export function resolvePluginIcon(name: string): LucideIcon {
  const key = name.includes("-") ? name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("") : name;
  const candidate: unknown = Reflect.get(LucideIcons, key);
  if (typeof candidate === "function" || (typeof candidate === "object" && candidate !== null && "$$typeof" in candidate)) return candidate as LucideIcon;
  throw new Error(`Unknown Lucide icon: ${name}`);
}

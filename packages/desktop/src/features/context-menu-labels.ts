export interface DesktopContextMenuLabels {
  addToDictionary: string;
  clear: string;
  copy: string;
  copyAddress: string;
  copyImage: string;
  cut: string;
  inspectElement: string;
  noSuggestions: string;
  openExternal: string;
  openInDesktop: string;
  paste: string;
  quitApp: string;
  saveImageAs: string;
  selectAll: string;
  showApp: string;
}

const DEFAULT_CONTEXT_MENU_LABELS: DesktopContextMenuLabels = {
  addToDictionary: "Add to Dictionary",
  clear: "Clear",
  copy: "Copy",
  copyAddress: "Copy Link Address",
  copyImage: "Copy Image",
  cut: "Cut",
  inspectElement: "Inspect Element",
  noSuggestions: "No suggestions",
  openExternal: "Open Link in Browser",
  openInDesktop: "Open in OMP Desktop",
  paste: "Paste",
  quitApp: "Quit",
  saveImageAs: "Save Image As…",
  selectAll: "Select All",
  showApp: "Show OMP Desktop",
};

let labels = DEFAULT_CONTEXT_MENU_LABELS;
const listeners = new Set<(labels: DesktopContextMenuLabels) => void>();

export function getDesktopContextMenuLabels(): DesktopContextMenuLabels {
  return labels;
}

export function setDesktopContextMenuLabels(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }

  const record = input as Record<string, unknown>;
  const next = { ...DEFAULT_CONTEXT_MENU_LABELS };
  for (const key of Object.keys(next) as Array<keyof DesktopContextMenuLabels>) {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      return false;
    }
    next[key] = value.trim();
  }

  labels = next;
  for (const listener of listeners) {
    listener(labels);
  }
  return true;
}

export function onDesktopContextMenuLabelsChange(
  listener: (labels: DesktopContextMenuLabels) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

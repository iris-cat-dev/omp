import { defaultKeymap, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import type { KeyBinding } from "@codemirror/view";

export function fileEditorKeymap(onSave: () => void): readonly KeyBinding[] {
  return [
    { key: "Ctrl-/", mac: "Ctrl-/", preventDefault: true, run: toggleComment },
    { key: "Mod-s", preventDefault: true, run: () => (onSave(), true) },
    indentWithTab,
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
  ];
}

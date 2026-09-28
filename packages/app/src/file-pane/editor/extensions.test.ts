/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { getLanguageForFile } from "../../../../highlight/src/index";
import { fileEditorKeymap } from "./keymap.web";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

function pressCtrlSlash(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "/",
    code: "Slash",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  view?.contentDOM.dispatchEvent(event);
  return event;
}

describe("file editor comment shortcut", () => {
  it("toggles comments on the selected lines with Ctrl+/", () => {
    const content = "const first = 1;\nconst second = 2;";
    const language = getLanguageForFile("example.ts");
    expect(language).not.toBeNull();

    const host = document.createElement("div");
    document.body.append(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        selection: { anchor: 0, head: content.length },
        extensions: [language!.extension, keymap.of(fileEditorKeymap(() => undefined))],
      }),
    });
    view.focus();

    const commentEvent = pressCtrlSlash();
    expect(commentEvent.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("// const first = 1;\n// const second = 2;");

    pressCtrlSlash();
    expect(view.state.doc.toString()).toBe(content);
  });
});

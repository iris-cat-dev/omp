import { history } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { search } from "@codemirror/search";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { createCodeMirrorHighlightStyle, type HighlightStyle } from "@omp-desktop/highlight";
import { createCursorSearchPanel } from "./search-panel.web";
import { fileEditorKeymap } from "./keymap.web";

export interface EditorVisualTheme {
  colorScheme: "light" | "dark";
  background: string;
  foreground: string;
  cursor: string;
  foregroundMuted: string;
  border: string;
  selection: string;
  monoFont: string;
  codeFontSize: number;
  syntax: Record<HighlightStyle, string>;
}

export function editorBaseExtensions(onSave: () => void) {
  return [
    lineNumbers(),
    search({ createPanel: createCursorSearchPanel }),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of(fileEditorKeymap(onSave)),
  ];
}

export function editorTheme(theme: EditorVisualTheme) {
  const searchPanelBackground = `color-mix(in srgb, ${theme.background} 88%, ${theme.foreground})`;
  const searchFieldBackground = `color-mix(in srgb, ${theme.background} 96%, ${theme.foreground})`;
  const searchHoverBackground = `color-mix(in srgb, ${theme.background} 84%, ${theme.foreground})`;
  const searchActiveBackground = `color-mix(in srgb, ${theme.background} 76%, ${theme.foreground})`;
  const searchShadow =
    theme.colorScheme === "dark"
      ? "0 10px 30px rgba(0, 0, 0, 0.42), 0 2px 8px rgba(0, 0, 0, 0.28)"
      : "0 10px 30px rgba(0, 0, 0, 0.13), 0 2px 8px rgba(0, 0, 0, 0.08)";

  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          position: "relative",
          backgroundColor: theme.background,
          color: theme.foreground,
          fontFamily: theme.monoFont,
          fontSize: `${theme.codeFontSize}px`,
          marginLeft: "12px",
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: theme.monoFont,
          lineHeight: "1.45",
        },
        ".cm-content": { caretColor: theme.foreground, padding: "16px 0" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: theme.cursor },
        ".cm-gutters": {
          backgroundColor: theme.background,
          color: theme.foregroundMuted,
          borderRight: `1px solid ${theme.border}`,
        },
        ".cm-activeLine": { backgroundColor: "transparent" },
        ".cm-activeLineGutter": { backgroundColor: "transparent", color: theme.foreground },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
          backgroundColor: theme.selection,
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: theme.selection,
        },
        "&.cm-focused": { outline: "none" },
        ".cm-panels-top:has(.omp-editor-search)": {
          borderBottom: "none",
          backgroundColor: "transparent",
        },
        ".cm-panel.omp-editor-search": {
          position: "absolute",
          top: "8px",
          right: "0",
          zIndex: "20",
          display: "flex",
          flexDirection: "column",
          width: "min(480px, calc(100% - 24px))",
          maxWidth: "calc(100% - 24px)",
          boxSizing: "border-box",
          gap: "4px",
          padding: "6px",
          color: theme.foreground,
          backgroundColor: searchPanelBackground,
          border: `1px solid ${theme.border}`,
          borderRadius: "7px",
          boxShadow: searchShadow,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          fontSize: "12px",
        },
        ".omp-editor-search-row": {
          display: "grid",
          gridTemplateColumns: "20px minmax(120px, 1fr) 64px 99px",
          alignItems: "center",
          gap: "4px",
          minWidth: "0",
        },
        ".omp-editor-search-field": {
          display: "flex",
          alignItems: "center",
          minWidth: "0",
          height: "28px",
          boxSizing: "border-box",
          overflow: "hidden",
          backgroundColor: searchFieldBackground,
          border: `1px solid ${theme.border}`,
          borderRadius: "4px",
          transition: "border-color 100ms ease, box-shadow 100ms ease",
        },
        ".omp-editor-search-field:focus-within": {
          borderColor: theme.foregroundMuted,
          boxShadow: `0 0 0 1px color-mix(in srgb, ${theme.foreground} 24%, transparent)`,
        },
        ".omp-editor-search-field > input": {
          flex: "1 1 auto",
          minWidth: "48px",
          height: "100%",
          boxSizing: "border-box",
          padding: "0 8px",
          color: theme.foreground,
          backgroundColor: "transparent",
          border: "none",
          borderRadius: "0",
          outline: "none",
          appearance: "none",
          font: "inherit",
        },
        ".omp-editor-search-field > input::placeholder": {
          color: theme.foregroundMuted,
          opacity: "0.72",
        },
        ".omp-editor-search-result": {
          minWidth: "64px",
          color: theme.foreground,
          fontSize: "12px",
          lineHeight: "1",
          textAlign: "left",
          whiteSpace: "nowrap",
        },
        ".omp-editor-search-actions": {
          display: "flex",
          alignItems: "center",
          gap: "1px",
        },
        ".omp-editor-search-button": {
          display: "inline-flex",
          flex: "0 0 auto",
          alignItems: "center",
          justifyContent: "center",
          width: "24px",
          height: "24px",
          boxSizing: "border-box",
          padding: "0",
          color: theme.foregroundMuted,
          backgroundColor: "transparent",
          border: "none",
          borderRadius: "4px",
          outline: "none",
          appearance: "none",
          font: "inherit",
          lineHeight: "1",
          cursor: "pointer",
          transition: "color 100ms ease, background-color 100ms ease",
        },
        ".omp-editor-search-button:hover": {
          color: theme.foreground,
          backgroundColor: searchHoverBackground,
        },
        ".omp-editor-search-button:focus-visible": {
          color: theme.foreground,
          boxShadow: `0 0 0 1px ${theme.foregroundMuted}`,
        },
        ".omp-editor-search-button:active, .omp-editor-search-button.is-active": {
          color: theme.foreground,
          backgroundColor: searchActiveBackground,
        },
        ".omp-editor-search-button > svg": {
          width: "15px",
          height: "15px",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.8",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
        ".omp-editor-search-expand": {
          width: "20px",
          height: "24px",
        },
        ".omp-editor-search-expand > svg": {
          width: "13px",
          height: "13px",
          transition: "transform 120ms ease",
        },
        ".omp-editor-search[data-replace-expanded=false] .omp-editor-search-expand > svg": {
          transform: "rotate(-90deg)",
        },
        ".omp-editor-search-option": {
          width: "24px",
          height: "24px",
          borderRadius: "3px",
          fontSize: "11px",
        },
        ".omp-editor-search-whole-word": {
          textDecoration: "underline",
          textDecorationThickness: "1px",
          textUnderlineOffset: "2px",
        },
        ".omp-editor-search-replace-actions": {
          gridColumn: "3 / 5",
          justifySelf: "start",
        },
        ".omp-editor-search-replace-row[hidden]": {
          display: "none",
        },
        ".cm-searchMatch": {
          backgroundColor:
            theme.colorScheme === "dark" ? "rgba(250, 204, 21, 0.28)" : "rgba(234, 179, 8, 0.24)",
          outline: "1px solid rgba(234, 179, 8, 0.35)",
        },
        ".cm-searchMatch-selected": {
          backgroundColor:
            theme.colorScheme === "dark" ? "rgba(250, 204, 21, 0.5)" : "rgba(234, 179, 8, 0.4)",
        },
      },
      { dark: theme.colorScheme === "dark" },
    ),
    syntaxHighlighting(createCodeMirrorHighlightStyle(theme.syntax)),
  ];
}

import { renderToString } from "katex";

const EMPHATIC_VECTOR = String.raw`\overrightarrow{\mathbf{#1}}`;
export function renderMathToHtml(tex: string, displayMode: boolean): string {
  return renderToString(tex, {
    displayMode,
    throwOnError: false,
    trust: false,
    strict: "warn",
    macros: {
      "\\vec": EMPHATIC_VECTOR,
    },
  });
}

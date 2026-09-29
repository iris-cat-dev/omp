import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { markdownMathPlugin, MATH_BLOCK_TOKEN, MATH_INLINE_TOKEN } from "./plugin";

function parseMath(source: string) {
  const parser = new MarkdownIt({ linkify: true, typographer: true }).use(markdownMathPlugin);
  const topLevel = parser.parse(source, {});
  return topLevel.flatMap((token) => (token.children ? [token].concat(token.children) : [token]));
}

describe("markdownMathPlugin", () => {
  it.each([
    [
      "comparison",
      String.raw`\[
x \le 8
\]`,
      String.raw`x \le 8`,
    ],
    [
      "aligned equations",
      String.raw`\[
\begin{aligned}
A &= 2143, \\
B &= 2341
\end{aligned}
\]`,
      String.raw`\begin{aligned}
A &= 2143, \\
B &= 2341
\end{aligned}`,
    ],
    [
      "array",
      String.raw`\[
\begin{array}{c|cc}
T & A & B \\
\hline
m(T) & 1 & 0
\end{array}
\]`,
      String.raw`\begin{array}{c|cc}
T & A & B \\
\hline
m(T) & 1 & 0
\end{array}`,
    ],
  ])("captures %s blocks before Markdown consumes TeX", (_name, source, expected) => {
    const math = parseMath(source).filter((token) => token.type === MATH_BLOCK_TOKEN);
    expect(math).toHaveLength(1);
    expect(math[0]?.content).toBe(expected);
  });

  it("supports bracket and dollar inline formulas", () => {
    const tokens = parseMath(String.raw`Values \(x \in A\), $y \ge 2$, and text.`).filter(
      (token) => token.type === MATH_INLINE_TOKEN,
    );
    expect(tokens.map((token) => token.content)).toEqual([
      String.raw`x \in A`,
      String.raw`y \ge 2`,
    ]);
  });

  it("renders bracket formulas embedded in prose without leaking TeX delimiters", () => {
    const tokens = parseMath(String.raw`说明 \[\text{输入}\] 结束`);
    const inline = tokens.filter((token) => token.type === MATH_INLINE_TOKEN);
    expect(inline.map((token) => [token.markup, token.content])).toEqual([
      [String.raw`\[`, String.raw`\text{输入}`],
    ]);
    expect(tokens.filter((token) => token.type === "text").map((token) => token.content)).toEqual([
      "说明 ",
      " 结束",
    ]);
  });

  it("does not consume either half of display-dollar delimiters in prose", () => {
    const tokens = parseMath(String.raw`说明 $$\text{输入}$$ 结束`);
    expect(tokens.some((token) => token.type === MATH_INLINE_TOKEN)).toBe(false);
    expect(tokens.find((token) => token.type === "inline")?.content).toBe(
      String.raw`说明 $$\text{输入}$$ 结束`,
    );
    expect(tokens.find((token) => token.type === "text")?.content).toBe(
      String.raw`说明 $$\text{输入}$$ 结束`,
    );
  });

  it("strips Markdown container prefixes from multiline formulas", () => {
    const source = String.raw`> \[
> \text{输入}
> \downarrow
> \text{输出}
> \]`;
    const math = parseMath(source).find((token) => token.type === MATH_BLOCK_TOKEN);
    expect(math?.content).toBe(String.raw`\text{输入}
\downarrow
\text{输出}`);
  });

  it("supports standalone LaTeX environments", () => {
    const source = String.raw`\begin{aligned}
A &= 1 \\
B &= 2
\end{aligned}`;
    const math = parseMath(source).find((token) => token.type === MATH_BLOCK_TOKEN);
    expect(math?.content).toBe(source);
  });

  it("supports dollar-delimited display formulas", () => {
    const math = parseMath(String.raw`$$
x \ge 3
$$`).find((token) => token.type === MATH_BLOCK_TOKEN);
    expect(math?.content).toBe(String.raw`x \ge 3`);
  });

  it("leaves fenced and incomplete formulas as source text", () => {
    const fenced = parseMath("```text\n\\[\nx \\le 8\n\\]\n```");
    expect(fenced.some((token) => token.type === MATH_BLOCK_TOKEN)).toBe(false);
    expect(fenced.some((token) => token.type === "fence")).toBe(true);

    const incomplete = parseMath(String.raw`\[
x \le 8`);
    expect(incomplete.some((token) => token.type === MATH_BLOCK_TOKEN)).toBe(false);
  });
});

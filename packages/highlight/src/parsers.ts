import {
  defineLanguageFacet,
  languageDataProp,
  Language,
  LRLanguage,
  StreamLanguage,
} from "@codemirror/language";
import { dart } from "@codemirror/legacy-modes/mode/clike";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { parser as jsParser } from "@lezer/javascript";
import { parser as jsonParser } from "@lezer/json";
import { parser as cssParser } from "@lezer/css";
import { parser as cppParser } from "@lezer/cpp";
import { parser as goParser } from "@lezer/go";
import { parser as htmlParser } from "@lezer/html";
import { parser as javaParser } from "@lezer/java";
import { parser as pythonParser } from "@lezer/python";
import { parser as markdownParser } from "@lezer/markdown";
import { parser as phpParser } from "@lezer/php";
import { parser as rustParser } from "@lezer/rust";
import { parser as xmlParser } from "@lezer/xml";
import { parser as yamlParser } from "@lezer/yaml";
import { parser as elixirParser } from "lezer-elixir";
import type { Parser } from "@lezer/common";
import type { LRParser } from "@lezer/lr";
import type { MarkdownParser } from "@lezer/markdown";
import { csharpLanguage } from "./csharp/language.js";
import { nixLanguage } from "./nix/language.js";
import { parser as svelteBaseParser } from "./svelte/parser.js";
import { configureNesting, defaultNesting } from "./svelte/nesting.js";

interface CommentTokens {
  line?: string;
  block?: { open: string; close: string };
}

function language(parser: LRParser, commentTokens?: CommentTokens): Language {
  return LRLanguage.define({
    parser,
    ...(commentTokens ? { languageData: { commentTokens } } : {}),
  });
}
function markdownLanguage(parser: MarkdownParser, commentTokens: CommentTokens): Language {
  const data = defineLanguageFacet({ commentTokens });
  return new Language(
    data,
    parser.configure({
      props: [languageDataProp.add((type) => (type.isTop ? data : undefined))],
    }),
  );
}

const C_STYLE_COMMENTS = { line: "//", block: { open: "/*", close: "*/" } } as const;
const HASH_COMMENT = { line: "#" } as const;
const MARKUP_COMMENT = { block: { open: "<!--", close: "-->" } } as const;

const languagesByExtension: Record<string, Language> = {
  // JavaScript/TypeScript
  js: language(jsParser, C_STYLE_COMMENTS),
  jsx: language(jsParser.configure({ dialect: "jsx" }), C_STYLE_COMMENTS),
  ts: language(jsParser.configure({ dialect: "ts" }), C_STYLE_COMMENTS),
  tsx: language(jsParser.configure({ dialect: "ts jsx" }), C_STYLE_COMMENTS),
  mjs: language(jsParser, C_STYLE_COMMENTS),
  cjs: language(jsParser, C_STYLE_COMMENTS),
  // C / C++ / Objective-C
  c: language(cppParser, C_STYLE_COMMENTS),
  h: language(cppParser, C_STYLE_COMMENTS),
  cc: language(cppParser, C_STYLE_COMMENTS),
  cpp: language(cppParser, C_STYLE_COMMENTS),
  cxx: language(cppParser, C_STYLE_COMMENTS),
  hpp: language(cppParser, C_STYLE_COMMENTS),
  hxx: language(cppParser, C_STYLE_COMMENTS),
  m: language(cppParser, C_STYLE_COMMENTS),
  mm: language(cppParser, C_STYLE_COMMENTS),
  // JSON
  json: language(jsonParser),
  // CSS
  css: language(cssParser, { block: C_STYLE_COMMENTS.block }),
  scss: language(cssParser, { block: C_STYLE_COMMENTS.block }),
  // HTML
  html: language(htmlParser, MARKUP_COMMENT),
  htm: language(htmlParser, MARKUP_COMMENT),
  // Svelte
  svelte: language(
    svelteBaseParser.configure({ wrap: configureNesting(defaultNesting) }),
    MARKUP_COMMENT,
  ),
  // XML
  xml: language(xmlParser, MARKUP_COMMENT),
  // Java
  java: language(javaParser, C_STYLE_COMMENTS),
  // Python
  py: language(pythonParser, HASH_COMMENT),
  // Go
  go: language(goParser, C_STYLE_COMMENTS),
  // PHP
  php: language(phpParser, C_STYLE_COMMENTS),
  // YAML
  yaml: language(yamlParser, HASH_COMMENT),
  yml: language(yamlParser, HASH_COMMENT),
  // Rust
  rs: language(rustParser, C_STYLE_COMMENTS),
  // Swift
  swift: StreamLanguage.define(swift),
  // Dart
  dart: StreamLanguage.define(dart),
  // C#
  cs: csharpLanguage,
  // Nix
  nix: nixLanguage,
  // Elixir
  ex: language(elixirParser, HASH_COMMENT),
  exs: language(elixirParser, HASH_COMMENT),
  // Markdown
  md: markdownLanguage(markdownParser, MARKUP_COMMENT),
  mdx: markdownLanguage(markdownParser, MARKUP_COMMENT),
};

export function getLanguageForFile(filename: string): Language | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return languagesByExtension[ext] ?? null;
}

export function getParserForFile(filename: string): Parser | null {
  return getLanguageForFile(filename)?.parser ?? null;
}

export function isLanguageSupported(filename: string): boolean {
  return getParserForFile(filename) !== null;
}

export function getSupportedExtensions(): string[] {
  return Object.keys(languagesByExtension);
}

#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { parse } = require("@babel/parser");
const packages = ["packages/plugin", "plugins/agent-speed", "plugins/wallpaper", "plugins/desktop-pet"];
const selected = process.argv.slice(2);
if (selected.some((name) => !packages.includes(name))) throw new Error(`Unknown plugin build target: ${selected.join(", ")}`);

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(file));
    else if (/\.(?:tsx?|jsx?|mjs|cjs)$/.test(entry.name) && !/\.(?:test|spec)\.[^.]+$/.test(entry.name)) result.push(file);
  }
  return result;
}

// Resolve only local modules. Every package import remains external so the host's
// React, SDK context, Query and schema instances are shared by every entrypoint.
function localSpecifier(specifier, sourceFile) {
  if (!specifier.startsWith(".")) return specifier;
  const absolute = path.resolve(path.dirname(sourceFile), specifier);
  const stem = absolute.replace(/\.(?:js|mjs|cjs|ts|tsx|jsx)$/, "");
  const candidates = [absolute, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map(ext => stem + ext), ...[".ts", ".tsx", ".js", ".jsx"].map(ext => path.join(absolute, "index" + ext))];
  const found = candidates.find(file => existsSync(file) && /\.(?:tsx?|jsx?|mjs|cjs)$/.test(file));
  if (!found) throw new Error(`Cannot resolve local module ${specifier} from ${sourceFile}`);
  let relative = path.relative(path.dirname(sourceFile), found).replaceAll(path.sep, "/").replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, ".js");
  if (!relative.startsWith(".")) relative = "./" + relative;
  return relative;
}

function rewriteModules(code, sourceFile, declaration = false) {
  const ast = parse(code, { sourceType: "unambiguous", ...(declaration ? { plugins: ["typescript"] } : {}) });
  const edits = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    let value;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)) value = node.source;
    if (node.type === "CallExpression" && (node.callee.type === "Import" || (node.callee.type === "Identifier" && node.callee.name === "require"))) value = node.arguments[0];
    if (node.type === "TSImportType") value = node.argument;
    if (value?.type === "StringLiteral" && value.value.startsWith(".")) edits.push({ start: value.start, end: value.end, text: JSON.stringify(localSpecifier(value.value, sourceFile)) });
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "start", "end"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  }
  visit(ast.program);
  for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}

async function buildPackage(name) {
  const directory = path.join(root, name);
  const sourceRoot = path.join(directory, "src");
  const files = await sources(sourceRoot);
  const dist = path.join(directory, "dist");
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  const declarationConfig = path.join(directory, ".plugin-declarations.json");
  try {
    await writeFile(declarationConfig, JSON.stringify({ compilerOptions: { target: "ES2022", lib: ["ES2024", "DOM"], module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, esModuleInterop: true, declaration: true, emitDeclarationOnly: true, noEmitOnError: true, rootDir: "./src", outDir: "./dist/types", ...(name === "plugin" ? { baseUrl: ".", paths: { "@omp-desktop/plugin": ["./src/index.ts"], "@omp-desktop/plugin/server": ["./src/server.ts"] } } : {}) }, files: files.filter(file => /\.tsx?$/.test(file)).map(file => path.relative(directory, file)) }));
    const result = spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", declarationConfig], { cwd: directory, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Declaration build failed: ${name}`);
  } finally {
    await rm(declarationConfig, { force: true });
  }
  for (const file of files.filter(file => /\.d\.ts$/.test(file))) {
    const destination = path.join(dist, "types", path.relative(sourceRoot, file));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(file, "utf8"));
  }
  for (const file of await sources(path.join(dist, "types"))) {
    const relative = path.relative(path.join(dist, "types"), file).replace(/\.d\.ts$/, "");
    const sourceFile = files.find(source => path.relative(sourceRoot, source).replace(/(?:\.d)?\.tsx?$/, "") === relative);
    if (!sourceFile) throw new Error(`Missing declaration source mapping: ${file}`);
    await writeFile(file, rewriteModules(await readFile(file, "utf8"), sourceFile, true));
  }
  for (const format of ["esm", "cjs"]) {
    const outdir = path.join(dist, format);
    const result = await build({ entryPoints: files.filter(file => !/\.d\.ts$/.test(file)), outbase: sourceRoot, outdir, bundle: false, write: false, format, platform: "neutral", target: "es2022", jsx: "automatic", ...(format === "cjs" ? { define: { "import.meta.url": "__ompImportMetaUrl" } } : {}) });
    for (const output of result.outputFiles) {
      const relative = path.relative(outdir, output.path).replace(/\.js$/, "");
      const sourceFile = files.find(file => path.relative(sourceRoot, file).replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, "") === relative);
      if (!sourceFile) throw new Error(`Missing source mapping for ${output.path}`);
      await mkdir(path.dirname(output.path), { recursive: true });
      const code = format === "cjs" && output.text.includes("__ompImportMetaUrl") ? 'const __ompImportMetaUrl = require("node:url").pathToFileURL(__filename).href;\n' + output.text : output.text;
      await writeFile(output.path, rewriteModules(code, sourceFile));
    }
    await writeFile(path.join(outdir, "package.json"), JSON.stringify({ type: format === "cjs" ? "commonjs" : "module" }) + "\n");
  }
  const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  for (const [entry, mapping] of Object.entries(metadata.exports)) {
    if (entry === "./package.json") continue;
    for (const condition of ["types", "source", "import", "require"]) {
      if (!mapping[condition] || !existsSync(path.join(directory, mapping[condition]))) throw new Error(`Missing ${condition} export ${metadata.name}${entry}: ${mapping[condition]}`);
    }
  }
}

for (const name of selected.length ? selected : packages) await buildPackage(name);

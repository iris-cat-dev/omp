import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { parse } from "@babel/parser";
import type { Plugin } from "esbuild";
import { PLUGIN_SDK_SPECIFIERS, PLUGIN_FORBIDDEN_HOST_SPECIFIER } from "./plugin-sdk-specifiers.js";
import { PLUGIN_SHARED_CLIENT_SPECIFIERS } from "./client-modules.js";

const nodeRequire = createRequire(import.meta.url);
const ESBUILD_BINARY_PATH = "ESBUILD_BINARY_PATH";

// esbuild resolves its own platform binary via require.resolve() the first time its
// module is evaluated. Inside the packaged desktop app that resolves to a path under
// app.asar even though electron-builder unpacks the real binary to app.asar.unpacked.
// child_process.spawn bypasses Electron's asar fs shim, so the OS rejects that path
// with ENOTDIR. Point esbuild at the real unpacked binary before its module loads.
export function unpackedEsbuildBinaryFromPackageDir(
  esbuildPackageDir: string,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const asarIndex = esbuildPackageDir.indexOf(asarSegment);
  if (asarIndex === -1) return null;
  return path.join(
    esbuildPackageDir.slice(0, asarIndex),
    "app.asar.unpacked",
    "node_modules",
    `@esbuild/${platform}-${arch}`,
    ...(platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"]),
  );
}

export function resolveExistingAsarUnpackedEsbuildBinary(
  esbuildPackageDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  exists: (file: string) => boolean = existsSync,
): string | null {
  const binaryPath = unpackedEsbuildBinaryFromPackageDir(esbuildPackageDir, platform, arch);
  return binaryPath && exists(binaryPath) ? binaryPath : null;
}

function resolveAsarUnpackedEsbuildBinary(): string | null {
  let esbuildDir: string;
  try {
    esbuildDir = path.dirname(nodeRequire.resolve("esbuild/package.json"));
  } catch {
    return null;
  }
  return resolveExistingAsarUnpackedEsbuildBinary(esbuildDir);
}

function loadEsbuild(): typeof import("esbuild") {
  const previousBinaryPath = process.env[ESBUILD_BINARY_PATH];
  const unpackedBinary = resolveAsarUnpackedEsbuildBinary();
  if (unpackedBinary) process.env[ESBUILD_BINARY_PATH] = unpackedBinary;

  try {
    // esbuild reads this variable while its CommonJS module is evaluated. Keep
    // the compatibility bridge local so it cannot become an agent's environment.
    return nodeRequire("esbuild") as typeof import("esbuild");
  } finally {
    if (previousBinaryPath === undefined) delete process.env[ESBUILD_BINARY_PATH];
    else process.env[ESBUILD_BINARY_PATH] = previousBinaryPath;
  }
}

type PluginBuildTarget = "client" | "server";

interface SourceRange {
  start: number;
  end: number;
}

const REGISTRATIONS_REMOVED_BY_TARGET: Record<PluginBuildTarget, ReadonlySet<string>> = {
  client: new Set(["handle"]),
  server: new Set([
    "addSurface",
    "addSidebarItem",
    "addWorkspacePanel",
    "addCommandCenterItem",
    "addAttachmentSource",
    "addTheme",
  ]),
};

function registrationName(statement: unknown, contextName: string): string | null {
  if (!statement || typeof statement !== "object") return null;
  const expression = Reflect.get(statement, "expression");
  if (
    !expression ||
    typeof expression !== "object" ||
    Reflect.get(expression, "type") !== "CallExpression"
  ) {
    return null;
  }
  const callee = Reflect.get(expression, "callee");
  if (!callee || typeof callee !== "object" || Reflect.get(callee, "type") !== "MemberExpression") {
    return null;
  }
  const object = Reflect.get(callee, "object");
  const property = Reflect.get(callee, "property");
  if (
    !object ||
    typeof object !== "object" ||
    Reflect.get(object, "type") !== "Identifier" ||
    Reflect.get(object, "name") !== contextName ||
    !property ||
    typeof property !== "object" ||
    Reflect.get(property, "type") !== "Identifier"
  ) {
    return null;
  }
  return String(Reflect.get(property, "name"));
}

function defaultPluginFunction(programBody: unknown[]): { body: object; contextName: string } {
  const defaultExports = programBody.filter(
    (statement) =>
      statement !== null &&
      typeof statement === "object" &&
      Reflect.get(statement, "type") === "ExportDefaultDeclaration",
  );
  if (defaultExports.length !== 1) {
    throw new Error("Plugin entry point must have exactly one default export function");
  }
  const declaration = Reflect.get(defaultExports[0] as object, "declaration");
  const declarationType =
    declaration !== null && typeof declaration === "object"
      ? Reflect.get(declaration, "type")
      : null;
  if (
    declarationType !== "FunctionDeclaration" &&
    declarationType !== "FunctionExpression" &&
    declarationType !== "ArrowFunctionExpression"
  ) {
    throw new Error("Plugin default export must be a function receiving its context");
  }
  const parameters = Reflect.get(declaration, "params");
  const parameter = Array.isArray(parameters) && parameters.length === 1 ? parameters[0] : null;
  if (
    parameter === null ||
    typeof parameter !== "object" ||
    Reflect.get(parameter, "type") !== "Identifier"
  ) {
    throw new Error("Plugin default export must receive one named context parameter");
  }
  const body = Reflect.get(declaration, "body");
  if (body === null || typeof body !== "object" || Reflect.get(body, "type") !== "BlockStatement") {
    throw new Error("Plugin default export must have a block body");
  }
  return { body, contextName: String(Reflect.get(parameter, "name")) };
}

function collectRemovedRegistrationRanges(
  node: unknown,
  contextName: string,
  removedNames: ReadonlySet<string>,
  ranges: SourceRange[],
): void {
  if (node === null || typeof node !== "object") return;
  if (Reflect.get(node, "type") === "ExpressionStatement") {
    const name = registrationName(node, contextName);
    if (name && removedNames.has(name)) {
      const start = Reflect.get(node, "start");
      const end = Reflect.get(node, "end");
      if (typeof start !== "number" || typeof end !== "number") {
        throw new Error(
          `Could not locate plugin context ${name} registration in plugin entry point`,
        );
      }
      ranges.push({ start, end });
      return;
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value)
        collectRemovedRegistrationRanges(child, contextName, removedNames, ranges);
    } else if (value !== null && typeof value === "object") {
      collectRemovedRegistrationRanges(value, contextName, removedNames, ranges);
    }
  }
}

function moduleTarget(specifier: string): PluginBuildTarget | null {
  if (/\.client(?:\.[cm]?[jt]sx?)?$/.test(specifier)) return "client";
  if (/\.server(?:\.[cm]?[jt]sx?)?$/.test(specifier)) return "server";
  return null;
}

function collectOppositeTargetImportRanges(
  programBody: unknown[],
  target: PluginBuildTarget,
  ranges: SourceRange[],
): void {
  for (const statement of programBody) {
    if (
      statement === null ||
      typeof statement !== "object" ||
      Reflect.get(statement, "type") !== "ImportDeclaration"
    ) {
      continue;
    }
    const source = Reflect.get(statement, "source");
    const specifier =
      source !== null && typeof source === "object" ? Reflect.get(source, "value") : null;
    if (typeof specifier !== "string") continue;
    const importedTarget = moduleTarget(specifier);
    if (importedTarget === null || importedTarget === target) continue;
    const start = Reflect.get(statement, "start");
    const end = Reflect.get(statement, "end");
    if (typeof start !== "number" || typeof end !== "number") {
      throw new Error(`Could not locate ${importedTarget}-only import in plugin entry point`);
    }
    ranges.push({ start, end });
  }
}

function filterEntrypoint(source: string, target: PluginBuildTarget): string {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  const pluginFunction = defaultPluginFunction(ast.program.body);
  const ranges: SourceRange[] = [];
  collectRemovedRegistrationRanges(
    pluginFunction.body,
    pluginFunction.contextName,
    REGISTRATIONS_REMOVED_BY_TARGET[target],
    ranges,
  );
  collectOppositeTargetImportRanges(ast.program.body, target, ranges);

  let output = source;
  for (const range of ranges.toSorted((left, right) => right.start - left.start)) {
    output = `${output.slice(0, range.start)}${output.slice(range.end)}`;
  }
  return output;
}

function createRuntimeBoundaryPlugin(target: PluginBuildTarget): Plugin {
  return {
    name: `omp-plugin-${target}-runtime-boundary`,
    setup(buildContext) {
      buildContext.onResolve({ filter: /\.(?:client|server)(?:\.[cm]?[jt]sx?)?$/ }, (args) => {
        const importedTarget = moduleTarget(args.path);
        if (importedTarget === null || importedTarget === target) return null;
        return {
          errors: [
            {
              text: `${importedTarget}-only module cannot be imported into the plugin ${target} bundle: ${args.path}`,
            },
          ],
        };
      });
    },
  };
}

function wrapCommonJsBundle(code: string, target: PluginBuildTarget): string {
  const parameters = target === "server" ? "require, __filename, __dirname" : "require";
  const module = target === "server" ? "{ exports: {}, filename: __filename, id: __filename, path: __dirname, require }" : "{ exports: {} }";
  return `(function(${parameters}) {\nconst module = ${module};\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
}

function makeHermesInteropSafe(code: string): string {
  const getter = "get: () => from[key]";
  if (!code.includes(getter)) return code;
  // Give every getter its own parameter binding instead of Hermes' loop binding.
  // Keep it lazy: __toCommonJS runs before const/arrow default exports initialize.
  let name = "__ompPluginExportGetter";
  while (code.includes(name)) name += "_";
  return `var ${name} = (from, key) => () => from[key];\n${code.replaceAll(getter, `get: ${name}(from, key)`)}`;
}

function createUnusedPlatformModulePlugin(target: PluginBuildTarget): Plugin {
  const filter =
    target === "server"
      ? /^(@tanstack\/react-query|react(?:\/jsx(?:-dev)?-runtime)?|react-native(?:-unistyles)?|react-i18next|lucide-react-native)$/
      : /^node:/;
  return {
    name: `omp-plugin-${target}-unused-platform-modules`,
    setup(buildContext) {
      buildContext.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: "omp-unused-platform-module",
        sideEffects: false,
      }));
      buildContext.onLoad({ filter: /.*/, namespace: "omp-unused-platform-module" }, () => ({
        contents: "module.exports = {};",
        loader: "js",
      }));
    },
  };
}

function createHostImportBoundaryPlugin():Plugin {
  return {name:"desktop-plugin-host-import-boundary",setup(build){
    build.onResolve({filter:PLUGIN_FORBIDDEN_HOST_SPECIFIER},args=>({errors:[{text:`Plugin must use the public Desktop SDK, not host internals or a second OMP SDK: ${args.path}`}]}));
  }};
}

async function compileTarget(entryPath: string, target: PluginBuildTarget): Promise<string> {
  const { build } = loadEsbuild();
  const source = await readFile(entryPath, "utf8");
  const filteredSource = filterEntrypoint(source, target);
  const result = await build({
    stdin: {
      contents: filteredSource,
      loader: "tsx",
      resolveDir: path.dirname(entryPath),
      sourcefile: entryPath,
    },
    bundle: true,
    packages: target === "server" ? "external" : undefined,
    define: target === "server" ? { "import.meta.url": JSON.stringify(pathToFileURL(entryPath).href) } : undefined,
    format: "cjs",
    platform: target === "server" ? "node" : "neutral",
    target: target === "server" ? "node20" : "es2020",
    external:
      target === "client"
        ? [
            ...PLUGIN_SDK_SPECIFIERS,
            ...PLUGIN_SHARED_CLIENT_SPECIFIERS,
            "@omp-desktop/client",
          ]
        : [...PLUGIN_SDK_SPECIFIERS, "@omp-desktop/client", "zod"],
    plugins: [createHostImportBoundaryPlugin(),createRuntimeBoundaryPlugin(target), createUnusedPlatformModulePlugin(target)],
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error(`Plugin ${target} compilation produced no output`);
  return wrapCommonJsBundle(target === "client" ? makeHermesInteropSafe(output) : output, target);
}

export interface CompiledPluginBundles {clientBundle:string;serverBundle:string}
export async function compilePlugin(entryPath: string): Promise<CompiledPluginBundles> {
  const [clientBundle, serverBundle] = await Promise.all([
    compileTarget(entryPath, "client"),
    compileTarget(entryPath, "server"),
  ]);
  return { clientBundle, serverBundle };
}

export async function compilePackageEntries(entries: { clientEntry?: string; serviceEntry?: string }): Promise<CompiledPluginBundles> {
  const {build}=loadEsbuild();
  const compile = async (entry:string|undefined,target:"client"|"server") => {
    if(!entry) return "";
    const result=await build({entryPoints:[entry],bundle:true,packages:target==="server"?"external":undefined,define:target==="server"?{"import.meta.url":JSON.stringify(pathToFileURL(entry).href)}:undefined,format:"cjs",platform:target==="server"?"node":"browser",target:"es2020",external:["@omp-desktop/plugin","@omp-desktop/plugin/server","@omp-desktop/client",...PLUGIN_SHARED_CLIENT_SPECIFIERS],plugins:[createHostImportBoundaryPlugin(),createRuntimeBoundaryPlugin(target),createUnusedPlatformModulePlugin(target)],write:false,logLevel:"silent"});
    const output=result.outputFiles[0]?.text;
    if(!output)throw new Error(`Plugin ${target} entry produced no bundle`);
    return wrapCommonJsBundle(target === "client" ? makeHermesInteropSafe(output) : output, target);
  };
  const [clientBundle,serverBundle]=await Promise.all([compile(entries.clientEntry,"client"),compile(entries.serviceEntry,"server")]);
  return {clientBundle,serverBundle};
}

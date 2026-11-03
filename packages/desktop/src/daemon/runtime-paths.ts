import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { app } from "electron";
import {
  createNodeEntrypointInvocation as createSharedNodeEntrypointInvocation,
  type NodeEntrypointArgvMode,
  type NodeEntrypointInvocation,
  type NodeEntrypointSpec,
} from "./node-entrypoint-launcher.js";
import {
  assertPathExists,
  findPackageRootFromResolvedPath,
  resolvePackagedAppPath,
  type PackageInfo,
} from "./package-paths.js";

const SERVER_PACKAGE_NAME = "@omp-desktop/server";

const esmRequire = createRequire(__filename);

function resolveServerPackageInfo(): PackageInfo {
  const serverExportPath = esmRequire.resolve(SERVER_PACKAGE_NAME);
  return findPackageRootFromResolvedPath({
    resolvedPath: serverExportPath,
    packageName: SERVER_PACKAGE_NAME,
  });
}

export function resolvePackagedNodeEntrypointRunnerPath(): string {
  return path.join(process.resourcesPath, "app", "dist", "daemon", "node-entrypoint-runner.js");
}

export function resolveDesktopSdkRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (app.isPackaged) {
    const resources = path.join(process.resourcesPath, "omp-sdk");
    assertPathExists({
      label: "Bundled OMP SDK manifest",
      filePath: path.join(resources, "manifest.json"),
    });
    return assertPathExists({
      label: "Bundled OMP SDK package",
      filePath: path.join(resources, "node_modules", "@oh-my-pi", "pi-coding-agent"),
    });
  }
  if (env.OMP_DESKTOP_SDK_ROOT) return env.OMP_DESKTOP_SDK_ROOT;
  const desktopRoot = path.resolve(__dirname, "..", "..");
  const staged = path.join(desktopRoot, "sdk-dist", "node_modules", "@oh-my-pi", "pi-coding-agent");
  if (existsSync(path.join(desktopRoot, "sdk-dist", "manifest.json"))) return staged;
  return path.resolve(desktopRoot, "..", "..", "omp-sdk", "packages", "coding-agent");
}

export function resolveBundledRipgrepPath(): string | null {
  if (!app.isPackaged) return null;
  return assertPathExists({
    label: "Bundled ripgrep executable",
    filePath: path.join(
      process.resourcesPath,
      "bin",
      process.platform === "win32" ? "rg.exe" : "rg",
    ),
  });
}

export function resolveDaemonRunnerEntrypoint(): NodeEntrypointSpec {
  if (app.isPackaged) {
    return {
      entryPath: assertPathExists({
        label: "Bundled daemon runner",
        filePath: path.join(
          resolvePackagedAppPath(),
          "node_modules",
          "@omp-desktop",
          "server",
          "dist",
          "scripts",
          "supervisor-entrypoint.js",
        ),
      }),
      execArgv: [],
    };
  }

  const serverPackage = resolveServerPackageInfo();
  const distRunner = path.join(serverPackage.root, "dist", "scripts", "supervisor-entrypoint.js");
  if (existsSync(distRunner)) {
    return {
      entryPath: distRunner,
      execArgv: [],
    };
  }

  return {
    entryPath: assertPathExists({
      label: "Daemon runner source",
      filePath: path.join(serverPackage.root, "scripts", "supervisor-entrypoint.ts"),
    }),
    execArgv: ["--import", "tsx"],
  };
}

export function createNodeEntrypointInvocation(input: {
  entrypoint: NodeEntrypointSpec;
  argvMode: NodeEntrypointArgvMode;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
}): NodeEntrypointInvocation {
  return createSharedNodeEntrypointInvocation({
    execPath: process.execPath,
    isPackaged: app.isPackaged,
    packagedRunnerPath: app.isPackaged
      ? assertPathExists({
          label: "Bundled node entrypoint runner",
          filePath: resolvePackagedNodeEntrypointRunnerPath(),
        })
      : null,
    entrypoint: input.entrypoint,
    argvMode: input.argvMode,
    args: input.args,
    baseEnv: input.baseEnv,
  });
}

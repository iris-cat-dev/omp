import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveOmpSdkBuildConfig(env = process.env) {
  const source =
    env.OMP_DESKTOP_SDK_SOURCE ?? path.join(rootDir, "omp-sdk", "packages", "coding-agent");
  if (!path.isAbsolute(source)) {
    throw new Error("OMP_DESKTOP_SDK_SOURCE must be an absolute SDK package root.");
  }
  const buildTarget = env.OMP_DESKTOP_SDK_TARGET ?? "desktop";
  if (buildTarget !== "generic" && buildTarget !== "desktop") {
    throw new Error(`Unsupported OMP_DESKTOP_SDK_TARGET: ${buildTarget}. Use generic or desktop.`);
  }
  const profile = env.OMP_DESKTOP_SDK_PROFILE ?? "core";
  if (profile !== "core" && profile !== "full") {
    throw new Error(`Unsupported OMP_DESKTOP_SDK_PROFILE: ${profile}. Use core or full.`);
  }
  const buildMode = env.OMP_DESKTOP_SDK_BUILD_MODE ?? "release";
  if (buildMode !== "release" && buildMode !== "development") {
    throw new Error(
      `Unsupported OMP_DESKTOP_SDK_BUILD_MODE: ${buildMode}. Use release or development.`,
    );
  }
  return { source, buildTarget, profile, buildMode };
}

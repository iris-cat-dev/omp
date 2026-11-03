import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot =
  process.env.OMP_DESKTOP_SDK_ROOT ??
  path.join(
    rootDir,
    "packages",
    "desktop",
    "sdk-dist",
    "node_modules",
    "@oh-my-pi",
    "pi-coding-agent",
  );
try {
  await access(path.join(sdkRoot, "dist", "node", "sdk.mjs"));
  await access(
    path.join(
      rootDir,
      "packages",
      "server",
      "dist",
      "server",
      "server",
      "agent",
      "providers",
      "omp",
      "sdk-host.js",
    ),
  );
} catch (error) {
  throw new Error(
    "The development SDK or server host is not built. Run npm run build:server first.",
    { cause: error },
  );
}
const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-runner.ts"], {
  cwd: path.join(rootDir, "packages", "server"),
  stdio: "inherit",
  env: {
    ...process.env,
    PASEO_NODE_ENV: "development",
    PASEO_DESKTOP_MANAGED: "1",
    OMP_DESKTOP_SDK_ROOT: sdkRoot,
  },
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

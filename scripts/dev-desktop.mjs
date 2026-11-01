import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "cmd.exe" : "npm";
const args = isWindows
  ? ["/d", "/s", "/c", "npm run dev:win --workspace=@omp-desktop/desktop"]
  : ["run", "dev", "--workspace=@omp-desktop/desktop"];
const child = spawn(npmCommand, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    PASEO_LISTEN: process.env.PASEO_LISTEN ?? "127.0.0.1:6770",
  },
});

child.on("error", (error) => {
  console.error(`[dev:desktop] failed to start: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});

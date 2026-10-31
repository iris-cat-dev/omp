import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve Desktop's compiled Node host, never an external OMP executable. */
export async function resolveOmpSdkHostCommand(): Promise<
  [string, ...string[]]
> {
  const candidates = [
    new URL("./sdk-host.js", import.meta.url),
    new URL(
      "../../../../../dist/server/server/agent/providers/omp/sdk-host.js",
      import.meta.url,
    ),
  ];
  for (const candidate of candidates) {
    const compiled = fileURLToPath(candidate).replace(
      /\.asar(?=[/\\]|$)/,
      ".asar.unpacked",
    );
    if (fs.existsSync(compiled)) return [process.execPath, compiled];
  }
  throw new Error(
    "The Desktop Node SDK host is missing. Build the server package before selecting the SDK backend.",
  );
}

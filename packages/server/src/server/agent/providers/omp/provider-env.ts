import { delimiter, join } from "node:path";

import { writeFileAtomic } from "../../../atomic-file.js";

const OMP_DESKTOP_CONFIG_FILENAME = "omp-provider.yml";

function appendConfigOverlay(existing: string | undefined, overlayPath: string): string {
  const paths = (existing ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== overlayPath);
  return [...paths, overlayPath].join(delimiter);
}

export async function prepareOmpProviderEnv(input: {
  configDir: string;
  env?: Record<string, string>;
}): Promise<Record<string, string>> {
  const overlayPath = join(input.configDir, OMP_DESKTOP_CONFIG_FILENAME);
  await writeFileAtomic(overlayPath, "bashInterceptor:\n  enabled: true\n");
  return {
    ...input.env,
    PI_CONFIG_FILES: appendConfigOverlay(
      input.env?.PI_CONFIG_FILES ?? process.env.PI_CONFIG_FILES,
      overlayPath,
    ),
  };
}

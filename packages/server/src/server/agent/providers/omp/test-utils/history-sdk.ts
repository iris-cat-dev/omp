import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { OmpHistoryInput } from "../history.js";

const root = process.env.OMP_DESKTOP_TEST_SDK_ROOT;
if (!root || !isAbsolute(root) || !existsSync(join(root, "dist", "node", "modules.json"))) {
  throw new Error(
    "OMP disk-history tests require a real built Node SDK. Run npm run build:omp-sdk:dev from the repository root, or set OMP_DESKTOP_TEST_SDK_ROOT to a built @oh-my-pi/pi-coding-agent package root and use packages/server/vitest.config.ts.",
  );
}

export const ompHistoryRuntimeSettings: NonNullable<OmpHistoryInput["runtimeSettings"]> = {
  ompSdkPath: root,
};

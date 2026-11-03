import { readFileSync } from "node:fs";
import path from "node:path";

export interface PackagedDesktopDistribution {
  identity: string;
}

export function readPackagedDesktopDistribution(appRoot: string): PackagedDesktopDistribution {
  const packageInfo: { ompDesktopDistribution?: unknown } = JSON.parse(
    readFileSync(path.join(appRoot, "package.json"), "utf8"),
  );
  const marker = packageInfo.ompDesktopDistribution;
  if (marker === "private-three-plugins") {
    throw new Error(
      "CLI-bound private plugin distributions are not supported by the SDK-only Desktop build.",
    );
  }
  if (marker !== undefined) {
    throw new Error("Unsupported packaged OMP Desktop distribution marker.");
  }
  return { identity: "public" };
}

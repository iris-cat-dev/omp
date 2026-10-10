import { release } from "node:os";

export interface TerminalWindowsPtyOptions {
  backend: "conpty";
  buildNumber?: number;
}

export function resolveTerminalWindowsPtyOptions(input: {
  platform: NodeJS.Platform;
  osRelease: string;
}): TerminalWindowsPtyOptions | undefined {
  if (input.platform !== "win32") {
    return undefined;
  }

  const buildNumber = Number.parseInt(input.osRelease.split(".")[2] ?? "", 10);
  return {
    backend: "conpty",
    ...(Number.isSafeInteger(buildNumber) && buildNumber > 0 ? { buildNumber } : {}),
  };
}

export const terminalWindowsPtyOptions = resolveTerminalWindowsPtyOptions({
  platform: process.platform,
  osRelease: release(),
});

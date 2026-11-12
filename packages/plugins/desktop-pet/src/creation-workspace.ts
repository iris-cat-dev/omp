import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PetCreationWorkspace } from "./types.js";

interface PetCreationOptions {
  userDataPath: string;
  skillPath: string;
  executablePath: string;
  appPath: string;
  packaged: boolean;
  description?: string;
  referencePreview: Buffer;
}

export async function createPetCreationWorkspace(
  options: PetCreationOptions,
): Promise<PetCreationWorkspace> {
  if (
    options.description !== undefined &&
    (typeof options.description !== "string" || options.description.length > 8000)
  ) {
    throw new TypeError("Pet creation description must be text no longer than 8000 characters.");
  }
  const cwd = path.join(options.userDataPath, "pet-workspaces", randomUUID());
  const skillDirectory = path.join(cwd, ".omp", "skills", "hatch-pet");
  await mkdir(skillDirectory, { recursive: true });
  try {
    await copyFile(options.skillPath, path.join(skillDirectory, "SKILL.md"));
    await writeFile(path.join(cwd, "iris-reference.png"), options.referencePreview);
    const runtimeArgs = options.packaged ? [] : [options.appPath];
    const helper = `const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const manifest = path.join(__dirname, "pet.json");
if (!fs.existsSync(manifest)) { console.error("Write a complete pet.json before installing your pet."); process.exit(1); }
const args = ${JSON.stringify(runtimeArgs)}.concat(["--desktop-pet-install", manifest]);
if (process.argv[2]) args.push("--input-image", path.resolve(process.argv[2]));
const env = { ...process.env, PASEO_ELECTRON_USER_DATA_DIR: ${JSON.stringify(options.userDataPath)} };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(${JSON.stringify(options.executablePath)}, args, { cwd: __dirname, env, stdio: "inherit", windowsHide: true });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status === null ? 1 : result.status);
`;
    await writeFile(path.join(cwd, "install-pet.cjs"), helper);
    const executableForCmd = options.executablePath.replace(/%/g, "%%");
    await writeFile(
      path.join(cwd, "install-pet.cmd"),
      `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${executableForCmd}" "%~dp0install-pet.cjs" %*\r\nexit /b %errorlevel%\r\n`,
    );
    const executableForShell = `'${options.executablePath.replace(/'/g, "'\\''")}'`;
    await writeFile(
      path.join(cwd, "install-pet.sh"),
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 ${executableForShell} "$(dirname "$0")/install-pet.cjs" "$@"\n`,
      { mode: 0o700 },
    );
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
  const brief = options.description?.trim();
  const initialPrompt = [
    "Create an animated desktop pet for OMP using the hatch-pet skill in this workspace.",
    "Read .omp/skills/hatch-pet/SKILL.md first. Use the user's configured OMP image-generation tool, not a hardcoded cloud service.",
    brief
      ? `User's pet brief: ${JSON.stringify(brief)}`
      : "Ask me what pet I want and whether I have reference images before generating artwork.",
    "Keep all authoring files in this workspace. iris-reference.png shows the built-in pet only as an optional style reference; do not copy its identity unless requested.",
    "Create this pet's own bubble.appearance and all eight bubble.states rules: original dialogue, deliberate silence, and appearance/hide/repeat timing. Do not inherit Iris's bubble or stock chatter. Review actual animation frames and bubble behavior, not just image dimensions.",
    "Finish by running the included install-pet helper successfully. It validates the real pet package and installs it in OMP's local pet library without changing the selected pet.",
    "After success, tell me to open Settings > Plugins > Desktop pet, click Refresh, and select the new pet. Do not claim success without the helper's successful output.",
  ].join("\n\n");
  return { cwd, initialPrompt };
}

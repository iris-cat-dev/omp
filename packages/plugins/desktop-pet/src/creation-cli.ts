import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PetLibrary } from "./library.js";
import {
  MAX_PET_MANIFEST_BYTES,
  parsePetManifest,
  validatePetSheet,
} from "./manifest.js";

export interface PetInstallHost { argv: string[]; ready(): Promise<void>; convertImage(path: string): Promise<Buffer>; exit(code: number): void }

export async function tryRunPetCreationCli(host: PetInstallHost & { library: PetLibrary }): Promise<boolean> {
  const marker = host.argv.indexOf("--desktop-pet-install");
  if (marker === -1) return false;
  try {
    const argument = host.argv[marker + 1];
    if (!argument)
      throw new TypeError("--desktop-pet-install requires the path to a complete pet.json.");
    const manifestPath = path.resolve(argument);
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PET_MANIFEST_BYTES) {
      throw new TypeError("pet.json must be a regular file no larger than 64 KiB.");
    }
    const manifest = parsePetManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    const imageMarker = host.argv.indexOf("--input-image", marker + 2);
    if (imageMarker !== -1 && !manifest.bubble) {
      throw new TypeError(
        "New pet image authoring requires a complete bubble profile in pet.json (appearance and all eight state rules). Start a new 'Create with OMP' workspace for the updated hatch-pet instructions; existing artwork can be reused.",
      );
    }
    await host.ready();
    if (imageMarker !== -1) {
      const imageArgument = host.argv[imageMarker + 1];
      if (!imageArgument)
        throw new TypeError("--input-image requires the actual generated image path.");
      const spritePath = path.join(path.dirname(manifestPath), manifest.spritesheet);
      try {
        if ((await lstat(spritePath)).isSymbolicLink())
          throw new TypeError("Cannot replace a symbolic-link spritesheet.");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const data = await host.convertImage(path.resolve(imageArgument));
      validatePetSheet(data, manifest);
      await writeFile(spritePath, data);
    }
    const pet = await host.library.importDirectory(path.dirname(manifestPath));
    console.log(JSON.stringify(pet));
    host.exit(0);
  } catch (error) {
    console.error(`[pet creation] ${error instanceof Error ? error.message : String(error)}`);
    host.exit(1);
  }
  return true;
}

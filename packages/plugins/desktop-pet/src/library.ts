import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_PET_IMAGE_BYTES,
  MAX_PET_MANIFEST_BYTES,
  parsePetManifest,
  validatePetSheet,
} from "./manifest.js";
import { createPetCreationWorkspace } from "./creation-workspace.js";
import type { PetCreationWorkspace, PetDescriptor, PetManifest } from "./types.js";

interface PetEntry {
  descriptor: PetDescriptor;
  manifest: PetManifest;
  spritePath: string;
  spriteDigest: string;
  archiveMember: boolean;
  preview: Buffer;
}

export interface PetLibraryOptions {
  builtInDirectory: string;
  userDataPath: string;
  skillPath: string;
  executablePath: string;
  appPath: string;
  packaged: boolean;
  decodeImage(data: Buffer, crop: { x: number; y: number; width: number; height: number }): { width: number; height: number; bitmap: Buffer; preview: Buffer };
}

async function readRegularFile(
  filePath: string,
  maximumBytes: number,
  archiveMember = false,
): Promise<Buffer> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximumBytes) {
    throw new TypeError(
      `Pet file must be a regular file no larger than ${maximumBytes} bytes: ${path.basename(filePath)}`,
    );
  }
  const file = await open(filePath, "r");
  try {
    const openedInfo = await file.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.size > maximumBytes ||
      (!archiveMember && (openedInfo.ino !== info.ino || openedInfo.dev !== info.dev))
    ) {
      throw new TypeError("Pet file changed while it was being opened.");
    }
    const data = await file.readFile();
    if (data.length > maximumBytes) throw new TypeError("Pet file grew beyond its permitted size.");
    return data;
  } finally {
    await file.close();
  }
}

async function readPetEntry(directory: string, id: string, builtIn: boolean, decodeImage: PetLibraryOptions["decodeImage"]): Promise<PetEntry> {
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new TypeError("Pet packages must be regular directories, not symbolic links.");
  }
  const root = await realpath(directory);
  // Electron extracts ASAR members for open(); their physical inode differs
  // from lstat()'s virtual identity. Only bundled, immutable assets use this path.
  const archiveMember = builtIn && root.includes(`.asar${path.sep}`);
  const manifestData = await readRegularFile(
    path.join(root, "pet.json"),
    MAX_PET_MANIFEST_BYTES,
    archiveMember,
  );
  const manifest = parsePetManifest(JSON.parse(manifestData.toString("utf8")) as unknown);
  const spritePath = path.join(root, manifest.spritesheet);
  if (path.dirname(await realpath(spritePath)) !== root) {
    throw new TypeError("Pet spritesheet must remain inside its package directory.");
  }
  const spriteData = await readRegularFile(spritePath, MAX_PET_IMAGE_BYTES, archiveMember);
  const { width, height } = validatePetSheet(spriteData, manifest);
  const image = decodeImage(spriteData, { x: 0, y: manifest.animations.idle.row * manifest.frameHeight, width: manifest.frameWidth, height: manifest.frameHeight });
  if (image.width !== width || image.height !== height) throw new TypeError("Pet spritesheet is not a decodable PNG.");
  const bitmap = image.bitmap;
  let visible = false;
  let transparent = false;
  for (let index = 3; index < bitmap.length && (!visible || !transparent); index += 4) {
    visible ||= bitmap[index] !== 0;
    transparent ||= bitmap[index] < 255;
  }
  if (!visible || !transparent) {
    throw new TypeError(
      "Pet spritesheet must contain visible artwork on a transparent background.",
    );
  }
  const spriteDigest = createHash("sha256").update(spriteData).digest("hex");
  const revision = createHash("sha256")
    .update(manifestData)
    .update(spriteDigest)
    .digest("hex")
    .slice(0, 16);
  const preview = image.preview;
  return {
    descriptor: {
      id,
      name: manifest.name,
      description: manifest.description ?? "",
      builtIn,
      spriteUrl: `omp-desktop://app/pet-sprites/${id}.png?v=${revision}`,
      previewUrl: `omp-desktop://app/pet-preview/${id}.png?v=${revision}`,
      frameWidth: manifest.frameWidth,
      frameHeight: manifest.frameHeight,
      sheetWidth: width,
      sheetHeight: height,
      animations: manifest.animations,
      ...(manifest.bubble ? { bubble: manifest.bubble } : {}),
    },
    manifest,
    spritePath,
    spriteDigest,
    archiveMember,
    preview,
  };
}

export class PetLibrary {
  private readonly entries = new Map<string, PetEntry>();
  private readonly customDirectory: string;

  constructor(private readonly options: PetLibraryOptions) {
    this.customDirectory = path.join(options.userDataPath, "pets");
  }

  async list(): Promise<PetDescriptor[]> {
    const iris = await readPetEntry(path.join(this.options.builtInDirectory, "iris"), "iris", true, this.options.decodeImage);
    const nextEntries = new Map<string, PetEntry>([["iris", iris]]);
    await mkdir(this.customDirectory, { recursive: true });
    const directories = await readdir(this.customDirectory, { withFileTypes: true });
    for (const entry of directories) {
      if (entry.name === "iris" || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(entry.name)) continue;
      if (entry.isSymbolicLink())
        throw new TypeError(`Custom pet ${entry.name} is a symbolic link.`);
      if (!entry.isDirectory()) continue;
      try {
        nextEntries.set(
          entry.name,
          await readPetEntry(path.join(this.customDirectory, entry.name), entry.name, false, this.options.decodeImage),
        );
      } catch (error) {
        throw new TypeError(
          `Cannot load custom pet ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    this.entries.clear();
    for (const [id, entry] of nextEntries) this.entries.set(id, entry);
    return [
      iris.descriptor,
      ...[...nextEntries.values()]
        .filter((entry) => !entry.descriptor.builtIn)
        .map((entry) => entry.descriptor)
        .sort(
          (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
        ),
    ];
  }

  async getSelected(id: string): Promise<PetDescriptor> {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw new TypeError("Invalid selected pet ID.");
    let entry = this.entries.get(id);
    if (!entry) {
      const directory =
        id === "iris"
          ? path.join(this.options.builtInDirectory, "iris")
          : path.join(this.customDirectory, id);
      try {
        entry = await readPetEntry(directory, id, id === "iris", this.options.decodeImage);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
          throw new TypeError(
            `Selected pet ${id} is no longer available. Refresh the pet library and choose an available pet.`,
            { cause: error },
          );
        throw error;
      }
      this.entries.set(id, entry);
    }
    return entry.descriptor;
  }

  async handleResource(pathname: string): Promise<Response | null> {
    if (!pathname.startsWith("/pet-sprites/") && !pathname.startsWith("/pet-preview/")) return null;
    const match = /^\/pet-(sprites|preview)\/([a-z0-9][a-z0-9-]{0,80})\.png$/.exec(pathname);
    if (!match) return new Response("Not found", { status: 404 });
    const [, kind, id] = match;
    try {
      await this.getSelected(id);
      const entry = this.entries.get(id)!;
      const data =
        kind === "preview"
          ? entry.preview
          : await readRegularFile(entry.spritePath, MAX_PET_IMAGE_BYTES, entry.archiveMember);
      if (
        kind === "sprites" &&
        createHash("sha256").update(data).digest("hex") !== entry.spriteDigest
      ) {
        return new Response("Pet image changed; refresh the pet library", { status: 409 });
      }
      return new Response(
        new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
        {
          headers: {
            "content-type": "image/png",
            "cache-control": "private, max-age=3600",
            "x-content-type-options": "nosniff",
          },
        },
      );
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  async importDirectory(directory: string): Promise<PetDescriptor> {
    if (typeof directory !== "string" || !directory.trim())
      throw new TypeError("Choose a pet package directory.");
    const id = randomUUID();
    const source = await readPetEntry(directory, id, false, this.options.decodeImage);
    const spriteData = await readRegularFile(source.spritePath, MAX_PET_IMAGE_BYTES);
    if (createHash("sha256").update(spriteData).digest("hex") !== source.spriteDigest) {
      throw new TypeError("Pet spritesheet changed during import.");
    }
    await mkdir(this.customDirectory, { recursive: true });
    const temporaryDirectory = path.join(this.customDirectory, `.import-${id}`);
    const destination = path.join(this.customDirectory, id);
    await mkdir(temporaryDirectory);
    try {
      await writeFile(
        path.join(temporaryDirectory, "pet.json"),
        `${JSON.stringify({ ...source.manifest, spritesheet: "sprites.png" }, null, 2)}\n`,
      );
      await writeFile(path.join(temporaryDirectory, "sprites.png"), spriteData);
      await rename(temporaryDirectory, destination);
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
    const installed = await readPetEntry(destination, id, false, this.options.decodeImage);
    this.entries.set(id, installed);
    return installed.descriptor;
  }

  async prepareCreation(description?: string): Promise<PetCreationWorkspace> {
    const iris = await this.getSelected("iris");
    const preview = this.entries.get(iris.id)!.preview;
    return createPetCreationWorkspace({
      ...this.options,
      description,
      referencePreview: preview,
    });
  }

  async clearData(): Promise<void> {
    await rm(this.customDirectory, { recursive: true, force: true });
    this.entries.clear();
  }
}


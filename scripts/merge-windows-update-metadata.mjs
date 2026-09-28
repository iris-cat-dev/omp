import { readFile, writeFile } from "node:fs/promises";
import { load, dump } from "js-yaml";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseMetadata(contents, sourcePath) {
  const value = load(contents);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid update metadata in ${sourcePath}`);
  }
  if (typeof value.version !== "string" || !Array.isArray(value.files)) {
    throw new Error(`Update metadata in ${sourcePath} is missing version or files`);
  }
  for (const file of value.files) {
    if (
      typeof file !== "object" ||
      file === null ||
      Array.isArray(file) ||
      typeof file.url !== "string" ||
      typeof file.sha512 !== "string"
    ) {
      throw new Error(`Update metadata in ${sourcePath} contains an invalid file entry`);
    }
  }
  return value;
}

export function mergeWindowsUpdateMetadata(documents) {
  if (documents.length === 0) {
    throw new Error("At least one Windows update metadata document is required");
  }

  const [first, ...rest] = documents;
  const filesByUrl = new Map(first.files.map((file) => [file.url, file]));
  for (const document of rest) {
    if (document.version !== first.version) {
      throw new Error(
        `Cannot merge Windows update metadata for ${first.version} and ${document.version}`,
      );
    }
    for (const file of document.files) {
      filesByUrl.set(file.url, file);
    }
  }

  return { ...first, files: [...filesByUrl.values()] };
}

async function main(args) {
  const [destinationPath, ...sourcePaths] = args;
  if (!destinationPath || sourcePaths.length === 0) {
    throw new Error(
      "Usage: node scripts/merge-windows-update-metadata.mjs <destination> <source...>",
    );
  }

  const documents = await Promise.all(
    sourcePaths.map(async (sourcePath) =>
      parseMetadata(await readFile(sourcePath, "utf8"), sourcePath),
    ),
  );
  const merged = mergeWindowsUpdateMetadata(documents);
  await writeFile(destinationPath, dump(merged, { lineWidth: 120, noRefs: true }), "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}

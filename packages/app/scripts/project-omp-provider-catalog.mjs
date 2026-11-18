import { readFile, writeFile } from "node:fs/promises";

// Project the pinned SDK's bundled catalog to the two public fields the
// connection directory needs before sign-in. Never copy transport or auth data.
const source = new URL("../../../omp-sdk/packages/catalog/src/models.json", import.meta.url);
const target = new URL("../src/components/omp-provider-model-index.json", import.meta.url);
const { version, keys, nodes, providers } = JSON.parse(await readFile(source, "utf8"));
const nameIndex = keys.indexOf("name");
if (version !== 1 || nameIndex === -1) throw new Error("Unsupported OMP model catalog format");

function modelName(reference) {
  const [kind, entries] = nodes[reference[0]];
  if (kind !== 0) throw new Error("Expected an OMP model catalog object");
  for (let index = 0; index < entries.length; index += 2) {
    if (entries[index] === nameIndex) return entries[index + 1];
  }
}

const index = Object.fromEntries(providers.map(([providerId, constants, models]) => {
  const commonName = modelName(constants);
  return [providerId, models.map(([id, row]) => {
    const name = modelName(row) ?? commonName;
    if (typeof name !== "string" || !name) throw new Error(`Missing display name: ${providerId}/${id}`);
    return name === id ? [id] : [id, name];
  })];
}));
const lines = Object.entries(index).map(([id, models]) => `  ${JSON.stringify(id)}: ${JSON.stringify(models)}`);
await writeFile(target, `{\n${lines.join(",\n")}\n}\n`);

import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { DesktopPluginMetadataSchema } from "@omp-desktop/protocol/desktop-plugins";
import { PluginIdSchema } from "@omp-desktop/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { z } from "zod";

export type PluginDirectorySource =
  | { kind: "desktop"; owner: "desktop" | "daemon"; id: string }
  | { kind: "native"; id: string };

// The legacy manifest has only an id; its service runs on the daemon.
const LegacyManifestSchema = z.object({ id: PluginIdSchema }).strict();
const ManifestObjectSchema = z.record(z.string(), z.unknown());
const NativePackageNameSchema = z
  .string()
  .regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i);

/** Identifies a plugin target without importing or executing its code. */
export async function inspectPluginDirectorySource(
  directory: string,
  client: Pick<DaemonClient, "listDirectory" | "readFile">,
): Promise<PluginDirectorySource> {
  if (!directory.trim())
    throw new Error(
      i18n.t("plugins.folder.required", { defaultValue: "Choose a plugin folder first." }),
    );
  const listing = await client.listDirectory(directory, ".");
  const readManifest = async (name: string): Promise<unknown | undefined> => {
    const entry = listing.entries.find((candidate) => candidate.name === name);
    if (!entry) return undefined;
    if (entry.kind !== "file")
      throw new Error(
        i18n.t("plugins.folder.manifestFile", { defaultValue: "{{name}} must be a file.", name }),
      );
    const file = await client.readFile(directory, entry.path);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
  };
  const rawPackage = await readManifest("package.json");
  const pkg = rawPackage === undefined ? undefined : ManifestObjectSchema.parse(rawPackage);
  const legacy = await readManifest("omp-plugin.json");
  const hasDesktop = !!pkg && Object.hasOwn(pkg, "ompDesktop");
  const hasOmp = !!pkg && Object.hasOwn(pkg, "omp");
  const hasPi = !!pkg && Object.hasOwn(pkg, "pi");
  const hasNative = hasOmp || hasPi;
  const kinds = Number(hasDesktop) + Number(legacy !== undefined) + Number(hasNative);
  if (kinds > 1)
    throw new Error(
      i18n.t("plugins.folder.ambiguous", {
        defaultValue: "Ambiguous plugin folder: multiple plugin formats are declared.",
      }),
    );
  if (hasDesktop) {
    const metadata = DesktopPluginMetadataSchema.parse(pkg!.ompDesktop);
    return { kind: "desktop", owner: metadata.owner, id: metadata.id };
  }
  if (legacy !== undefined) {
    const manifest = LegacyManifestSchema.parse(legacy);
    return { kind: "desktop", owner: "daemon", id: manifest.id };
  }
  if (hasNative) {
    if (hasOmp) ManifestObjectSchema.parse(pkg!.omp);
    if (hasPi) ManifestObjectSchema.parse(pkg!.pi);
    const name = NativePackageNameSchema.safeParse(pkg!.name);
    if (!name.success)
      throw new Error(
        i18n.t("plugins.folder.nativeName", {
          defaultValue: "Native plugin package.json must have a valid package name.",
        }),
        { cause: name.error },
      );
    return { kind: "native", id: name.data };
  }
  throw new Error(
    i18n.t("plugins.folder.notPlugin", {
      defaultValue: "This folder does not contain Desktop or native OMP plugin metadata.",
    }),
  );
}

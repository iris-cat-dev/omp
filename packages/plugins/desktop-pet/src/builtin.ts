import { z } from "zod";
import { PetLibrary, type PetLibraryOptions } from "./library.js";
import { setup } from "./service.js";
import { tryRunPetCreationCli, type PetInstallHost } from "./creation-cli.js";
const ImportSchema = z.object({ directory: z.string().min(1) });
const CreationSchema = z.object({ description: z.string().max(8000).optional() });
export interface DesktopPetBuiltinDefinition {
  id: string;
  setup: typeof setup;
  manage: Readonly<Record<string, (input: unknown) => unknown | Promise<unknown>>>;
  publicCommands: Readonly<Record<string, (input: unknown) => unknown | Promise<unknown>>>;
  resource(pathname: string): Promise<Response | null>;
  clearData(): Promise<void>;
  runInstallCli(host: PetInstallHost): Promise<boolean>;
}
export function createDesktopPetDefinition(options: PetLibraryOptions): DesktopPetBuiltinDefinition {
  const library = new PetLibrary(options);
  return {
    id: "desktop-pet",
    setup,
    manage: {
      "pet:list": () => library.list(),
      "pet:import": (input: unknown) => library.importDirectory(ImportSchema.parse(input).directory),
      "pet:prepareCreation": (input: unknown) => library.prepareCreation(CreationSchema.parse(input ?? {}).description),
      "pet:selected": (input: unknown) => library.getSelected(z.object({ id: z.string() }).parse(input).id),
    },
    resource: (pathname: string) => library.handleResource(pathname),
    clearData: () => library.clearData(),
    publicCommands: {
      list_desktop_pets: () => library.list(),
      import_desktop_pet: (input: unknown) => library.importDirectory(ImportSchema.parse(input).directory),
      prepare_desktop_pet_creation: (input: unknown) => library.prepareCreation(CreationSchema.parse(input ?? {}).description),
    },
    runInstallCli: (host: PetInstallHost) => tryRunPetCreationCli({ ...host, library }),
  };
}

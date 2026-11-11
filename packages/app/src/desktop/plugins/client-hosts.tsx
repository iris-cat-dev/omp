import { configureDesktopPetClientHost } from "@omp-desktop/plugin-desktop-pet";
import { desktopPetClientHost } from "./pet-client-host";
export function configureBuiltinPluginClientHosts(): void { configureDesktopPetClientHost(desktopPetClientHost); }

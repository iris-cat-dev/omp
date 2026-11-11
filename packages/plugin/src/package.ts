import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DesktopPluginMetadataSchema, type DesktopPluginMetadata } from "@omp-desktop/protocol/desktop-plugins";
import { readPluginManifest } from "./manifest.js";
export interface InspectedPluginPackage {
 id:string; version:string; format:"legacy"|"package"; metadata:DesktopPluginMetadata|null; capabilities:string[];
 directory:string; clientEntry?:string; serviceEntry?:string;
}
async function entry(directory:string, relative:string):Promise<string> {
 if (!relative.startsWith("./") || !/\.(?:mjs|cjs|js)$/.test(relative)) throw new Error(`Compiled entry must be relative JavaScript: ${relative}`);
 const root=await realpath(directory); const resolved=await realpath(path.resolve(directory,relative));
 if (!resolved.startsWith(root+path.sep)) throw new Error(`Plugin entry escapes package: ${relative}`);
 if (!(await stat(resolved)).isFile()) throw new Error(`Plugin entry is not a file: ${relative}`);
 return resolved;
}
export async function inspectPluginPackage(directory:string):Promise<InspectedPluginPackage> {
 const packageFile=path.join(directory,"package.json");
 let pkg: {version?:unknown; ompDesktop?:unknown; dependencies?:Record<string,string>}|undefined;
 try {pkg=JSON.parse(await readFile(packageFile,"utf8"));} catch(error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
 if (pkg?.ompDesktop!==undefined) {
  const metadata=DesktopPluginMetadataSchema.parse(pkg.ompDesktop);
  if(typeof pkg.version!=="string" || !pkg.version.trim()) throw new Error("Desktop package version is required");
  if(pkg.dependencies?.["@oh-my-pi/pi-coding-agent"]) throw new Error("Desktop packages must not deliver a second OMP SDK");
  return {id:metadata.id,version:pkg.version,format:"package",metadata,capabilities:metadata.capabilities,directory,
   clientEntry:metadata.entries.client?await entry(directory,metadata.entries.client):undefined,
   serviceEntry:metadata.entries.service?await entry(directory,metadata.entries.service):undefined};
 }
 const manifest=await readPluginManifest(directory);
 let serviceEntry:string|undefined;
 for(const name of ["index.ts","index.tsx"]) {const candidate=path.join(directory,name); try {if((await stat(candidate)).isFile()){serviceEntry=candidate;break;}}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
 if(!serviceEntry)throw new Error("Legacy plugin entry index.ts or index.tsx is missing");
 return {id:manifest.id,version:"legacy",format:"legacy",metadata:null,capabilities:[],directory,serviceEntry};
}

import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PluginIdSchema } from "@omp-desktop/protocol/messages";
export class PluginDataStore {
 constructor(private readonly home:string) {}
 directory(id:string){PluginIdSchema.parse(id); return path.join(this.home,"plugins",id);}
 private read<T>(id:string,name:string,fallback:T):T {try{return JSON.parse(readFileSync(path.join(this.directory(id),name),"utf8")) as T;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return fallback;throw error;}}
 private write(id:string,name:string,value:unknown){const directory=this.directory(id);mkdirSync(directory,{recursive:true,mode:0o700});const file=path.join(directory,name);const temporary=file+"."+randomUUID();writeFileSync(temporary,JSON.stringify(value),{mode:0o600});renameSync(temporary,file);}
 get(id:string){return this.read(id,"storage.json",{revision:0,values:{} as Record<string,unknown>});}
 patch(id:string,fields:Record<string,unknown>,expectedRevision:number){const current=this.get(id);if(current.revision!==expectedRevision)throw new Error(`Plugin configuration revision conflict: expected ${expectedRevision}, current ${current.revision}`);const next={revision:current.revision+1,values:{...current.values,...fields}};this.write(id,"storage.json",next);return next;}
 secret(id:string,key:string,operation:"get"|"configured"|"set"|"delete",value?:string){if(!key || key.length>256)throw new Error("Invalid secret key");const secrets=this.read(id,"secrets.json",{} as Record<string,string>);if(operation==="get")return secrets[key]??null;if(operation==="configured")return Object.hasOwn(secrets,key);if(operation==="set"){if(value===undefined)throw new Error("Secret value required");secrets[key]=value;}else delete secrets[key];this.write(id,"secrets.json",secrets);return Object.hasOwn(secrets,key);}
 clear(id:string){for(const name of ["storage.json","secrets.json"])rmSync(path.join(this.directory(id),name),{force:true});}
}

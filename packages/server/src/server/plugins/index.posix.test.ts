import {mkdtemp,writeFile,readFile,rm,rename} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import pino from "pino";
import {afterEach,describe,expect,it} from "vitest";
import {DaemonConfigStore} from "../daemon-config-store.js";
import {PluginService,type PluginRuntimePort} from "./index.js";
import type {PluginSource} from "@omp-desktop/protocol/messages";
const roots:string[]=[];const services:PluginService[]=[];
afterEach(async()=>{await Promise.all(services.splice(0).map(service=>service.stopAllPlugins()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function directory(id="package-id",source="export default function contribute(p){return ()=>{};}"){const root=await mkdtemp(path.join(tmpdir(),"desktop-plugin-registry-"));roots.push(root);await writeFile(path.join(root,"omp-plugin.json"),JSON.stringify({id}));await writeFile(path.join(root,"index.ts"),source);return root;}
async function packageDirectory(version="1.0.0"){
 const root=await mkdtemp(path.join(tmpdir(),"desktop-bundled-plugin-"));roots.push(root);
 await writeFile(path.join(root,"package.json"),JSON.stringify({name:"@fixture/bundled-plugin",version,type:"module",ompDesktop:{apiVersion:1,id:"package-id",owner:"daemon",entries:{client:"./client.mjs",service:"./service.mjs"},capabilities:["storage.scoped"]}}));
 await writeFile(path.join(root,"client.mjs"),"export default function contribute(p){return ()=>{};}");
 await writeFile(path.join(root,"service.mjs"),"export default function contribute(p){return ()=>{};}");
 return root;
}
function runtime(){
 const running=new Set<string>();const generations=new Map<string,number>();const starts:string[]=[];const stops:string[]=[];const cleared:string[]=[];
 let beforeStart:(id:string)=>Promise<void>=async()=>{};
 const port:PluginRuntimePort={catalog:()=>[...running].map(id=>({id,clientBundle:"bundle"})),invoke:async(id,_method,_input,generation)=>{if(!running.has(id))throw new Error("not running");if(generation!==undefined&&generation!==generations.get(id))throw new Error("stale generation");return id;},getLogs:()=>[{sequence:1,timestamp:"2026-11-10T00:00:00.000Z",stream:"stdout",message:"retained"}],clearLogs:id=>{cleared.push(id);},startPlugin:async(id,_directory,canPublish,_info,_grants,mode)=>{starts.push(id);if(mode!=="manage")generations.set(id,(generations.get(id)??0)+1);await beforeStart(id);if(!canPublish())throw new Error("start cancelled");running.add(id);},stopPluginById:async id=>{stops.push(id);return running.delete(id);},stopAll:async()=>{running.clear();},subscribe:()=>()=>{},bindOmpSessionHost:()=>{},generation:id=>generations.get(id)??0,invalidateGeneration:id=>{generations.set(id,(generations.get(id)??0)+1);}};
 return{port,starts,stops,cleared,running,setBeforeStart:(callback:(id:string)=>Promise<void>)=>{beforeStart=callback;}};
}
async function registry(enabled=false,plugins:Record<string,PluginSource>={}){const home=await mkdtemp(path.join(tmpdir(),"desktop-plugin-home-"));roots.push(home);const store=new DaemonConfigStore(home,{mcp:{injectIntoAgents:true},browserTools:{enabled:false},providers:{},metadataGeneration:{providers:[]},autoArchiveAfterMerge:false,enableTerminalAgentHooks:false,appendSystemPrompt:"",pluginsEnabled:enabled,plugins});const fake=runtime();const service=new PluginService(pino({level:"silent"}),store,fake.port);services.push(service);await service.start();return{service,store,fake,home};}
describe("authoritative daemon Desktop plugin installation",()=>{
 it("preserves global pause and exact runtime identities for two installations of one directory",async()=>{const source=await directory();const {service,store,fake}=await registry(false);await service.installDirectory({path:source,id:"first-install",trusted:true});await service.installDirectory({path:source,id:"second-install",trusted:true});expect(store.get().pluginsEnabled).toBe(false);expect(service.listPlugins().map(item=>item.id)).toEqual(["first-install","second-install"]);expect(fake.starts).toEqual([]);expect(service.catalog().map(item=>item.packageId)).toEqual(["package-id","package-id"]);});
 it("requires explicit trust before storing or executing a new source",async()=>{const source=await directory();const {service,store,fake}=await registry(true);await expect(service.installDirectory({path:source})).rejects.toThrow(/explicit trust/);expect(store.get().plugins).toEqual({});expect(fake.starts).toEqual([]);});
 it("persists selected enabled state before activation and preserves it at shutdown",async()=>{const source=await directory();const {service,store,fake}=await registry(true);fake.setBeforeStart(async id=>{expect(store.get().plugins?.[id]?.enabled).toBe(true);});await service.installDirectory({path:source,id:"chosen-id",trusted:true});await service.stopAllPlugins();expect(store.get().plugins?.["chosen-id"]?.enabled).toBe(true);});
 it("inherits enabled-missing legacy choices without starting paused discovery",async()=>{const source=await directory();const {service,store,fake}=await registry(false,{"custom-id":{source:"directory",path:source}});await service.reloadPlugin("custom-id");expect(service.listPlugins()[0]).toMatchObject({id:"custom-id",enabled:true,status:"disabled"});expect(store.get().pluginsEnabled).toBe(false);expect(fake.starts).toEqual([]);});
 it("does not promote an old disabled source to implicit trust when enabled",async()=>{const source=await directory();const {service,fake}=await registry(true,{"disabled-old":{source:"directory",path:source,enabled:false}});await service.enablePlugin("disabled-old");expect(service.catalog()[0].trusted).toBe(false);expect(fake.starts).toEqual([]);});
 it("one installation has one service across repeated enables and RPC callers",async()=>{const source=await directory();const {service,fake}=await registry(true);await service.installDirectory({path:source,trusted:true});await service.enablePlugin("package-id");const generation=service.catalog()[0].generation;await Promise.all([service.invokePluginRpc("package-id","test",{},generation),service.invokePluginRpc("package-id","test",{},generation)]);expect(fake.starts).toEqual(["package-id"]);});
 it("rejects stale generations after reload and cannot forge authenticated agent tool calls",async()=>{const source=await directory();const {service}=await registry(true);await service.installDirectory({path:source,trusted:true});const generation=service.catalog()[0].generation;await service.reloadPlugin("package-id");await expect(service.invokePluginRpc("package-id","test",{},generation)).rejects.toThrow(/generation/);await expect(service.invokePluginRpc("package-id","agent-tool.qqbot_send_file",{agentId:"forged"},service.catalog()[0].generation)).rejects.toThrow(/authenticated host/);});
 it("revokes execution trust durably while retaining desired enabled state",async()=>{const source=await directory();const {service,store,fake}=await registry(true);await service.installDirectory({path:source,trusted:true});await service.revokePluginTrust("package-id");expect(store.get().plugins?.["package-id"]).toMatchObject({enabled:true,trustRevoked:true});expect(fake.running.size).toBe(0);expect(service.catalog()[0]).toMatchObject({trusted:false,clientBundle:undefined});await service.approvePlugin("package-id",{trusted:true,version:"legacy",capabilities:[]},{sourcePath:source,packageId:"package-id",generation:service.catalog()[0].generation});expect(service.catalog()[0].trusted).toBe(true);});
 it("retains config data and source ownership on disable and ordinary remove",async()=>{const source=await directory();const {service,fake}=await registry(true);await service.installDirectory({path:source,trusted:true});service.storagePatch("package-id",{choice:"keep"},0);await service.disablePlugin("package-id");expect(service.storageGet("package-id")).toEqual({revision:1,values:{choice:"keep"}});expect(service.getLogs("package-id")).toHaveLength(1);await service.removePlugin("package-id");expect(fake.cleared).toEqual(["package-id"]);expect(await readFile(path.join(source,"omp-plugin.json"),"utf8")).toContain("package-id");await service.installDirectory({path:source,trusted:true,enabled:false});expect(service.storageGet("package-id").values.choice).toBe("keep");});
 it("rejects stale field patches and isolates a failed reload without restoring old code",async()=>{const source=await directory();const {service,fake}=await registry(true);await service.installDirectory({path:source,trusted:true});service.storagePatch("package-id",{choice:1},0);expect(()=>service.storagePatch("package-id",{choice:2},0)).toThrow(/revision conflict/);await writeFile(path.join(source,"index.ts"),"invalid syntax {");await expect(service.reloadPlugin("package-id")).rejects.toThrow();expect(fake.running.size).toBe(0);expect(service.catalog()[0].clientBundle).toBeUndefined();});
 it("rejects a trust confirmation for an ID replaced by another source",async()=>{const first=await directory();const second=await directory();const {service}=await registry(true);await service.installDirectory({path:first,trusted:true});const entry=service.catalog()[0];await service.removePlugin("package-id");await service.installDirectory({path:second,trusted:true,enabled:false});await service.revokePluginTrust("package-id");await expect(service.approvePlugin("package-id",{trusted:true,version:"legacy",capabilities:[]},{sourcePath:entry.source.path,packageId:entry.packageId,generation:entry.generation})).rejects.toThrow(/changed during trust approval/);expect(service.catalog()[0].trusted).toBe(false);});
 it("rejects stale configuration and secret mutations after revocation",async()=>{const source=await directory();const {service}=await registry(true);await service.installDirectory({path:source,trusted:true});const generation=service.catalog()[0].generation;await service.disablePlugin("package-id");expect(()=>service.storagePatch("package-id",{late:true},0,generation)).toThrow(/generation/);expect(()=>service.secret("package-id","token","set","not-a-real-secret",generation)).toThrow(/generation/);});
 it("rebases a moved bundled package while preserving pause, approval and configuration",async()=>{
  const original=await packageDirectory();const moved=original+"-moved";await rename(original,moved);roots.push(moved);
  const previous:PluginSource={source:"directory",path:original,bundled:true,installed:true,enabled:true,approval:{trusted:true,version:"1.0.0",capabilities:["storage.scoped"]}};
  const {service,store,fake}=await registry(false,{"package-id":previous});service.storagePatch("package-id",{accountChoice:"retained"},0);
  await service.registerBundledDirectories([moved]);
  expect(store.get().plugins?.["package-id"]).toEqual({...previous,path:moved});expect(store.get().pluginsEnabled).toBe(false);
  expect(service.catalog()[0]).toMatchObject({version:"1.0.0",format:"package",source:{path:moved},enabled:true,effectiveEnabled:false,trusted:true,status:"disabled",error:undefined});
  expect(service.storageGet("package-id")).toEqual({revision:1,values:{accountChoice:"retained"}});expect(fake.running.size).toBe(0);
 });
 it("does not replace a user-installed package with the same bundled ID",async()=>{
  const original=await packageDirectory();const bundled=await packageDirectory();
  const previous:PluginSource={source:"directory",path:original,bundled:false,installed:true,enabled:false,approval:{trusted:true,version:"1.0.0",capabilities:["storage.scoped"]}};
  const {service,store}=await registry(false,{"package-id":previous});await service.registerBundledDirectories([bundled]);
  expect(store.get().plugins?.["package-id"]).toEqual(previous);expect(service.catalog()[0].source.path).toBe(original);
 });
 it.each([
  {state:"revoked trust",version:"1.0.0",installed:true,enabled:true,trustRevoked:true,trusted:false},
  {state:"removed installation",version:"1.0.0",installed:false,enabled:false,trustRevoked:false,trusted:true},
  {state:"unapproved version",version:"2.0.0",installed:true,enabled:true,trustRevoked:false,trusted:false},
 ])("preserves $state when a bundled package moves",async({version,installed,enabled,trustRevoked,trusted})=>{
  const original=await packageDirectory();const moved=await packageDirectory(version);
  const previous:PluginSource={source:"directory",path:original,bundled:true,installed,enabled,trustRevoked,approval:{trusted:true,version:"1.0.0",capabilities:["storage.scoped"]}};
  const {service,store,fake}=await registry(true,{"package-id":previous});await service.registerBundledDirectories([moved]);
  expect(store.get().plugins?.["package-id"]).toEqual({...previous,path:moved});
  expect(service.catalog()[0]).toMatchObject({version,installed,enabled,trusted,effectiveEnabled:false,source:{path:moved}});expect(fake.running.size).toBe(0);
 });
 it("retires the old generation on relocation without restarting an unchanged path",async()=>{
  const original=await packageDirectory();const moved=await packageDirectory();
  const previous:PluginSource={source:"directory",path:original,bundled:true,installed:true,enabled:true,approval:{trusted:true,version:"1.0.0",capabilities:["storage.scoped"]}};
  const {service}=await registry(true,{"package-id":previous});await service.enablePlugin("package-id");const generation=service.catalog()[0].generation;
  await service.registerBundledDirectories([moved]);const current=service.catalog()[0];
  expect(current).toMatchObject({source:{path:moved},status:"running"});expect(current.generation).toBeGreaterThan(generation);
  await expect(service.invokePluginRpc("package-id","test",{},generation)).rejects.toThrow(/generation/);
  await service.registerBundledDirectories([moved]);expect(service.catalog()[0].generation).toBe(current.generation);
 });
});

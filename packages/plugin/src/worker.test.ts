import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {afterEach,describe,expect,it} from "vitest";
import {compilePackageEntries,compilePlugin} from "./compiler.js";
import {IsolatedPluginWorker} from "./worker.js";
const roots:string[]=[];const workers:IsolatedPluginWorker[]=[];
afterEach(async()=>{await Promise.all(workers.splice(0).map(worker=>worker.stop()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function bundle(source:string,kind:"mjs"|"cjs"|"ts"="mjs"){const root=await mkdtemp(path.join(tmpdir(),"desktop-plugin-worker-"));roots.push(root);await mkdir(path.join(root,"dist"));const entry=path.join(root,`dist/service.${kind}`);await writeFile(entry,source);return {serviceEntry:entry,serverBundle:(kind==="ts"?await compilePlugin(entry):await compilePackageEntries({serviceEntry:entry})).serverBundle};}
const installation={id:"worker-example",packageId:"worker-example",owner:"desktop" as const,version:"1.0.0",generation:7,enabled:false,declaredCapabilities:["storage.scoped"],grantedCapabilities:["storage.scoped"]};
describe("isolated Desktop service worker",()=>{
 it("loads named management without ever calling active setup",async()=>{
  let starts=0;
  const {serverBundle,serviceEntry}=await bundle(`import {defineRpc} from '@omp-desktop/plugin/server';import {z} from 'zod';const status=defineRpc({name:'status',input:z.object({}),output:z.object({managed:z.boolean()})});export function manage(ctx){ctx.handle(status,()=>({managed:true}));}export default async ctx=>{await ctx.storage.patch({started:true},0);ctx.handle(status,()=>({managed:false}));};`);
  const worker=await IsolatedPluginWorker.start({installation,serverBundle,serviceEntry,format:"package",mode:"manage",hostCall:()=>{starts++;return {revision:1,values:{}};}});workers.push(worker);
  expect(await worker.invoke("status",{},7)).toEqual({managed:true});expect(starts).toBe(0);
  await expect(worker.invoke("status",{},6)).rejects.toThrow(/generation/);
  await worker.stop();await expect(worker.invoke("status",{},7)).rejects.toThrow(/generation/);
 },10000);
 it.each([
  {kind:"mjs" as const,source:`import {defineRpc} from '@omp-desktop/plugin/server';import {z} from 'zod';const status=defineRpc({name:'status',input:z.object({}),output:z.boolean()});export const manage=ctx=>{ctx.handle(status,()=>true);};export default async ctx=>{await ctx.storage.patch({active:true},0);};`},
  {kind:"cjs" as const,source:`const {defineRpc}=require('@omp-desktop/plugin/server');const {z}=require('zod');const status=defineRpc({name:'status',input:z.object({}),output:z.boolean()});module.exports=async ctx=>{await ctx.storage.patch({active:true},0);};module.exports.manage=ctx=>{ctx.handle(status,()=>true);};`},
 ])("loads named management from $kind without invoking its default",async({source,kind})=>{
  let activeCalls=0;
  const {serverBundle,serviceEntry}=await bundle(source,kind);
  const worker=await IsolatedPluginWorker.start({installation,serverBundle,serviceEntry,format:"package",mode:"manage",hostCall:()=>{activeCalls++;return {revision:1,values:{}};}});workers.push(worker);
  expect(await worker.invoke("status",{},7)).toBe(true);expect(activeCalls).toBe(0);
 },10000);
 it("activates a source arrow default with the public SDK",async()=>{
  const {serverBundle,serviceEntry}=await bundle(`import {defineRpc} from '@omp-desktop/plugin/server';import {z} from 'zod';const status=defineRpc({name:'status',input:z.object({}),output:z.string()});export default ctx=>{ctx.handle(status,()=> 'legacy-active');return()=>{};};`,"ts");
  const worker=await IsolatedPluginWorker.start({installation:{...installation,version:"legacy",enabled:true},serverBundle,serviceEntry,format:"legacy",mode:"active",hostCall:()=>undefined});workers.push(worker);
  expect(await worker.invoke("status",{},7)).toBe("legacy-active");
 },10000);
 it("requires historical cleanup regardless of its installation version",async()=>{
  const {serverBundle,serviceEntry}=await bundle(`export default ctx=>{void ctx;};`,"ts");
  await expect(IsolatedPluginWorker.start({installation:{...installation,enabled:true},serverBundle,serviceEntry,format:"legacy",mode:"active",hostCall:()=>undefined})).rejects.toThrow("must return a cleanup function");
 },10000);
 it("revokes execution before cleanup and still releases its native lease",async()=>{
  const released:unknown[]=[];const logs:string[]=[];
  const {serverBundle,serviceEntry}=await bundle(`export default ctx=>{ctx.own(async()=>{if(!ctx.signal.aborted)throw new Error('cleanup ran before cancellation');await ctx.native.invoke('overlay.release',{leaseId:'owned-overlay'});});return()=>console.log('cleanup-aborted:'+ctx.signal.aborted);};`);
  const worker=await IsolatedPluginWorker.start({installation:{...installation,enabled:true},serverBundle,serviceEntry,format:"package",mode:"active",hostCall:(operation,input)=>{if(operation!=="overlay.release")throw new Error("Unexpected host operation");released.push(input);},onLog:(_stream,message)=>logs.push(message)});workers.push(worker);
  await worker.stop();await worker.stop();
  expect(released).toEqual([{leaseId:"owned-overlay"}]);
  expect(logs).toContain("cleanup-aborted:true");
 },10000);
 it("aborts pending setup and releases both early and late cleanup resources",async()=>{
  const controller=new AbortController();const logs:string[]=[];
  const {serverBundle,serviceEntry}=await bundle(`import {appendFile} from 'node:fs/promises';export default async ctx=>{const output=new URL('./released.txt',import.meta.url);ctx.own(()=>appendFile(output,'early:'+ctx.signal.aborted+'\\n'));const cancelled=Promise.withResolvers();ctx.signal.addEventListener('abort',()=>cancelled.resolve(),{once:true});console.log('setup-waiting');await cancelled.promise;return()=>appendFile(output,'late:'+ctx.signal.aborted+'\\n');};`);
  const starting=IsolatedPluginWorker.start({installation:{...installation,enabled:true},serverBundle,serviceEntry,format:"package",mode:"active",signal:controller.signal,hostCall:()=>undefined,onLog:(_stream,message)=>logs.push(message)});
  const rejected=expect(starting).rejects.toThrow(/generation/);
  try {
   await expect.poll(()=>logs.includes("setup-waiting")).toBe(true);
   controller.abort();await rejected;
   expect((await readFile(path.join(path.dirname(serviceEntry),"released.txt"),"utf8")).trim().split("\n").sort()).toEqual(["early:true","late:true"]);
  } finally {controller.abort();await starting.catch(()=>undefined);}
 },10000);
 it("accepts package void cleanup even when its version is named legacy",async()=>{
  const {serverBundle,serviceEntry}=await bundle(`import {defineRpc} from '@omp-desktop/plugin/server';import {z} from 'zod';export default ctx=>{ctx.handle(defineRpc({name:'status',input:z.object({}),output:z.boolean()}),()=>true);};`);
  const worker=await IsolatedPluginWorker.start({installation:{...installation,version:"legacy",enabled:true},serverBundle,serviceEntry,format:"package",mode:"active",hostCall:()=>undefined});workers.push(worker);
  expect(await worker.invoke("status",{},7)).toBe(true);
 },10000);
 it("reports waiting without delaying worker ready or settings RPC",async()=>{
  const reasons:Array<string|null>=[];
  const {serverBundle,serviceEntry}=await bundle(`import {defineRpc} from '@omp-desktop/plugin/server';import {z} from 'zod';export default ctx=>{ctx.waiting('Credentials required');ctx.handle(defineRpc({name:'status',input:z.object({}),output:z.string()}),()=> 'waiting');};`);
  const worker=await IsolatedPluginWorker.start({installation:{...installation,enabled:true},serverBundle,serviceEntry,format:"package",mode:"active",hostCall:()=>undefined,onWaiting:reason=>reasons.push(reason)});workers.push(worker);
  expect(reasons).toContain("Credentials required");expect(await worker.invoke("status",{},7)).toBe("waiting");
 },10000);
 it("keeps each RPC schema/handler pair and parses transformed input/output once",async()=>{
  const {serverBundle,serviceEntry}=await bundle(`import {defineRpc} from '@omp-desktop/plugin/server';import {z} from 'zod';let inputs=0;let outputs=0;const typed=defineRpc({name:'typed',input:z.string().transform(value=>{inputs++;return {value};}),output:z.number().transform(size=>{outputs++;return {size};})});const numeric=defineRpc({name:'numeric',input:z.number(),output:z.string()});const counts=defineRpc({name:'counts',input:z.object({}),output:z.object({inputs:z.number(),outputs:z.number()})});export default ctx=>{ctx.handle(typed,input=>input.value.length);ctx.handle(numeric,input=>String(input));ctx.handle(counts,()=>({inputs,outputs}));};`);
  const worker=await IsolatedPluginWorker.start({installation:{...installation,enabled:true},serverBundle,serviceEntry,format:"package",mode:"active",hostCall:()=>undefined});workers.push(worker);
  expect(await worker.invoke("typed","hello",7)).toEqual({size:5});
  expect(await worker.invoke("numeric",12,7)).toBe("12");
  await expect(worker.invoke("typed",99,7)).rejects.toThrow();
  expect(await worker.invoke("counts",{},7)).toEqual({inputs:1,outputs:1});
 },10000);
 it("loads installed npm modules and Wasm assets from CJS and ESM service origins",async()=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),"desktop-plugin-resources-")));roots.push(root);
  const dist=path.join(root,"dist");const codec=path.join(root,"node_modules/asset-codec");
  await mkdir(dist);await mkdir(codec,{recursive:true});
  await writeFile(path.join(codec,"package.json"),JSON.stringify({name:"asset-codec",version:"1.0.0",main:"index.cjs"}));
  await writeFile(path.join(codec,"codec.wasm"),Buffer.from([0,97,115,109,1,0,0,0]));
  await writeFile(path.join(codec,"index.cjs"),`const fs=require('node:fs');module.exports={tag:'asset-loader-marker',directory:__dirname,instantiate:async()=>{const {instance}=await WebAssembly.instantiate(fs.readFileSync(require.resolve('./codec.wasm')));return Object.keys(instance.exports);}};`);
  const body=`const exports=await codec.instantiate();ctx.handle(defineRpc({name:'resources',input:z.object({}),output:z.object({exports:z.array(z.string()),directory:z.string(),filename:z.string(),codecDirectory:z.string(),resource:z.string(),tag:z.string()})}),()=>({exports,directory:serviceDir,filename:servicePath,codecDirectory:codec.directory,resource,tag:codec.tag}));`;
  const sources=[
   {file:"service.cjs",source:`const {defineRpc}=require('@omp-desktop/plugin/server');const {z}=require('zod');const servicePath=__filename;const serviceDir=__dirname;const codec=require('asset-codec');const resource=require.resolve('asset-codec/codec.wasm');module.exports.default=async ctx=>{${body}};`},
   {file:"direct.cjs",source:`const {defineRpc}=require('@omp-desktop/plugin/server');const {z}=require('zod');const servicePath=__filename;const serviceDir=__dirname;const codec=require('asset-codec');const resource=require.resolve('asset-codec/codec.wasm');module.exports=async ctx=>{${body}};`},
   {file:"service.mjs",source:`import {defineRpc} from '@omp-desktop/plugin/server';import {z} from 'zod';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import path from 'node:path';const servicePath=fileURLToPath(import.meta.url);const serviceDir=path.dirname(servicePath);const installedRequire=createRequire(import.meta.url);const codec=installedRequire('asset-codec');const resource=installedRequire.resolve('asset-codec/codec.wasm');export default async ctx=>{${body}};`},
  ];
  for(const source of sources){
   const serviceEntry=path.join(dist,source.file);await writeFile(serviceEntry,source.source);
   const {serverBundle}=await compilePackageEntries({serviceEntry});
   expect(serverBundle).not.toContain("asset-loader-marker");
   const worker=await IsolatedPluginWorker.start({installation:{...installation,enabled:true},serviceEntry,serverBundle,format:"package",mode:"active",hostCall:()=>undefined});workers.push(worker);
   expect(await worker.invoke("resources",{},7)).toEqual({exports:[],directory:dist,filename:serviceEntry,codecDirectory:codec,resource:path.join(codec,"codec.wasm"),tag:"asset-loader-marker"});
   await worker.stop();
  }
 },15000);
});

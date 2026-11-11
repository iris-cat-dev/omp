import {mkdtemp,writeFile,mkdir,readFile,rm} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {afterEach,describe,expect,it} from "vitest";
import {inspectPluginPackage} from "./package.js";
import {compilePackageEntries} from "./compiler.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function makePackage(metadata:unknown){const root=await mkdtemp(path.join(tmpdir(),"desktop-plugin-static-"));roots.push(root);await mkdir(path.join(root,"dist"));await writeFile(path.join(root,"package.json"),JSON.stringify({name:"test-plugin",version:"1.2.3",ompDesktop:metadata}));await writeFile(path.join(root,"dist/service.mjs"),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(root,"executed"))},'bad');export default () => undefined;`);return root;}
const metadata={apiVersion:1,id:"test-plugin",owner:"daemon",entries:{service:"./dist/service.mjs"},capabilities:["storage.scoped"]};
describe("Desktop package static inspection",()=>{
 it("never evaluates code during inspection or compilation",async()=>{const root=await makePackage(metadata);const info=await inspectPluginPackage(root);expect(info.version).toBe("1.2.3");expect(info.metadata?.apiVersion).toBe(1);const bundles=await compilePackageEntries(info);expect(bundles.serverBundle).toContain("function(require, __filename, __dirname)");expect(bundles.clientBundle).toBe("");await expect(readFile(path.join(root,"executed"))).rejects.toMatchObject({code:"ENOENT"});});
 it("rejects unknown API versions and escaping entries",async()=>{await expect(inspectPluginPackage(await makePackage({...metadata,apiVersion:2}))).rejects.toThrow();await expect(inspectPluginPackage(await makePackage({...metadata,entries:{service:"../escape.mjs"}}))).rejects.toThrow(/relative JavaScript/);});
 it("keeps the historical manifest strictly id-only",async()=>{const root=await mkdtemp(path.join(tmpdir(),"desktop-plugin-legacy-"));roots.push(root);await writeFile(path.join(root,"paseo-plugin.json"),JSON.stringify({id:"old-plugin",enabled:true}));await writeFile(path.join(root,"index.ts"),"export default p=>()=>{};");await expect(inspectPluginPackage(root)).rejects.toThrow();await writeFile(path.join(root,"paseo-plugin.json"),JSON.stringify({id:"old-plugin"}));expect(await inspectPluginPackage(root)).toMatchObject({id:"old-plugin",format:"legacy",version:"legacy",metadata:null});});
 it("keeps client arrow defaults and distinct live export getters",async()=>{
  const root=await makePackage(metadata);const entry=path.join(root,"dist/client.mjs");
  await writeFile(entry,`export let value='before';export const setValue=next=>{value=next;};export default ()=>()=>{};`);
  const {clientBundle}=await compilePackageEntries({clientEntry:entry});
  const factory=globalThis.eval(clientBundle) as (require:(name:string)=>never)=>{default:()=>()=>void;value:string;setValue(next:string):void};
  const exports=factory(name=>{throw new Error(`Unexpected external module: ${name}`);});
  expect(typeof exports.default).toBe("function");expect(typeof exports.default()).toBe("function");
  expect(exports.value).toBe("before");exports.setValue("after");expect(exports.value).toBe("after");
 });
});

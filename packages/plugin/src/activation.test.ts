import {describe,expect,it} from "vitest";
import {createActivationScope} from "./activation.js";
import {createPluginPaseoApi} from "./paseo-api.js";
import type {PaseoApi} from "@omp-desktop/client";
const installation={id:"example",packageId:"example",owner:"daemon" as const,version:"1.0.0",generation:3,enabled:true,declaredCapabilities:["agents.events"],grantedCapabilities:["agents.events"]};
describe("plugin activation ownership",()=>{
 it("revokes callbacks before cleanup and releases every handle exactly once",async()=>{const scope=createActivationScope(3);const calls:string[]=[];const one=scope.own(()=>{calls.push("one");});scope.own(()=>{expect(scope.signal.aborted).toBe(true);calls.push("two");});await one();await scope.dispose();await scope.dispose();expect(calls).toEqual(["one","two"]);expect(()=>scope.assertCurrent()).toThrow(/generation/);expect(()=>scope.own(()=>undefined)).toThrow(/generation/);});
 it("continues cleanup after an owned failure",async()=>{const scope=createActivationScope(1);let released=false;scope.own(()=>{released=true;});scope.own(()=>{throw new Error("broken");});await expect(scope.dispose()).rejects.toThrow("cleanup failed");expect(released).toBe(true);});
 it("rejects cross-generation calls and undeclared agent controls",async()=>{const scope=createActivationScope(3);const api={hostId:"host",agents:{list:async()=>({entries:[]}),create:async()=>{throw new Error("must not execute");}}} as unknown as PaseoApi;const facade=createPluginPaseoApi(api,installation,scope,{mode:"active"});expect(()=>facade.agents.create({} as never)).toThrow(/agents.create/);await facade.agents.list();await scope.dispose();expect(()=>facade.agents.list()).toThrow(/generation/);});
 it("management mode never acquires an agent execution lease",()=>{const scope=createActivationScope(3);const api={agents:{list:()=>{throw new Error("executed");}}} as unknown as PaseoApi;const facade=createPluginPaseoApi(api,installation,scope,{mode:"manage"});expect(()=>facade.agents.list()).toThrow(/management mode/);});
});

import {defineRpc} from '@omp-desktop/plugin/server';
import {z} from 'zod';
const counter=defineRpc({name:'counter.increment',input:z.object({by:z.number().int().default(1)}),output:z.object({count:z.number().int()})});
function register(ctx){ctx.handle(counter,async({by})=>{const snapshot=await ctx.storage.get();const count=(snapshot.values.count??0)+by;await ctx.storage.patch({count},snapshot.revision);return {count};});}
export function manage(ctx){register(ctx);}
export default function setup(ctx){register(ctx);console.log('package-counter service started');const timer=setInterval(()=>console.log('package-counter heartbeat'),60000);return()=>{clearInterval(timer);console.log('package-counter service stopped');};}

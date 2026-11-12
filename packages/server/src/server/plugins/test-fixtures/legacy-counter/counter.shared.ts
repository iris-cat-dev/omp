import {defineRpc} from "@omp-desktop/plugin/server";
import {z} from "zod";
export const count=defineRpc({name:"counter.increment",input:z.object({by:z.number().int().default(1)}),output:z.object({count:z.number().int()})});
export const search=defineRpc({name:"counter.search",input:z.object({query:z.string()}),output:z.object({items:z.array(z.object({id:z.string(),identifier:z.string(),title:z.string(),url:z.string(),text:z.string(),resourceType:z.string()}))})});

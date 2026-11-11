import { z } from 'zod';
import { defineRpc } from '@omp-desktop/plugin';
import { ConfigSchema, AccessSchema, PeerSchema, OpenId } from './state.ts';
const Purpose = z.enum(['owner', 'allow-c2c', 'allow-group']);
export const StatusSchema = z.object({ generation: z.number(), connection: z.enum(['waiting', 'connecting', 'ready', 'failed']), reason: z.string().nullable(), appId: z.string(), secretConfigured: z.boolean(), binding: z.object({ phase: z.enum(['idle', 'starting', 'waiting', 'saving', 'failed']), url: z.string().optional(), qrSvg: z.string().optional(), reason: z.string().optional(), issuedAt: z.number().optional() }), config: ConfigSchema, access: AccessSchema, peers: z.array(PeerSchema), challenges: z.array(z.object({ code: z.string(), purpose: Purpose, expiresAt: z.number(), createdAt: z.number(), claims: z.array(z.unknown()) })), importReport: z.array(z.string()) });
export const status = defineRpc({ name: 'qqbot.status', input: z.object({}), output: StatusSchema });
export const exportAccess = defineRpc({name:'qqbot.export-access',input:z.object({purpose:Purpose,accessRevision:z.number().int()}),output:z.object({appId:z.string(),revision:z.number().int(),text:z.string()})});
export const action = defineRpc({ name: 'qqbot.action', input: z.discriminatedUnion('kind', [
 z.object({ kind: z.literal('bind') }), z.object({ kind: z.literal('refresh') }), z.object({ kind: z.literal('unbind'), accessRevision: z.number() }),
 z.object({ kind: z.literal('replace'), appId: z.string().min(1), credentialKey: z.string().regex(/^credential-draft:[0-9a-f-]+$/).optional(), accessRevision: z.number() }),
 z.object({ kind: z.literal('configure'), config: ConfigSchema, accessRevision: z.number() }),
 z.object({ kind: z.literal('access'), access: AccessSchema, accessRevision: z.number() }),
 z.object({ kind: z.literal('pair'), purpose: Purpose, accessRevision:z.number().int() }), z.object({ kind: z.literal('end-pair'), code: z.string() }),
 z.object({ kind: z.literal('manual'), purpose: Purpose, text: z.string(), accessRevision: z.number() }),
 z.object({ kind: z.literal('revoke'), purpose: Purpose, openid: OpenId, accessRevision: z.number() }),
 z.object({ kind: z.literal('rename'), purpose: Purpose, openid: OpenId, nickname: z.string(), accessRevision: z.number() }),
 z.object({ kind: z.literal('restart') }),
 z.object({ kind: z.literal('import'), source: z.literal('dsh-qqbot'), document: z.string().max(1048576), accessRevision: z.number(), credentialKey:z.string().regex(/^credential-draft:[0-9a-f-]+$/).optional() }),
]), output: StatusSchema });
export const sendFile = defineRpc({ name: 'qqbot.send-file', input: z.object({ agentId: z.string(), path: z.string().min(1), type: z.enum(['image', 'video', 'voice', 'file']).default('file'), target: z.object({ scope: z.enum(['c2c','group']), openid: OpenId }).optional() }), output: z.object({ sent: z.literal(true) }) });

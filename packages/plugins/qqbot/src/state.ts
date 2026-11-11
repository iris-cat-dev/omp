import { z } from 'zod';
import type { PluginStorage, PluginStorageSnapshot } from '@omp-desktop/plugin';
import { normalizePairCode, parseWhitelistEntries, type PairPurpose, type ManualPairResult } from './shared/pairing-protocol.ts';

export const OpenId = z.string().trim().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/);
export const Scope = z.enum(['c2c', 'group']);
export const AccessMode = z.enum(['open', 'allowlist', 'disabled']);
export const AgentPresetSchema = z.object({
  name: z.string().trim().min(1).max(80),
  config: z.object({ provider: z.string().min(1), modeId: z.string().optional(), thinkingOptionId: z.string().optional(), featureValues: z.record(z.string(), z.unknown()).optional(), options: z.record(z.string(), z.json()).optional(), systemPrompt: z.string().optional(), toolPolicy: z.object({ preapproved: z.array(z.object({ kind: z.literal('mcp'), server: z.string().min(1), tool: z.string().min(1) }).strict()) }).strict().optional(), mcpServers: z.record(z.string(), z.discriminatedUnion('type', [z.object({ type: z.literal('stdio'), command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), alwaysLoad: z.boolean().optional() }).strict(), z.object({ type: z.literal('http'), url: z.string().url(), headers: z.record(z.string(), z.string()).optional(), alwaysLoad: z.boolean().optional() }).strict(), z.object({ type: z.literal('sse'), url: z.string().url(), headers: z.record(z.string(), z.string()).optional(), alwaysLoad: z.boolean().optional() }).strict()])).optional() }).strict(),
  qq: z.object({ prompt: z.string().default(''), skills: z.array(z.string()).default([]), tools: z.array(z.enum(['qqbot_send_file'])).default([]) }).strict().default({ prompt: '', skills: [], tools: [] }),
}).strict();
export const ConfigSchema = z.object({
  appId: z.string().default(''), cwd: z.string().default(''), defaultPreset: z.string().default('default'),
  presets: z.array(AgentPresetSchema).default([{ name: 'default', config: { provider: 'omp' }, qq: { prompt: '', skills: [], tools: [] } }]),
  requireMention: z.boolean().default(true), groupPrompt: z.string().default(''), directPrompt: z.string().default(''),
  textChunkLimit: z.number().int().min(200).max(4500).default(4500), streaming: z.boolean().default(true),
  maxQueue: z.number().int().min(1).max(100).default(20), processingTimeoutMs: z.number().int().min(1000).max(3600000).default(1800000),
  askTimeoutMs: z.number().int().min(1000).max(3600000).default(300000), historyLimit: z.number().int().min(0).max(100).default(10),
  externalTurns: z.enum(['off', 'c2c', 'all']).default('c2c'), serviceTurns: z.boolean().default(true),
  showToolResults: z.boolean().default(false),
  vision: z.object({ enabled: z.boolean().default(true), maxBytes: z.number().int().min(1).max(20971520).default(10485760) }).strict().default({enabled:true,maxBytes:10485760}),
  media: z.object({ enabled: z.boolean().default(true), maxMB: z.number().min(1).max(200).default(200), ttlHours: z.number().min(0).max(720).default(24) }).default({ enabled: true, maxMB: 200, ttlHours: 24 }),
  sendFile: z.object({ extraRoots: z.array(z.string()).default([]), maxFiles: z.number().int().min(1).max(20).default(4), sendPresentedFiles: z.boolean().default(true) }).default({ extraRoots: [], maxFiles: 4, sendPresentedFiles: true }),
}).strict().superRefine((c, ctx) => { const names = c.presets.map(p => p.name); if (new Set(names).size !== names.length || !names.includes(c.defaultPreset)) ctx.addIssue({ code: 'custom', message: 'Preset 名称必须唯一且默认 preset 必须存在' }); });
export const MemberSchema = z.object({ openid: OpenId, nickname: z.string().default(''), scene: Scope, sceneName: z.string().default(''), claimedAt: z.number() });
export const AccessSchema = z.object({ revision: z.number().int().default(0), c2cMode: AccessMode.default('open'), groupMode: AccessMode.default('open'), commandMode: AccessMode.default('open'), owners: z.array(MemberSchema).default([]), allowC2c: z.array(MemberSchema).default([]), allowGroup: z.array(MemberSchema).default([]) }).strict();
export const PeerSchema = z.object({ appId: z.string(), scope: Scope, openid: OpenId, hostId: z.string(), workspaceId: z.string(), agentId: z.string(), cwd: z.string(), preset: z.string(), template: AgentPresetSchema, protocolPrompt: z.string(), lastDeliveredSequence: z.number().default(0) });
export const StateSchema = z.object({ schemaVersion: z.literal(1).default(1), config: ConfigSchema.default(() => ConfigSchema.parse({})), credentialVersions:z.record(z.string(),z.number().int().nonnegative()).default({}), access: AccessSchema.default(() => AccessSchema.parse({})), accountAccess: z.record(z.string(), AccessSchema).default({}), peers: z.record(z.string(), PeerSchema).default({}), presetSelections: z.record(z.string(), z.string()).default({}), modelSelections: z.record(z.string(), z.string().nullable()).default({}), importReport: z.array(z.string()).default([]) });
export type Config = z.infer<typeof ConfigSchema>;
export type State = z.infer<typeof StateSchema>;
export type Peer = z.infer<typeof PeerSchema>;
export type Member = z.infer<typeof MemberSchema>;
export const peerKey = (appId: string, scope: 'c2c' | 'group', openid: string) => JSON.stringify([appId, scope, openid]);
export const listKey = (purpose: PairPurpose) => ({ owner: 'owners', 'allow-c2c': 'allowC2c', 'allow-group': 'allowGroup' } as const)[purpose];
export function permitted(mode: z.infer<typeof AccessMode>, list: Member[], openid: string): boolean { return mode === 'open' || (mode === 'allowlist' && list.some(m => m.openid === openid)); }
export function switchAccount(state: State, appId: string) {
  const previous = state.config.appId;
  if (previous === appId) return;
  const revision = state.access.revision + 1;
  if (previous) state.accountAccess[previous] = state.access;
  state.access = appId && state.accountAccess[appId] ? { ...state.accountAccess[appId]!, revision } : AccessSchema.parse({ revision });
  state.config.appId = appId;
}
export class StateStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private storage: PluginStorage) {}
  async read(): Promise<PluginStorageSnapshot<State>> { const s = await this.storage.get(); return { revision: s.revision, values: StateSchema.parse(s.values) }; }
  mutate<T>(fn: (state: State, revision:number) => T | Promise<T>, expectedAccessRevision?: number): Promise<T> {
    const result = this.chain.then(async () => { const snapshot = await this.read(); const state = snapshot.values; if (expectedAccessRevision !== undefined && state.access.revision !== expectedAccessRevision) throw new Error('ACCESS_REVISION_CONFLICT'); const value = await fn(state,snapshot.revision); await this.storage.patch(StateSchema.parse(state), snapshot.revision); return value; });
    this.chain = result.catch(() => undefined); return result;
  }
}
export class Pairing {
  readonly challenges = new Map<string, { appId:string; code: string; purpose: PairPurpose; expiresAt: number; createdAt: number; claims: Array<Member & { state: 'added' | 'existing' | 'revoked' }> }>();
  constructor(private store: StateStore) {}
  async issue(purpose: PairPurpose) { const appId=(await this.store.read()).values.config.appId;if(!appId)throw new Error('请先绑定 QQ 机器人账号');const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; let code: string; do { const bytes = crypto.getRandomValues(new Uint8Array(6)); code = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join(''); } while (this.challenges.has(code)); const challenge = { appId, code, purpose, createdAt: Date.now(), expiresAt: Date.now() + 300000, claims: [] as Array<Member & { state: 'added' | 'existing' | 'revoked' }> }; this.challenges.set(code, challenge); return challenge; }
  active(raw: string) { const challenge = this.challenges.get(normalizePairCode(raw)); if (challenge && challenge.expiresAt > Date.now()) return challenge; this.challenges.delete(normalizePairCode(raw)); return undefined; }
  async claim(raw: string, scope: 'c2c' | 'group', peer: string, sender: string, nickname: string) { const challenge = this.active(raw); if (!challenge) return false; if (challenge.purpose === 'allow-group' && scope !== 'group') throw new Error('请在目标群内发送配对码'); const openid = challenge.purpose === 'allow-group' ? peer : sender; const member = MemberSchema.parse({ openid, nickname, scene: scope, sceneName: '', claimedAt: Date.now() }); const result = await this.store.mutate(s => { if(this.active(raw)!==challenge||s.config.appId!==challenge.appId)throw new Error('配对码已失效或机器人账号已替换');const list = s.access[listKey(challenge.purpose)]; const existing = list.find(m => m.openid === openid); if (!existing) { list.push(member); s.access.revision++; } return { ...(existing ?? member), state: existing ? 'existing' as const : 'added' as const }; }); if (!challenge.claims.some(c => c.openid === openid)) challenge.claims.push(result); return true; }
  async manual(purpose: PairPurpose, text: string, revision: number) { const entries = parseWhitelistEntries(text); const errors = entries.filter((e): e is ManualPairResult['errors'][number] => 'message' in e); if (errors.length) throw new Error(errors.map(e => e.message).join('\n')); return this.store.mutate(s => { for (const e of entries) { if (!('openid' in e)) continue; const list = s.access[listKey(purpose)]; const old = list.find(m => m.openid === e.openid); if (old) old.nickname = e.nickname; else list.push({ openid: e.openid, nickname: e.nickname, scene: purpose === 'allow-group' ? 'group' : 'c2c', sceneName: '', claimedAt: Date.now() }); } s.access.revision++; }, revision); }
  clear() { this.challenges.clear(); }
}

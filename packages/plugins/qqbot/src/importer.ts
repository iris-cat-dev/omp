import { parseDocument } from 'yaml';
import { z } from 'zod';
import { AccessSchema, ConfigSchema, MemberSchema, AgentPresetSchema, OpenId, peerKey, type State } from './state.ts';
const Legacy = z.object({ appId:z.string().optional(),appSecret:z.string().optional(),provider:z.string().optional(),model:z.string().optional(),preset:z.string().optional(),cwd:z.string().optional(),access:z.object({c2cMode:z.enum(['open','allowlist','disabled']).optional(),groupMode:z.enum(['open','allowlist','disabled']).optional(),commandMode:z.enum(['open','allowlist','disabled']).optional(),c2cAllow:z.array(OpenId).optional(),groupAllow:z.array(OpenId).optional()}).optional() }).passthrough();
const Members = z.object({version:z.literal(1),appId:z.string(),owners:z.array(OpenId),profiles:z.record(z.string(),z.object({nickname:z.string(),scene:z.enum(['c2c','group']),sceneName:z.string(),claimedAt:z.number().int().nonnegative()}))}).strict();
const Preferences = z.object({overrides:z.record(z.string(),z.object({provider:z.string(),model:z.string()})).default({}),presets:z.record(z.string(),z.string()).default({}),sessionIds:z.record(z.string(),z.string()).default({})}).strict();
const transferable = ['appId','sandboxPath','requireMention','groupPrompt','directPrompt','textChunkLimit','streaming','maxQueue','processingTimeoutMs','askTimeoutMs','historyLimit','media','showToolResults'] as const;

export function importDsh(document:string,state:State){
  const doc=parseDocument(document,{uniqueKeys:true});
  if(doc.errors.length||doc.warnings.length)throw new Error('DSH YAML 包含错误或无法转换的标签；旧数据保持原样');
  const value:unknown=doc.toJS({maxAliasCount:100});
  const object=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
  if(object&&('entries' in object||'events' in object||'format' in object))throw new Error('会话／事件目录不能作为 OMP 历史或 peer agent 映射导入');
  const memberInput=object?.members!==undefined?object.members:(object?.version===1&&object.profiles!==undefined?object:undefined);
  const preferencesInput=object?.preferences!==undefined?object.preferences:(object&&'overrides' in object&&'presets' in object&&'sessionIds' in object?object:undefined);
  if(preferencesInput===object&&!state.config.appId)throw new Error('请先选择 AppID，再导入其独立 model-prefs.json 偏好文件');
  const entries=Array.isArray(value)?value:[];
  const entry=entries.length?entries.find(e=>e&&typeof e==='object'&&e.id==='im-qqbot')?.config:object?.config!==undefined?object.config:(memberInput===object?{appId:object?.appId}:preferencesInput===object?{appId:state.config.appId}:object);
  if(!entry)throw new Error('没有找到明确选择的 im-qqbot 配置或成员档案');
  const old=Legacy.parse(entry);
  const report=['已选择的 DSH 原文件、模型凭据与历史保持原样。历史和 sessionIds 不转换为 OMP 会话。'];
  const config:Record<string,unknown>={...state.config};
  for(const field of transferable)if(old[field]!==undefined)config[field]=old[field];
  if(old.cwd!==undefined&&old.sandboxPath===undefined)config.sandboxPath=old.cwd;
  const members=memberInput!==undefined?Members.parse(memberInput):undefined;
  if(members&&members.appId!==(config.appId as string))throw new Error('成员档案的 AppID 与所选账号不一致');
  if(object?.desktopPresets!==undefined){const templates=z.array(AgentPresetSchema).parse(object.desktopPresets);config.presets=templates;config.defaultPreset=old.preset&&templates.some(p=>p.name===old.preset)?old.preset:templates[0]?.name??state.config.defaultPreset;}
  else if(old.preset)report.push(`DSH preset「${old.preset}」未导入：请在 desktopPresets 中明确提供等价的 Desktop 配置，Cordis 挂载不自动转换。`);
  if(old.provider||old.model)report.push('DSH 模型 adapter 不自动转换；请在具名 Desktop preset 中选择已安装 provider/model。');
  if(old.vision&&typeof old.vision==='object'){const vision=old.vision as Record<string,unknown>;config.vision={enabled:vision.enabled??state.config.vision.enabled,maxBytes:vision.maxBytes??state.config.vision.maxBytes};for(const field of Object.keys(vision))if(!['enabled','maxBytes'].includes(field))report.push(`vision.${field} 未导入：视觉输入使用当前 Desktop agent 的原生模型，没有独立 DSH 模型运行时。`);}
  if(old.sendFile&&typeof old.sendFile==='object'){const files=old.sendFile as Record<string,unknown>;config.sendFile={extraRoots:files.extraRoots??state.config.sendFile.extraRoots,maxFiles:files.maxFiles??state.config.sendFile.maxFiles,sendPresentedFiles:files.sendPresentedFiles??state.config.sendFile.sendPresentedFiles};if(files.restrictPaths===false||(Array.isArray(files.extraRoots)&&files.extraRoots.length))report.push('文件投递仅允许 QQ 沙箱内文件；旧 restrictPaths:false 与 extraRoots 不扩大边界。');}
  if(old.proactiveDelivery&&typeof old.proactiveDelivery==='object')config.externalTurns=(old.proactiveDelivery as Record<string,unknown>).externalTurns??state.config.externalTurns;
  for(const e of entries)if(e?.id!=='im-qqbot')report.push(`Cordis 挂载「${String(e?.id??e?.name??'未命名')}」未导入：没有明确的等价原生实现。`);
  for(const field of Object.keys(old))if(![...transferable,'cwd','appSecret','provider','model','preset','access','vision','sendFile','proactiveDelivery','members','preferences','desktopPresets'].some(name=>name===field))report.push(`DSH 设置「${field}」未导入：没有等价的 Desktop 字段。`);
  const parsedConfig=ConfigSchema.parse(config);
  const previous=parsedConfig.appId===state.config.appId?state.access:state.accountAccess[parsedConfig.appId]??AccessSchema.parse({});
  const profile=(openid:string,scene:'c2c'|'group')=>MemberSchema.parse({openid,scene,claimedAt:Date.now(),...(members?.profiles[openid]??{})});
  const access=AccessSchema.parse({...previous,c2cMode:old.access?.c2cMode??previous.c2cMode,groupMode:old.access?.groupMode??previous.groupMode,commandMode:old.access?.commandMode??previous.commandMode,owners:members?.owners.map(id=>profile(id,'c2c'))??previous.owners,allowC2c:old.access?.c2cAllow?.map(id=>profile(id,'c2c'))??previous.allowC2c,allowGroup:old.access?.groupAllow?.map(id=>profile(id,'group'))??previous.allowGroup});
  const presetSelections={...state.presetSelections};const modelSelections={...state.modelSelections};
  if(preferencesInput!==undefined){const preferences=Preferences.parse(preferencesInput);const key=(legacy:string)=>{for(const scope of ['c2c','group'] as const){const prefix=`qqbot:${parsedConfig.appId}:${scope}:`;if(legacy.startsWith(prefix))return peerKey(parsedConfig.appId,scope,OpenId.parse(legacy.slice(prefix.length)));}return null;};
    for(const [legacy,preset] of Object.entries(preferences.presets)){const converted=key(legacy);if(!converted){report.push('其他 AppID 的 preset 偏好保持在旧来源，未导入。');continue;}if(parsedConfig.presets.some(p=>p.name===preset))presetSelections[converted]=preset;else report.push(`peer preset「${preset}」没有等价 Desktop 模板，未导入。`);}
    for(const [legacy,route] of Object.entries(preferences.overrides)){const converted=key(legacy);if(!converted){report.push('其他 AppID 的模型偏好保持在旧来源，未导入。');continue;}const preset=parsedConfig.presets.find(p=>p.name===(presetSelections[converted]??parsedConfig.defaultPreset))!;if(route.provider===preset.config.provider.split('/')[0])modelSelections[converted]=route.model;else report.push(`模型 adapter「${route.provider}」与 Desktop preset 不兼容，该 peer 模型偏好未导入。`);}
    if(Object.keys(preferences.sessionIds).length)report.push('旧 DSH sessionIds 已明确保留在来源；Desktop peer 映射将在真实 agent 创建后单独持久化。');
  }
  const secret=old.appSecret&&old.appSecret!=='__FROM_ENV__'&&!old.appSecret.startsWith('process.env')?old.appSecret:undefined;
  if(old.appSecret&&!secret)report.push('环境表达式不是凭据，未导入；请使用专用 secret 提交。');
  return{config:parsedConfig,access,report,secret,presetSelections,modelSelections};
}

export function prepareDshImport(document:string){
  if(document.length>1048576)throw new Error('所选导入文档超过 1 MiB');
  const doc=parseDocument(document,{uniqueKeys:true});if(doc.errors.length||doc.warnings.length)throw new Error('DSH YAML 包含错误或无法转换的标签');
  const value=doc.toJS({maxAliasCount:100});
  const object=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
  if(object&&('entries' in object||'events' in object||'format' in object))throw new Error('会话／事件目录不能作为 OMP 历史导入');
  const selected=Array.isArray(value)?value.find(entry=>entry?.id==='im-qqbot')?.config:object?.config!==undefined?object.config:object;
  if(!selected||typeof selected!=='object'||Array.isArray(selected))throw new Error('没有找到 im-qqbot 配置');
  const config={...selected};const appId=typeof config.appId==='string'?config.appId:undefined;
  const secret=typeof config.appSecret==='string'&&config.appSecret!=='__FROM_ENV__'&&!config.appSecret.startsWith('process.env')?config.appSecret:undefined;
  delete config.appSecret;
  // Other Cordis mounts are migration diagnostics, not credentials or code to
  // execute. Preserve their names while keeping their unrelated config local.
  let payload:unknown;
  if(Array.isArray(value))payload=value.map(entry=>entry?.id==='im-qqbot'?{id:'im-qqbot',config}:{id:String(entry?.id??entry?.name??'未命名'),config:{}});
  else if(object&&'overrides' in object&&'presets' in object&&'sessionIds' in object)payload={config:{},preferences:object};
  else if(object?.config)payload={config,...(object.members!==undefined?{members:object.members}:{}),...(object.preferences!==undefined?{preferences:object.preferences}:{}),...(object.desktopPresets!==undefined?{desktopPresets:object.desktopPresets}:{})};
  else payload=config;
  return{document:JSON.stringify(payload),appId,secret};
}

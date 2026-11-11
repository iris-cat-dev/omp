import { afterEach, expect, it, vi } from 'vitest';
import type { Peer } from './state.ts';
import type { AgentPermissionRequest } from '@omp-desktop/protocol/agent-types';
import { Cards, parseAnswer, type Question } from './cards.ts';
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { ReplyTarget } from './types.ts';
const peer=(agentId='real-desktop-agent',openid='peer'):Peer=>({appId:'bot',scope:'c2c',openid,hostId:'host',workspaceId:'workspace',agentId,cwd:'/workspace',preset:'default',template:{name:'default',config:{provider:'omp'},qq:{prompt:'',skills:[],tools:[]}},protocolPrompt:'QQ context',lastDeliveredSequence:0});
const fixtures:Cards[]=[];
afterEach(()=>{for(const cards of fixtures.splice(0))cards.dispose();vi.useRealTimers();});
function fixture(authorized=true,requireMention=true){const controller=new AbortController();const sendMarkdown=vi.fn(async(_target:ReplyTarget,_text:string,_options?:{keyboard?:InlineKeyboard})=>undefined);const respond=vi.fn(async()=>undefined);const cards=new Cards(7,controller.signal,{sendMarkdown,openStream:vi.fn()},respond,async()=>authorized,1000,vi.fn(),requireMention);fixtures.push(cards);return{cards,respond,sendMarkdown,controller,button:()=>sendMarkdown.mock.calls.at(-1)?.[2]?.keyboard?.content.rows[0]?.buttons[0]?.action.data??''};}
const approval:AgentPermissionRequest={id:'same-native-request-id',provider:'omp',name:'bash',kind:'tool',description:'Run the inspected command'};
it('nonce, agent, scope, generation and clicker authorize approval exactly once',async()=>{const f=fixture();await f.cards.show(peer(),{scope:'c2c',targetId:'peer'},approval);const data=f.button();expect(await f.cards.interaction('c2c','wrong-peer','sender',data)).toBe(false);expect(await f.cards.interaction('c2c','peer','',data)).toBe(false);expect(await f.cards.interaction('c2c','peer','sender',JSON.stringify({...JSON.parse(data),g:6}))).toBe(false);expect(await f.cards.interaction('c2c','peer','sender',JSON.stringify({...JSON.parse(data),n:'old-card'}))).toBe(false);expect(await f.cards.interaction('c2c','peer','sender','null')).toBe(false);expect(await f.cards.interaction('c2c','peer','sender',data)).toBe(true);expect(await f.cards.interaction('c2c','peer','sender',data)).toBe(false);expect(f.respond).toHaveBeenCalledTimes(1);expect(f.respond).toHaveBeenCalledWith('real-desktop-agent',approval.id,expect.objectContaining({behavior:'allow'}));});
it('identical native request IDs on different agents do not overwrite each other',async()=>{const f=fixture();await f.cards.show(peer('agent-one','one'),{scope:'c2c',targetId:'one'},approval);const first=f.button();await f.cards.show(peer('agent-two','two'),{scope:'c2c',targetId:'two'},approval);const second=f.button();expect(await f.cards.interaction('c2c','one','sender',first)).toBe(true);expect(await f.cards.interaction('c2c','two','sender',second)).toBe(true);expect(f.respond).toHaveBeenCalledTimes(2);});
it('unauthorized clickers, disabled routes and expired cards never resolve native permission',async()=>{vi.useFakeTimers();const denied=fixture(false);await denied.cards.show(peer(),{scope:'c2c',targetId:'peer'},approval);expect(await denied.cards.interaction('c2c','peer','outsider',denied.button())).toBe(false);const f=fixture();await f.cards.show(peer(),{scope:'c2c',targetId:'peer'},approval);const data=f.button();f.controller.abort();f.cards.dispose();await vi.advanceTimersByTimeAsync(2000);expect(await f.cards.interaction('c2c','peer','sender',data)).toBe(false);expect(f.respond).not.toHaveBeenCalled();const expired=fixture();await expired.cards.show(peer(),{scope:'c2c',targetId:'peer'},approval);const old=expired.button();await vi.advanceTimersByTimeAsync(1001);expect(await expired.cards.interaction('c2c','peer','sender',old)).toBe(false);expect(expired.respond).not.toHaveBeenCalled();});
it('grouped ask preserves IDs/order and supports selected options with custom multianswers',async()=>{const f=fixture();const request:AgentPermissionRequest={id:'ask-grouped',provider:'omp',name:'ask',kind:'question',input:{questions:[{id:'deployment',header:'Shared header',question:'Where?',options:[{label:'Staging'},{label:'Production'}],multiSelect:false,allowOther:true},{id:'features',header:'Shared header',question:'Which?',options:[{label:'Logs'},{label:'Metrics'},{label:'Tracing'}],multiSelect:true,allowOther:true}]}};await f.cards.show(peer(),{scope:'c2c',targetId:'peer'},request);expect(await f.cards.text(peer(),'sender','1')).toBe(true);expect(f.respond).not.toHaveBeenCalled();expect(await f.cards.text(peer(),'sender','1,3；其他: custom observability')).toBe(true);expect(f.respond).toHaveBeenCalledWith('real-desktop-agent','ask-grouped',{behavior:'allow',updatedInput:{answers:[{id:'deployment',selectedOptions:['Staging']},{id:'features',selectedOptions:['Logs','Tracing'],customInput:'custom observability'}]}});});
it('numeric freeform answers are not mistaken for nonexistent options',()=>{const question:Question={question:'How many?',options:[],multiSelect:false,allowOther:false,isOther:false,allowEmpty:false};expect(parseAnswer(question,'42')).toEqual({selectedOptions:[],customInput:'42'});});
it('question mention hint matches the actual scope and setting',async()=>{const request:AgentPermissionRequest={id:'ask',provider:'omp',name:'ask',kind:'question',input:{questions:[{question:'Choose',options:[{label:'Yes'}]}]}};const direct=fixture();await direct.cards.show(peer(),{scope:'c2c',targetId:'peer'},request);expect(direct.sendMarkdown.mock.calls[0]?.[1]).not.toContain('@机器人');const groupPeer={...peer(),scope:'group' as const};const mentioned=fixture();await mentioned.cards.show(groupPeer,{scope:'group',targetId:'peer'},request);expect(mentioned.sendMarkdown.mock.calls[0]?.[1]).toContain('@机器人');const open=fixture(true,false);await open.cards.show(groupPeer,{scope:'group',targetId:'peer'},request);expect(open.sendMarkdown.mock.calls[0]?.[1]).not.toContain('@机器人');});
it.each(['disable','resolved','cancel-agent','replace'] as const)('a pending click cannot resolve native permission after %s',async retirement=>{
  const authorization=Promise.withResolvers<boolean>();
  const controller=new AbortController();
  const sendMarkdown=vi.fn(async(_target:ReplyTarget,_text:string,_options?:{keyboard?:InlineKeyboard})=>undefined);
  const respond=vi.fn(async()=>undefined);
  const cards=new Cards(7,controller.signal,{sendMarkdown,openStream:vi.fn()},respond,()=>authorization.promise,1000,vi.fn(),true);
  fixtures.push(cards);
  await cards.show(peer(),{scope:'c2c',targetId:'peer'},approval);
  const data=sendMarkdown.mock.calls[0]?.[2]?.keyboard?.content.rows[0]?.buttons[0]?.action.data??'';
  const click=cards.interaction('c2c','peer','sender',data);
  expect(await cards.interaction('c2c','peer','sender',data)).toBe(false);
  if(retirement==='disable'){controller.abort();cards.dispose();}
  else if(retirement==='cancel-agent')cards.cancelAgent(peer().agentId);
  else{cards.resolved(peer().agentId,approval.id);if(retirement==='replace')await cards.show(peer(),{scope:'c2c',targetId:'peer'},approval);}
  authorization.resolve(true);
  expect(await click).toBe(false);
  expect(respond).not.toHaveBeenCalled();
  if(retirement==='replace')expect(await cards.interaction('c2c','peer','sender',data)).toBe(false);
});
it('approval returns the native selected action ID rather than synthesizing permission changes',async()=>{
  const f=fixture();
  await f.cards.show(peer(),{scope:'c2c',targetId:'peer'},{...approval,actions:[{id:'once-native-id',label:'Allow once',behavior:'allow'},{id:'deny-native-id',label:'Deny',behavior:'deny'}]});
  expect(await f.cards.interaction('c2c','peer','sender',f.button())).toBe(true);
  expect(f.respond).toHaveBeenCalledExactlyOnceWith(peer().agentId,approval.id,{behavior:'allow',selectedActionId:'once-native-id'});
});

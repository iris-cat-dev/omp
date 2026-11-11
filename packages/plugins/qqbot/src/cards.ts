import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { AgentPermissionRequest, AgentPermissionResponse } from '@omp-desktop/protocol/agent-types';
import type { Peer } from './state.ts';
import type { ReplyTarget } from './types.ts';
import type { QQBotSender } from './transport/outbound-buffer.ts';
const QuestionSchema = z.object({ id: z.string().optional(), header: z.string().optional(), question: z.string(), options: z.array(z.object({ label: z.string(), description: z.string().optional() })).default([]), multiSelect: z.boolean().default(false), allowOther: z.boolean().default(false), isOther: z.boolean().default(false), allowEmpty: z.boolean().default(false) }).transform(q=>({...q,allowOther:q.allowOther||q.isOther}));
export type Question = z.infer<typeof QuestionSchema>;
export interface Answer { id: string; selectedOptions: string[]; customInput?: string }
export function parseAnswer(question: Question, text: string): Omit<Answer, 'id'> {
  const raw=text.trim();if(!raw&&!question.allowEmpty)throw new Error('请回答当前问题');
  const combined=/^([\d\s,，、;；./]+)[;；]\s*(?:其他|other)[:：]\s*(.+)$/i.exec(raw);
  const selectedText=combined?.[1]?.trim()??raw;
  if(combined&&(!question.multiSelect||!question.allowOther))throw new Error('当前问题不允许多选与自定义答案组合');
  if(question.options.length&&/^[\d\s,，、;；./]+$/.test(selectedText)){
    const ids=[...new Set([...selectedText.matchAll(/\d+/g)].map(match=>Number(match[0])-1))];
    if(!ids.length||ids.some(i=>i<0||i>=question.options.length)||(!question.multiSelect&&ids.length>1))throw new Error('选项编号或多选数量无效');
    return{selectedOptions:ids.map(i=>question.options[i]!.label),...(combined?{customInput:combined[2]!.trim()}:{})};
  }
  const exact=question.options.find(o=>o.label.toLowerCase()===raw.toLowerCase());if(exact)return{selectedOptions:[exact.label]};
  if(!question.allowOther&&question.options.length)throw new Error('请选择列出的选项');
  return{selectedOptions:[],customInput:raw};
}
interface Card { request: AgentPermissionRequest; peer: Peer; target: ReplyTarget; nonce: string; expiresAt: number; questions: Question[] | null; index: number; answers: Answer[]; busy: boolean; timer: ReturnType<typeof setTimeout> }
const ButtonSchema = z.object({g:z.number().int(),a:z.string(),n:z.string(),r:z.string(),q:z.string().optional(),i:z.number().int().nonnegative().optional(),d:z.enum(['allow','deny']).optional()}).strict();
const cardKey=(agentId:string,requestId:string)=>JSON.stringify([agentId,requestId]);
export class Cards {
  private pending = new Map<string, Card>();
  constructor(private generation: number, private signal: AbortSignal, private sender: QQBotSender, private respond: (id: string, requestId: string, response: AgentPermissionResponse) => Promise<void>, private authorized: (peer: Peer, sender: string) => Promise<boolean>, private timeoutMs: number, private report: (error: unknown) => void, private requireMention: boolean) {}
  async show(peer: Peer, target: ReplyTarget, request: AgentPermissionRequest) {
    const key=cardKey(peer.agentId,request.id);
    if (this.signal.aborted || this.pending.has(key)) return;
    const parsed = request.kind === 'question' ? z.array(QuestionSchema).safeParse(request.input?.questions) : null;
    if (request.kind === 'question' && (!parsed?.success || parsed.data.length === 0)) throw new Error('宿主问题格式不受支持；请在 Desktop 中回答');
    const card: Card = { request, peer, target, nonce: randomUUID(), expiresAt: Date.now() + this.timeoutMs, questions: parsed?.success ? parsed.data : null, index: 0, answers: [], busy: false, timer: setTimeout(() => { this.pending.delete(key); if (!this.signal.aborted) void this.sender.sendMarkdown(target, '问答／审批卡片已过期，请在 Desktop 中继续处理。').catch(this.report); }, this.timeoutMs) };
    this.pending.set(key, card); await this.render(card);
  }
  resolved(agentId:string,requestId: string) { const key=cardKey(agentId,requestId);const card = this.pending.get(key); clearTimeout(card?.timer); this.pending.delete(key); }
  cancelAgent(agentId:string){for(const [key,card] of this.pending)if(card.peer.agentId===agentId){clearTimeout(card.timer);this.pending.delete(key);}}
  private valid(card: Card) { return !this.signal.aborted && card.expiresAt > Date.now() && this.pending.get(cardKey(card.peer.agentId,card.request.id)) === card; }
  private async render(card: Card) {
    if (!this.valid(card)) return;
    const q = card.questions?.[card.index];
    const data = (extra: object) => JSON.stringify({ g: this.generation, a: card.peer.agentId, n: card.nonce, r: card.request.id, ...extra });
    const buttons = q ? (q.multiSelect ? [] : q.options.map((o, i) => ({ label: o.label, data: data({ q: q.id ?? String(card.index), i }) }))) : [{ label: '允许一次', data: data({ d: 'allow' }) }, { label: '拒绝', data: data({ d: 'deny' }) }];
    const rows: InlineKeyboard['content']['rows'] = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push({ buttons: buttons.slice(i, i + 2).map((b, j) => ({ id: `${card.nonce}-${i+j}`, render_data: { label: b.label.slice(0,10), visited_label: '已选', style: 1 }, action: { type: 1, permission: { type: 2 }, click_limit: 1, data: b.data } })) });
    const text = q ? `**${q.header ?? '问题'} (${card.index+1}/${card.questions!.length})**\n${q.question}${q.multiSelect ? '（可多选）' : ''}\n${q.options.map((o,i) => `${i+1}. ${o.label}${o.description ? ` · ${o.description}` : ''}`).join('\n')}\n回复编号${q.multiSelect ? '（如 1,3）' : ''}${q.allowOther ? '或自定义答案' : ''}${q.multiSelect&&q.allowOther?'；组合示例：1,3；其他:补充答案':''}${card.peer.scope==='group'&&this.requireMention?'；群内回复需 @机器人。':'。'}` : `**${card.request.title ?? card.request.name}**\n${card.request.description ?? ''}\n\`\`\`\n${JSON.stringify(card.request.detail ?? card.request.input ?? {}, null, 2).slice(0,1200)}\n\`\`\``;
    await this.sender.sendMarkdown(card.target, text, rows.length ? { keyboard: { content: { rows } } } : undefined);
  }
  async text(peer: Peer, sender: string, text: string): Promise<boolean> {
    const card = [...this.pending.values()].find(c => c.peer.agentId === peer.agentId && c.questions);
    if (!card) return false;
    if (!this.valid(card) || card.busy) return true;
    card.busy=true;
    try { if (!sender || !await this.authorized(peer,sender) || !this.valid(card)) return true; await this.answer(card,parseAnswer(card.questions![card.index]!,text)); return true; }
    finally { card.busy=false; }
  }
  async interaction(scope: 'c2c' | 'group', openid: string, sender: string, raw: string): Promise<boolean> {
    let value: unknown; try { value=JSON.parse(raw); } catch { return false; }
    const parsed=ButtonSchema.safeParse(value); if(!parsed.success)return false; const data=parsed.data;
    const card=this.pending.get(cardKey(data.a,data.r));
    if(!card||!this.valid(card)||card.busy||data.g!==this.generation||data.n!==card.nonce||card.peer.scope!==scope||card.peer.openid!==openid||!sender)return false;
    card.busy=true;
    try {
      if(!await this.authorized(card.peer,sender)||!this.valid(card))return false;
      if(card.questions){const q=card.questions[card.index]!;if(data.q!==(q.id??String(card.index))||data.i===undefined||!q.options[data.i]||q.multiSelect)return false;await this.answer(card,{selectedOptions:[q.options[data.i]!.label]});}
      else {if(data.d===undefined)return false;const action=card.request.actions?.find(action=>action.behavior===data.d);await this.respond(card.peer.agentId,card.request.id,{behavior:data.d,selectedActionId:action?.id});this.resolved(card.peer.agentId,card.request.id);}
      return true;
    } finally {card.busy=false;}
  }
  private async answer(card: Card, answer: Omit<Answer,'id'>) {
    const q = card.questions![card.index]!; const answers = [...card.answers, { id: q.id ?? q.header ?? String(card.index), ...answer }];
    if (answers.length === card.questions!.length) {
      const structured = card.questions!.every(q => q.id !== undefined);
      const result = structured ? answers : Object.fromEntries(answers.map(a => [a.id,[...a.selectedOptions,...(a.customInput !== undefined ? [a.customInput] : [])].join(', ')]));
      await this.respond(card.peer.agentId,card.request.id,{ behavior: 'allow', updatedInput: { answers: result } }); this.resolved(card.peer.agentId,card.request.id);
    } else { card.answers = answers; card.index++; await this.render(card); }
  }
  dispose() { for (const card of this.pending.values()) clearTimeout(card.timer); this.pending.clear(); }
}

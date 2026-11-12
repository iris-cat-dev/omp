import type { ChatScope } from '../types.ts';
export interface CachedReplyId { kind: 'msg' | 'event'; id: string }
export class ReplyIdCache {
  private entries = new Map<string, Array<{ target: CachedReplyId; timestamp: number }>>();
  private push(scope: ChatScope, targetId: string | undefined, target: CachedReplyId) {
    if (!targetId || !target.id) return;
    const key = JSON.stringify([scope, targetId]); const list = this.entries.get(key) ?? [];
    this.entries.delete(key); list.push({ target, timestamp: Date.now() }); if (list.length > 10) list.shift(); this.entries.set(key, list);
    if (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
  }
  cacheMsgId(scope: ChatScope, target: string | undefined, id: string | undefined) { if (id) this.push(scope, target, { kind: 'msg', id }); }
  cacheEventId(scope: ChatScope, target: string | undefined, id: string | undefined) { if (id) this.push(scope, target, { kind: 'event', id: `INTERACTION_CREATE:${id}` }); }
  getCachedReplyIds(scope: ChatScope, target: string): CachedReplyId[] { const ttl = scope === 'group' ? 300000 : 1800000; return (this.entries.get(JSON.stringify([scope, target])) ?? []).filter(e => Date.now() - e.timestamp < ttl).reverse().map(e => e.target); }
  clear() { this.entries.clear(); }
}

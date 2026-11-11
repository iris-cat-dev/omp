export class PeerQueue {
  private queues = new Map<string, Array<{ run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }>>();
  private running = new Set<string>();
  private closed = false;
  constructor(private maxQueue: number) {}
  enqueue(key: string, run: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('QQ 网关已停止'));
    const queue = this.queues.get(key) ?? []; if (queue.length >= this.maxQueue) return Promise.reject(new Error('当前 QQ 对话队列已满，请稍后再试'));
    return new Promise((resolve,reject) => { queue.push({run,resolve,reject}); this.queues.set(key,queue); if (!this.running.has(key)) void this.drain(key); });
  }
  private async drain(key: string) { this.running.add(key); try { const queue = this.queues.get(key)!; while (!this.closed && queue.length) { const task = queue.shift()!; try { await task.run(); task.resolve(); } catch (error) { task.reject(error); } } } finally { this.running.delete(key); this.queues.delete(key); } }
  dispose() { this.closed = true; for (const queue of this.queues.values()) for (const task of queue.splice(0)) task.reject(new Error('QQ 路由已取消')); }
}

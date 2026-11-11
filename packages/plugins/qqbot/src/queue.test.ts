import { expect, it, vi } from 'vitest';
import { PeerQueue } from './queue.ts';
it('bounds and serializes each peer without blocking independent peers',async()=>{const queue=new PeerQueue(1);let release!:()=>void;const order:string[]=[];const first=queue.enqueue('peer-one',async()=>{order.push('one-start');await new Promise<void>(resolve=>{release=resolve;});order.push('one-end');});const second=queue.enqueue('peer-one',async()=>{order.push('two');});await expect(queue.enqueue('peer-one',async()=>{})).rejects.toThrow('队列已满');await queue.enqueue('peer-two',async()=>{order.push('independent');});expect(order).toEqual(['one-start','independent']);release();await Promise.all([first,second]);expect(order).toEqual(['one-start','independent','one-end','two']);queue.dispose();});
it('disable cancels queued routes without executing them or cancelling host-owned agents',async()=>{const queue=new PeerQueue(2);let release!:()=>void;const first=queue.enqueue('peer',()=>new Promise<void>(resolve=>{release=resolve;}));const next=vi.fn(async()=>{});const second=queue.enqueue('peer',next);const rejected=expect(second).rejects.toThrow('路由已取消');queue.dispose();await rejected;release();await first;expect(next).not.toHaveBeenCalled();await expect(queue.enqueue('peer',next)).rejects.toThrow('网关已停止');});
it('a rejected running turn preserves the next peer task and independent routes',async()=>{
  const queue=new PeerQueue(1);
  const failure=Promise.withResolvers<void>();
  const order:string[]=[];
  const first=queue.enqueue('peer',()=>failure.promise);
  const failed=expect(first).rejects.toThrow('original turn failure');
  const next=queue.enqueue('peer',async()=>{order.push('next');});
  await queue.enqueue('independent',async()=>{order.push('independent');});
  failure.reject(new Error('original turn failure'));
  await Promise.all([failed,next]);
  expect(order).toEqual(['independent','next']);
  await queue.enqueue('peer',async()=>{order.push('later');});
  expect(order).toEqual(['independent','next','later']);
  queue.dispose();
});

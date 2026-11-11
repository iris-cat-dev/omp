import { describe, it, expect } from 'vitest';
import { ReplyLimiter } from './reply-limiter.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ReplyLimiter', () => {
  it('allows passive replies up to the limit', () => {
    const limiter = new ReplyLimiter({ limit: 4 });

    for (let i = 0; i < 4; i += 1) {
      const result = limiter.checkLimit('m1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
      limiter.record('m1');
    }

    const exceeded = limiter.checkLimit('m1');
    expect(exceeded.allowed).toBe(false);
    expect(exceeded.fallbackReason).toBe('limit_exceeded');
  });

  it('tracks different messages independently', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    limiter.record('m1');
    limiter.record('m1');

    const other = limiter.checkLimit('m2');
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(4);
  });

  it('falls back to proactive when the message expires', async () => {
    const limiter = new ReplyLimiter({ limit: 4, ttlMs: 30 });
    limiter.record('m1');

    await sleep(50);

    const expired = limiter.checkLimit('m1');
    expect(expired.allowed).toBe(false);
    expect(expired.fallbackReason).toBe('expired');
  });
});

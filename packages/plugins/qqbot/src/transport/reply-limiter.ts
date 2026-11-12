/**
 * 被动回复限额管理。
 *
 * QQ Bot 被动回复有限额：同一条消息只能被动回复 N 次，超时后不能再被动回复。
 * 当限额耗尽或消息过期时，应降级为主动消息（proactive，不传 msgId）。
 */

export interface ReplyLimiterConfig {
  /** 每条消息最大被动回复次数（默认 4，留 1 次余量） */
  limit?: number;
  /** 消息 ID 过期时间 ms（默认 1 小时） */
  ttlMs?: number;
  /** 最大跟踪消息数（LRU 驱逐，默认 10000） */
  maxTrackedMessages?: number;
}

export interface ReplyLimitResult {
  allowed: boolean;
  remaining: number;
  fallbackReason?: 'expired' | 'limit_exceeded';
}

interface TrackedMessage {
  count: number;
  firstSeenAt: number;
}

export class ReplyLimiter {
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly maxTracked: number;
  private readonly messages = new Map<string, TrackedMessage>();

  public constructor(config?: ReplyLimiterConfig) {
    this.limit = config?.limit ?? 4;
    this.ttlMs = config?.ttlMs ?? 3600_000;
    this.maxTracked = config?.maxTrackedMessages ?? 10_000;
  }

  /** 检查是否允许对指定消息继续被动回复 */
  public checkLimit(messageId: string): ReplyLimitResult {
    const now = Date.now();
    const tracked = this.messages.get(messageId);

    if (!tracked) {
      return { allowed: true, remaining: this.limit };
    }

    if (now - tracked.firstSeenAt > this.ttlMs) {
      this.messages.delete(messageId);
      return { allowed: false, remaining: 0, fallbackReason: 'expired' };
    }

    const remaining = Math.max(0, this.limit - tracked.count);
    if (remaining <= 0) {
      return { allowed: false, remaining: 0, fallbackReason: 'limit_exceeded' };
    }

    return { allowed: true, remaining };
  }

  /** 记录一次被动回复 */
  public record(messageId: string): void {
    const now = Date.now();
    const tracked = this.messages.get(messageId);

    if (tracked) {
      tracked.count += 1;
      return;
    }

    if (this.messages.size >= this.maxTracked) {
      const firstKey = this.messages.keys().next().value;
      if (firstKey !== undefined) this.messages.delete(firstKey);
    }
    this.messages.set(messageId, { count: 1, firstSeenAt: now });
  }
}

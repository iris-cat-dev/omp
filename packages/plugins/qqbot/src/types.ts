export type ChatScope = 'c2c' | 'group';
export interface ReplyTarget { scope: ChatScope; targetId: string; msgId?: string; eventId?: string; forceProactive?: boolean }
export interface Logger { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void; error(message: string, ...args: unknown[]): void; debug(message: string, ...args: unknown[]): void }

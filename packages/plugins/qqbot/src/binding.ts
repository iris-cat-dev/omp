import { startQrConnect } from '@tencent-connect/qqbot-connector';
import QRCode from 'qrcode';
export interface Credentials { appId: string; appSecret: string; userOpenid?: string }
export type BindingState = { phase: 'idle' | 'starting' | 'waiting' | 'saving' | 'failed'; url?: string; qrSvg?: string; reason?: string; issuedAt?: number };
export class Binding {
  state: BindingState = { phase: 'idle' };
  private controller: AbortController | null = null;
  private stopConnect: (() => void) | null = null;
  private generation = 0;
  constructor(private signal: AbortSignal, private save: (credential: Credentials) => Promise<void>, private report: (error: unknown) => void) {}
  start() {
    this.dispose();
    if (this.signal.aborted) return;
    const generation = ++this.generation;
    const controller = new AbortController(); this.controller = controller;
    const current = () => generation === this.generation && !controller.signal.aborted && !this.signal.aborted;
    this.state = { phase: 'starting' };
    this.stopConnect = startQrConnect({
      onQrDisplayed: url => { if (!current()) return; this.state = { phase: 'waiting', url, issuedAt: Date.now() }; void QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M' }).then(svg => { if (current() && this.state.phase === 'waiting') this.state = { ...this.state, qrSvg: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` }; }, this.report); },
      onQrExpired: () => { if (current()) this.state = { phase: 'failed', reason: '二维码已过期，请刷新' }; },
      onFailure: error => { if (current()) this.state = { phase: 'failed', reason: error.message }; },
      onSuccess: credentials => { if (!current()) return; const credential = credentials[0]; if (!credential) { this.state = { phase: 'failed', reason: '未返回有效凭据' }; return; } this.state = { phase: 'saving' }; void this.save(credential).then(() => { if (current()) this.state = { phase: 'idle' }; }, error => { if (current()) this.state = { phase: 'failed', reason: error instanceof Error ? error.message : String(error) }; }); },
    }, { signal: AbortSignal.any([controller.signal, this.signal]), source: 'omp-desktop', displayQrCodeToConsole: false });
  }
  dispose() { ++this.generation; this.controller?.abort(); this.controller = null; this.stopConnect?.(); this.stopConnect = null; this.state = { phase: 'idle' }; }
}

const MAX_BUFFER_LENGTH = 2 * 1024 * 1024;
type EscapeState = "text" | "escape" | "csi" | "string" | "stringEscape";

interface MarkerWaiter {
  marker: string;
  endMarker: string;
  resolve: (suffix: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class MarkerBuffer {
  private buffer = "";
  private escapeState: EscapeState = "text";
  private readonly waiters = new Set<MarkerWaiter>();

  push(chunk: string): void {
    // ConPTY inserts cursor/erase sequences even into plain command output.
    // Keep parser state across chunks; a CSI or window title can be fragmented.
    let text = "";
    for (const character of chunk) {
      switch (this.escapeState) {
        case "text":
          if (character === "\x1b") this.escapeState = "escape";
          else if (character !== "\r") text += character;
          break;
        case "escape":
          if (character === "[") this.escapeState = "csi";
          else if ("]PX^_".includes(character)) this.escapeState = "string";
          else if (character.charCodeAt(0) >= 0x30) this.escapeState = "text";
          break;
        case "csi":
          if (character >= "@" && character <= "~") this.escapeState = "text";
          break;
        case "string":
          if (character === "\x07") this.escapeState = "text";
          else if (character === "\x1b") this.escapeState = "stringEscape";
          break;
        case "stringEscape":
          this.escapeState = character === "\\" ? "text" : "string";
          break;
      }
    }
    this.buffer += text;
    if (this.buffer.length > MAX_BUFFER_LENGTH) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_LENGTH);
    }
    this.flush();
  }

  waitForLine(marker: string, timeoutMs = 30_000): Promise<string> {
    return this.waitForBlock(marker, "\n", timeoutMs);
  }

  waitForBlock(marker: string, endMarker: string, timeoutMs = 30_000): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const waiter: MarkerWaiter = {
      marker,
      endMarker,
      resolve,
      reject,
      timeout: setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Timed out waiting for remote marker ${marker}`));
      }, timeoutMs),
    };
    this.waiters.add(waiter);
    this.flush();
    return promise;
  }

  rejectAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private flush(): void {
    for (const waiter of this.waiters) {
      const markerIndex = this.buffer.indexOf(waiter.marker);
      if (markerIndex < 0) continue;
      const end = this.buffer.indexOf(waiter.endMarker, markerIndex + waiter.marker.length);
      if (end < 0) continue;
      const suffix = this.buffer.slice(markerIndex + waiter.marker.length, end);
      this.buffer = this.buffer.slice(end + waiter.endMarker.length);
      clearTimeout(waiter.timeout);
      this.waiters.delete(waiter);
      waiter.resolve(suffix);
    }
  }
}

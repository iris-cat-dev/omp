import type { PluginCleanup } from "./contracts.js";

let activationSequence=0;
export interface PluginActivationScope {
  /** Unique inside the owner process; combine with document epoch for native leases. */
  readonly id:string;
  readonly generation: number;
  readonly signal: AbortSignal;
  assertCurrent(generation?: number): void;
  own(cleanup: PluginCleanup): PluginCleanup;
  dispose(reason?: string): Promise<void>;
}
export function createActivationScope(generation: number): PluginActivationScope {
  const controller = new AbortController();
  const cleanups = new Set<PluginCleanup>();
  let disposing: Promise<void> | undefined;
  const assertCurrent = (expected = generation) => {
    if (controller.signal.aborted || expected !== generation) throw new Error("Plugin generation is no longer active");
  };
  return {
    id:`activation-${++activationSequence}`,
    generation,
    signal: controller.signal,
    assertCurrent,
    own(cleanup) {
      assertCurrent();
      let pending = true;
      const release: PluginCleanup = async () => {
        if (!pending) return;
        pending = false;
        cleanups.delete(release);
        await cleanup();
      };
      cleanups.add(release);
      return release;
    },
    dispose(reason = "Plugin stopped") {
      if (disposing) return disposing;
      controller.abort(reason);
      disposing = (async () => {
        const failures: unknown[] = [];
        for (const cleanup of [...cleanups].reverse()) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Plugin cleanup failed");
      })();
      return disposing;
    },
  };
}

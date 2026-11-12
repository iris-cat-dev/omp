import type { LocalPluginClientScope } from "@omp-desktop/protocol/desktop-local-plugins";
export interface ClientScopeBinding extends LocalPluginClientScope {
  readonly senderId: number;
  closed: boolean;
  pending: number;
  readonly revisions: Map<"background" | "previews", number>;
}
export class LocalPluginClientScopes {
  private readonly scopes = new Map<string, ClientScopeBinding>();
  constructor(private readonly release: (binding: ClientScopeBinding) => void) {}
  private key(input: Pick<ClientScopeBinding, "senderId" | "documentEpoch" | "installationId" | "generation" | "clientActivationId">): string { return JSON.stringify([input.senderId, input.documentEpoch, input.installationId, input.generation, input.clientActivationId]); }
  open(input: LocalPluginClientScope, senderId: number): void {
    const key = this.key({ ...input, senderId });
    if (this.scopes.has(key)) throw new Error("Plugin client activation is already registered.");
    this.scopes.set(key, { ...input, senderId, closed: false, pending: 0, revisions: new Map() });
  }
  accept(input: Pick<LocalPluginClientScope, "documentEpoch" | "installationId" | "generation" | "clientActivationId">, senderId: number): ClientScopeBinding {
    const binding = this.scopes.get(this.key({ ...input, senderId }));
    if (!binding || binding.closed) throw new Error("Plugin client activation has been released.");
    binding.pending += 1;
    return binding;
  }
  assertCurrent(binding: ClientScopeBinding): void { if (binding.closed || this.scopes.get(this.key(binding)) !== binding) throw new Error("Plugin client activation has been released."); }
  acceptRevision(binding: ClientScopeBinding, purpose: "background" | "previews", revision: number): void {
    this.assertCurrent(binding);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision <= (binding.revisions.get(purpose) ?? -1)) throw new Error("Plugin media intent was superseded.");
    binding.revisions.set(purpose, revision);
  }
  finish(binding: ClientScopeBinding): void { binding.pending -= 1; if (binding.closed && binding.pending === 0 && this.scopes.get(this.key(binding)) === binding) this.scopes.delete(this.key(binding)); }
  close(input: Pick<LocalPluginClientScope, "documentEpoch" | "installationId" | "generation" | "clientActivationId">, senderId: number): void {
    const binding = this.scopes.get(this.key({ ...input, senderId }));
    if (!binding || binding.closed) return;
    binding.closed = true;
    this.release(binding);
    if (binding.pending === 0) this.scopes.delete(this.key(binding));
  }
  releaseDocument(senderId: number): void { for (const binding of [...this.scopes.values()]) if (binding.senderId === senderId) this.close(binding, senderId); }
  revokeInstallation(installationId: string, generation: number): void { for (const binding of [...this.scopes.values()]) if (binding.installationId === installationId && binding.generation === generation) this.close(binding, binding.senderId); }
}

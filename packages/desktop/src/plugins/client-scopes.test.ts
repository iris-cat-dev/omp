import { describe, expect, it, vi } from "vitest";
import { LocalPluginClientScopes, type ClientScopeBinding } from "./client-scopes.js";
const identity = { installationId: "wallpaper", generation: 7, documentEpoch: 3, clientActivationId: "window-one-active", mode: "active" as const };
describe("document client activation leases", () => {
  it("rejects a different window, document, generation or activation ID", () => {
    const scopes = new LocalPluginClientScopes(vi.fn()); scopes.open(identity, 11);
    for (const changed of [{ ...identity, documentEpoch: 4 }, { ...identity, generation: 8 }, { ...identity, clientActivationId: "another" }, { ...identity, installationId: "other-plugin" }]) expect(() => scopes.accept(changed, 11)).toThrow("released");
    expect(() => scopes.accept(identity, 12)).toThrow("released");
  });
  it("marks a pending request revoked before releasing resources and rejects its late result", () => {
    let scopes: LocalPluginClientScopes;
    const release = vi.fn((binding: ClientScopeBinding) => { expect(() => scopes.assertCurrent(binding)).toThrow("released"); });
    scopes = new LocalPluginClientScopes(release); scopes.open(identity, 11);
    const pending = scopes.accept(identity, 11); scopes.close(identity, 11);
    expect(release).toHaveBeenCalledOnce(); expect(() => scopes.assertCurrent(pending)).toThrow("released");
    scopes.finish(pending); scopes.close(identity, 11); expect(release).toHaveBeenCalledOnce();
  });
  it("preserves a replacement client and other windows in the same installation generation", () => {
    const release = vi.fn(), scopes = new LocalPluginClientScopes(release);
    const replacement = { ...identity, clientActivationId: "replacement" };
    scopes.open(identity, 11); scopes.open(replacement, 11); scopes.open(identity, 12); scopes.close(identity, 11);
    const current = scopes.accept(replacement, 11), otherWindow = scopes.accept(identity, 12); scopes.assertCurrent(current); scopes.assertCurrent(otherWindow); scopes.finish(current); scopes.finish(otherWindow);
    expect(release).toHaveBeenCalledOnce();
  });
  it("rejects stale media intent numbers only within the originating client scope", () => {
    const scopes = new LocalPluginClientScopes(vi.fn()); scopes.open(identity, 11); const first = scopes.accept(identity, 11);
    scopes.acceptRevision(first, "background", 7); expect(() => scopes.acceptRevision(first, "background", 7)).toThrow("superseded"); scopes.finish(first); scopes.close(identity, 11);
    const replacement = { ...identity, clientActivationId: "replacement" }; scopes.open(replacement, 11); const second = scopes.accept(replacement, 11); scopes.acceptRevision(second, "background", 1); scopes.finish(second);
  });
  it("revokes one owner generation without touching another installation", () => {
    const release = vi.fn(), scopes = new LocalPluginClientScopes(release), other = { ...identity, installationId: "desktop-pet" };
    scopes.open(identity, 11); scopes.open(other, 11); scopes.revokeInstallation("wallpaper", 7); expect(release).toHaveBeenCalledOnce(); const pending = scopes.accept(other, 11); scopes.assertCurrent(pending); scopes.finish(pending);
  });
});

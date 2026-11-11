// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineRpc } from "@omp-desktop/plugin";
import { createActivationScope } from "@omp-desktop/plugin/host";
import type { ExternalTextComposerAttachment } from "@/attachments/types";
import { setupPluginClient } from "./context";
import { pluginClientRegistry, type PluginClientInstance } from "./registry";
import { ExternalTextAttachmentFrame, ExternalTextAttachmentPill, usePluginAttachmentPicker } from "./attachments";

vi.mock("react-native", () => ({
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress, testID, disabled }: { children: React.ReactNode; onPress: () => void; testID: string; disabled: boolean }) => <button data-testid={testID} onClick={onPress} disabled={disabled}>{children}</button>,
}));
vi.mock("react-native-unistyles", () => ({ StyleSheet: { create: () => ({}) }, useUnistyles: () => ({ theme: { colors: { foregroundMuted: "gray" } } }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./icons", () => ({ resolvePluginIcon: () => () => <svg /> }));
vi.mock("@/components/adaptive-modal-sheet", () => ({ AdaptiveModalSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) => visible ? <div>{children}</div> : null }));
vi.mock("@/components/attachment-pill", () => ({
  AttachmentPill: ({ children, onOpen, openAccessibilityLabel }: { children: React.ReactNode; onOpen: () => void; openAccessibilityLabel: string }) => <button aria-label={openAccessibilityLabel} onClick={onOpen}>{children}</button>,
  AttachmentFrame: ({ children, onPress, accessibilityLabel }: { children: React.ReactNode; onPress: () => void; accessibilityLabel: string }) => <button aria-label={accessibilityLabel} onClick={onPress}>{children}</button>,
  AttachmentLabel: ({ title }: { title: string }) => <span>{title}</span>,
}));
vi.mock("@/components/ui/button", () => ({ Button: ({ children }: { children: React.ReactNode }) => <button>{children}</button> }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: () => { throw new Error("This scenario does not open external URLs"); } }));

const instances: PluginClientInstance[] = [];
const resource = { id: "42", identifier: "DOC-42", title: "Saved source document", url: "https://example.com/42", text: "Complete source text\nStill readable after uninstall.", resourceType: "document" };
const search = defineRpc({ name: "search", input: z.object({ query: z.string() }), output: z.object({ items: z.array(z.object({ id: z.string(), identifier: z.string(), title: z.string(), url: z.string(), text: z.string(), resourceType: z.string() })) }) });
const unavailable = (): never => { throw new Error("Unexpected host API access"); };
async function install(hostId: string, owner: "desktop" | "daemon", title: string) {
  const instance = await setupPluginClient({
    hostId, installation: { id: "same-name", packageId: "fixture", owner, version: "1.0.0", generation: 1, enabled: true, declaredCapabilities: [], grantedCapabilities: [] },
    mode: "active", format: "package", scope: createActivationScope(1),
    services: { getPaseo: unavailable, storage: { get: async () => unavailable(), patch: async () => unavailable() }, secrets: { configured: async () => unavailable(), set: async () => unavailable(), delete: async () => unavailable() }, native: { invoke: async () => unavailable(), subscribe: unavailable }, invoke: async (method) => { if (method !== "search") throw new Error("Unknown fixture RPC"); return { items: [resource] }; } },
    setup(ctx) { ctx.addAttachmentSource({ id: "source", title, icon: "Paperclip", pickerTitle: title, searchPlaceholder: "Search", search }); },
  });
  if (!instance) throw new Error("Attachment fixture activation was cancelled");
  instances.push(instance);
  pluginClientRegistry.replace(instance);
  return instance;
}
function Picker({ hostId, onAttach }: { hostId: string; onAttach: (attachment: ExternalTextComposerAttachment) => void }) {
  const { menuItems, picker } = usePluginAttachmentPicker({ hostId, disabled: false, onAttach });
  return <>{menuItems.map(item => <button key={item.id} onClick={item.onSelect}>{item.label}</button>)}{picker}</>;
}
afterEach(async () => {
  cleanup();
  await Promise.all(instances.splice(0).map(async instance => { pluginClientRegistry.remove(instance.key, instance.scope); await instance.scope.dispose(); }));
});

describe("external attachment source ownership", () => {
  it("offers this device's sources with only the selected daemon's sources", async () => {
    await install("desktop", "desktop", "Local source");
    await install("host-a", "daemon", "Host A source");
    await install("host-b", "daemon", "Host B source");
    const onAttach = vi.fn();
    const view = render(<Picker hostId="host-b" onAttach={onAttach} />);
    expect(screen.getByRole("button", { name: "Local source" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Host B source" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Host A source" })).toBeNull();
    view.rerender(<Picker hostId="host-a" onAttach={onAttach} />);
    expect(screen.getByRole("button", { name: "Local source" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Host A source" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Host B source" })).toBeNull();
  });
  it("keeps local snapshot identity across host switches and reads it after source removal", async () => {
    const local = await install("desktop", "desktop", "Local source");
    await install("desktop", "daemon", "Daemon named desktop");
    const onAttach = vi.fn<(attachment: ExternalTextComposerAttachment) => void>();
    const view = render(<Picker hostId="desktop" onAttach={onAttach} />);
    fireEvent.click(screen.getByRole("button", { name: "Local source" }));
    fireEvent.click(await screen.findByTestId("plugin-attachment-result-42"));
    await waitFor(() => expect(onAttach).toHaveBeenCalledTimes(1));
    const saved = onAttach.mock.calls[0][0];
    expect(JSON.parse(saved.id)).toEqual(["desktop", "desktop", "same-name", "source", "42"]);
    expect(saved.text).toBe(resource.text);
    view.rerender(<Picker hostId="host-b" onAttach={onAttach} />);
    fireEvent.click(screen.getByRole("button", { name: "Local source" }));
    fireEvent.click(await screen.findByTestId("plugin-attachment-result-42"));
    expect(onAttach.mock.calls[1][0].id).toBe(saved.id);
    view.unmount();
    pluginClientRegistry.remove(local.key, local.scope);
    await local.scope.dispose();
    const draft = render(<ExternalTextAttachmentPill attachment={saved} index={0} disabled={false} onRemove={() => { throw new Error("This scenario does not remove the snapshot"); }} />);
    fireEvent.click(screen.getByRole("button", { name: resource.title }));
    expect(screen.getByText(/Complete source text.*Still readable after uninstall\./)).toBeTruthy();
    draft.unmount();
    render(<ExternalTextAttachmentFrame title={saved.title} text={saved.text} externalResource={saved.externalResource}><span>{saved.title}</span></ExternalTextAttachmentFrame>);
    fireEvent.click(screen.getByRole("button", { name: resource.title }));
    expect(screen.getByText(/Complete source text.*Still readable after uninstall\./)).toBeTruthy();
  });
});

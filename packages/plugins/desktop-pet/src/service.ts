import { z } from "zod";
import { defineRpc, type PluginServiceContext, type PluginNativeOverlayLease } from "@omp-desktop/plugin/server";
import { PetActivitySnapshots, parsePetActivity } from "./activity.js";
import { PetConfigSchema } from "./config.js";
import { PET_HTML } from "./html.js";
import { petWindowSize } from "./geometry.js";
import type { DesktopPetTask, PetDescriptor } from "./types.js";

export const petActivityRpc = defineRpc({ name: "pet.activity", input: z.object({ senderId: z.number().int(), activity: z.unknown() }), output: z.object({ revalidate: z.array(z.object({ serverId: z.string(), generation: z.string() })) }) });
const menuSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function compactPetMenuTitle(title: string): string {
  let end = 0, count = 0;
  for (const { segment, index } of menuSegmenter.segment(title)) { if (count++ === 20) return `${title.slice(0, end)}…`; end = index + segment.length; }
  return title;
}
export async function setup(ctx: PluginServiceContext) {
  const snapshots = new PetActivitySnapshots();
  let overlay: PluginNativeOverlayLease | undefined;
  ctx.handle(petActivityRpc, ({ senderId, activity }) => { const result = snapshots.publish(senderId, parsePetActivity(activity)); overlay?.update({ state: renderState() }); return result; });
  let storage = await ctx.storage.get();
  let config = PetConfigSchema.parse(storage.values);
  let descriptor = await ctx.native.invoke<PetDescriptor>("pet:selected", { id: config.selectedId });
  let applying = Promise.resolve();
  const renderState = () => ({ descriptor, size: config.size, activity: snapshots.get() });
  const openTask = (task?: DesktopPetTask) => task ? ctx.native.invoke("navigation.openAgent", { serverId: task.serverId, agentId: task.agentId }) : ctx.native.invoke("navigation.openApp");
  const patch = async (values: Partial<typeof config>) => { const current = await ctx.storage.get(); storage = await ctx.storage.patch(values, current.revision); };
  const reportError = async (error: unknown) => { if (ctx.signal.aborted) return; overlay?.release(); overlay = undefined; await ctx.native.invoke("plugin.fail", { message: error instanceof Error ? error.message : String(error) }); };
  overlay = await ctx.native.invoke<PluginNativeOverlayLease>("overlay.acquire", {
    id: "pet", html: PET_HTML, ...petWindowSize(config.size), position: config.position, state: renderState(),
    onPosition: (position: { x: number; y: number }) => patch({ position }),
    onAction: async (action: string, input: unknown) => {
      if (ctx.signal.aborted) throw new Error("Pet generation stopped.");
      if (action === "open") return openTask(snapshots.get().tasks[0]);
      if (action === "hide") return ctx.native.invoke("plugin.setEnabled", { enabled: false });
      if (action === "reset-position") return patch({ position: null });
      if (action === "error") return reportError(input);
      if (action.startsWith("task:")) { const task = snapshots.get().tasks.find((task) => `${task.serverId}:${task.agentId}` === action.slice(5)); if (task) return openTask(task); throw new Error("Task no longer available."); }
      if (action === "menu") {
        const activity = snapshots.get(), labels = activity.labels;
        overlay!.showMenu([{ id: "open", label: labels.openApp }, ...activity.tasks.map((task) => ({ id: `task:${task.serverId}:${task.agentId}`, label: `${labels[task.status]} — ${compactPetMenuTitle(task.title || labels.openTask)}` })), { id: "separator", label: "", type: "separator" }, { id: "hide", label: labels.hide }, { id: "reset-position", label: labels.resetPosition }]);
        return;
      }
      throw new Error(`Unknown pet action: ${action}.`);
    },
  });
  ctx.own(() => { overlay?.release(); overlay = undefined; });
  ctx.own(ctx.native.subscribe("window:removed", (senderId) => { if (typeof senderId === "number") { snapshots.remove(senderId); overlay?.update({ state: renderState() }); } }));
  ctx.own(ctx.native.subscribe("client:released", (senderId) => { if (typeof senderId === "number") { snapshots.remove(senderId); overlay?.update({ state: renderState() }); } }));
  ctx.own(ctx.native.subscribe("storage:changed", () => {
    applying = applying.then(async () => {
      if (ctx.signal.aborted) return;
      storage = await ctx.storage.get();
      const next = PetConfigSchema.parse(storage.values);
      const selected = next.selectedId === config.selectedId ? descriptor : await ctx.native.invoke<PetDescriptor>("pet:selected", { id: next.selectedId });
      if (ctx.signal.aborted) return;
      config = next;
      descriptor = selected;
      overlay?.update({ state: renderState(), ...petWindowSize(config.size), position: config.position });
    }).catch(reportError);
  }));
}

export default setup;

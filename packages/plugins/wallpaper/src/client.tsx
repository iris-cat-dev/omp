import type { PluginClientContext, PluginSettingsPageProps } from "@omp-desktop/plugin";
import { WallpaperController } from "./controller.js";
import { WallpaperControllerContext } from "./context.js";
import { WallpaperSettings } from "./settings.js";

// Management and active factories in one document share drafts, never persisted storage copies.
const instances = new Map<string, { controller: WallpaperController; references: number }>();
export default function setup(ctx: PluginClientContext) {
  const key = `${ctx.installation.id}:${ctx.installation.generation}`;
  let instance = instances.get(key);
  if (!instance) {
    instance = { controller: new WallpaperController(ctx), references: 0 };
    instances.set(key, instance);
  }
  instance.references++;
  const controller = instance.controller;
  const ownedInstance = instance;
  const detach = controller.attach(ctx);
  const viewContext = { controller, client: ctx };
  function SettingsPage(props: PluginSettingsPageProps) {
    return <WallpaperControllerContext.Provider value={viewContext}><WallpaperSettings {...props} /></WallpaperControllerContext.Provider>;
  }
  const stopSettings = ctx.addSettingsPage({ id: "configuration", title: "壁纸", icon: "Image", Component: SettingsPage });
  const deactivate = ctx.mode === "active" ? controller.activate(ctx) : null;
  const stopBackground = ctx.mode === "active" ? ctx.addBackground({ id: "wallpaper", title: "壁纸",
    subscribe: controller.subscribe, getSnapshot: controller.getBackgroundSnapshot }) : null;
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    ctx.signal.removeEventListener("abort", cleanup);
    deactivate?.();
    detach();
    void stopBackground?.();
    void stopSettings();
    if (--ownedInstance.references === 0) { controller.dispose(); instances.delete(key); }
  };
  ctx.signal.addEventListener("abort", cleanup, { once: true });
  if (ctx.signal.aborted) cleanup();
  return cleanup;
}

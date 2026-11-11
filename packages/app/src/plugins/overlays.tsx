import { usePluginContributions } from "./hooks";
import { PluginView } from "./view";

export function PluginOverlays() {
  const overlays = usePluginContributions("overlay", "desktop");
  return <>{overlays.map(({ key, instance, contribution }) => {
    const Overlay = contribution.Component;
    return <PluginView key={key} instance={instance}><Overlay /></PluginView>;
  })}</>;
}

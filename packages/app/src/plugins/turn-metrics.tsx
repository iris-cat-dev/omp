import type { PluginTurnMetricProps } from "@omp-desktop/plugin";
import { usePluginContributions } from "./hooks";
import { PluginView } from "./view";

export function PluginTurnMetrics(props: PluginTurnMetricProps) {
  const metrics = usePluginContributions("metric");
  return <>{metrics.filter(({ instance }) => instance.installation.owner === "desktop" || instance.hostId === props.hostId).map(({ key, instance, contribution }) => {
    const Metric = contribution.component;
    return <PluginView key={key} instance={instance} hostId={props.hostId}><Metric {...props} /></PluginView>;
  })}</>;
}

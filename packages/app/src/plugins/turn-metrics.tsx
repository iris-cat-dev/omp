import type { PluginTurnMetricProps } from "@omp-desktop/plugin";
import { TurnOutputSpeed } from "@/agent-stream/turn-output-speed";
import { usePluginContributions } from "./hooks";
import { PluginView } from "./view";

export function TurnMetrics(props: PluginTurnMetricProps) {
  const metrics = usePluginContributions("metric").filter(
    ({ instance }) => instance.installation.owner === "desktop" || instance.hostId === props.hostId,
  );
  return (
    <>
      {metrics.some(({ contribution }) => contribution.id === "output-speed") ? null : (
        <TurnOutputSpeed {...props} />
      )}
      {metrics.map(({ key, instance, contribution }) => {
        const Metric = contribution.component;
        return (
          <PluginView key={key} instance={instance} hostId={props.hostId}>
            <Metric {...props} />
          </PluginView>
        );
      })}
    </>
  );
}

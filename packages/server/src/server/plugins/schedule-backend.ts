import { z } from "zod";
import {
  ScheduleRunSchema,
  StoredScheduleSchema,
  type CreateScheduleInput,
  type ScheduleRun,
  type StoredSchedule,
  type UpdateScheduleInput,
} from "@omp-desktop/protocol/schedule/types";
import type { PluginService } from "./index.js";

/** The legacy schedule transport delegates to the active optional plugin. */
export interface ScheduleBackend {
  create(input: CreateScheduleInput): Promise<StoredSchedule>;
  list(): Promise<StoredSchedule[]>;
  inspect(id: string): Promise<StoredSchedule>;
  logs(id: string): Promise<ScheduleRun[]>;
  pause(id: string): Promise<StoredSchedule>;
  resume(id: string): Promise<StoredSchedule>;
  delete(id: string): Promise<void>;
  runOnce(id: string): Promise<StoredSchedule>;
  update(input: UpdateScheduleInput): Promise<StoredSchedule>;
}

type SchedulePlugins = Pick<PluginService, "catalog" | "invokePluginRpc">;

export class SchedulePluginUnavailableError extends Error {
  constructor(detail: string) {
    super(`Schedules plugin unavailable: ${detail}`);
    this.name = "SchedulePluginUnavailableError";
  }
}

export function createSchedulePluginBackend(plugins?: SchedulePlugins): ScheduleBackend {
  async function invoke<T>(method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
    const installations = plugins?.catalog().filter((item) => item.owner === "daemon" && item.packageId === "schedules") ?? [];
    const active = installations.filter((item) => item.installed && item.enabled && item.effectiveEnabled && item.status === "running");
    const canonical = active.find((item) => item.id === "schedules");
    if (!canonical && active.length > 1) {
      throw new SchedulePluginUnavailableError(
        `multiple active installations (${active.map((item) => item.id).join(", ")}); disable all but one or use the canonical installation ID "schedules".`,
      );
    }
    const installation = canonical ?? active[0];
    if (!installation || !plugins) {
      const reasons = installations.map((item) => `${item.id}: ${item.error ?? item.waitingReason ?? item.status}`).join("; ");
      throw new SchedulePluginUnavailableError(
        installations.length === 0
          ? 'install and enable the "schedules" plugin in Plugins to manage scheduled tasks.'
          : `enable the host plugin switch, approve and enable the "schedules" plugin, and resolve any startup failure in Plugins (${reasons}).`,
      );
    }
    return schema.parse(await plugins.invokePluginRpc(installation.id, `schedules.${method}`, input, installation.generation));
  }

  return {
    create: (input) => invoke("create", input, StoredScheduleSchema),
    list: () => invoke("list", {}, StoredScheduleSchema.array()),
    inspect: (id) => invoke("inspect", { id }, StoredScheduleSchema),
    logs: (id) => invoke("logs", { id }, ScheduleRunSchema.array()),
    pause: (id) => invoke("pause", { id }, StoredScheduleSchema),
    resume: (id) => invoke("resume", { id }, StoredScheduleSchema),
    delete: async (id) => { await invoke("delete", { id }, z.object({ deleted: z.literal(true) })); },
    runOnce: (id) => invoke("run-once", { id }, StoredScheduleSchema),
    update: (input) => invoke("update", input, StoredScheduleSchema),
  };
}

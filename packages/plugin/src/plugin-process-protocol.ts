import type { PluginInstallation } from "@omp-desktop/plugin/server";
export type PluginProcessRequest =
  | { type: "initialize"; pluginId: string; bundle: string; serviceEntry: string; format: "legacy" | "package"; installation: PluginInstallation; mode: "manage" | "active" }
  | { type: "invoke"; requestId: string; method: string; input: unknown }
  | { type: "host_result"; requestId: string; output?: unknown; error?: string }
  | { type:"host_event";event:string;payload:unknown }
  | { type: "shutdown" }
  | { type: "omp_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "omp_close" };

export type PluginProcessMessage =
  | { type: "ready"; methods: string[] }
  | { type: "result"; requestId: string; output: unknown }
  | { type: "error"; requestId: string; error: string }
  | { type: "fatal"; error: string }
  | { type: "host_call"; requestId: string; operation: string; input: unknown }
  | { type: "waiting"; reason: string | null }
  | { type: "omp_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "omp_close" };

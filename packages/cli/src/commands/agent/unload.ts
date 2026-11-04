import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";

interface UnloadResult {
  agentId: string;
  state: string;
}

const unloadSchema: OutputSchema<UnloadResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT", field: "agentId" },
    { header: "RUNTIME", field: "state" },
  ],
};

export async function runUnloadCommand(
  id: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<UnloadResult>> {
  const client = await connectToDaemon({ host: options.host });
  try {
    const fetched = await client.fetchAgent({ agentId: id });
    if (!fetched) {
      throw { code: "AGENT_NOT_FOUND", message: `No agent found matching: ${id}` };
    }
    const result = await client.unloadAgentRuntime(fetched.agent.id);
    return {
      type: "single",
      data: { agentId: result.agentId, state: result.runtimeRetention?.state ?? "unloaded" },
      schema: unloadSchema,
    };
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause) throw cause;
    throw {
      code: "UNLOAD_AGENT_FAILED",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

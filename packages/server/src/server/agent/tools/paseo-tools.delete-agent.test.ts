import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PARENT_AGENT_ID_LABEL } from "@omp-desktop/protocol/agent-labels";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../../test-utils/session-stubs.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import { createAgentMcpServer } from "../mcp-server.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

const logger = createTestLogger();
const IDS = {
  target: "11111111-1111-4111-8111-111111111101",
  peer: "11111111-1111-4111-8111-111111111102",
  parent: "11111111-1111-4111-8111-111111111103",
  caller: "11111111-1111-4111-8111-111111111104",
};

describe("permanent agent history deletion", () => {
  let root: string;
  let cwd: string;
  let storage: AgentStorage;
  let manager: AgentManager;
  const snapshots = createProviderSnapshotManagerStub();

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "delete-agent-history-"));
    cwd = join(root, "project");
    await fs.mkdir(cwd);
    await fs.writeFile(join(cwd, "deliverable.txt"), "keep this output");
    storage = new AgentStorage(join(root, "agents"), logger);
    manager = new AgentManager({ registry: storage, clients: createTestAgentClients(), logger });
    snapshots.listRegisteredProviderIds.mockReturnValue(["codex"]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();
    await fs.rm(root, { recursive: true, force: true });
  });

  function catalog(callerAgentId?: string) {
    return createPaseoToolCatalog({
      agentManager: manager,
      agentStorage: storage,
      providerSnapshotManager: snapshots.manager,
      callerAgentId,
      logger,
    });
  }

  async function createAgent(name: keyof typeof IDS, labels?: Record<string, string>) {
    return manager.createAgent({ provider: "codex", cwd }, IDS[name], {
      workspaceId: labels ? "workspace-parent" : `workspace-${name}`,
      labels,
    });
  }

  it.each([false, true])(
    "deletes history (archived=%s) through MCP without touching the project or peers",
    async (archived) => {
      const target = await createAgent("target");
      await createAgent("peer");
      await manager.appendTimelineItem(target.id, {
        type: "assistant_message",
        text: "retained reply",
      });
      if (archived) await manager.archiveAgent(target.id);
      const server = await createAgentMcpServer({
        agentManager: manager,
        agentStorage: storage,
        providerSnapshotManager: snapshots.manager,
        logger,
      });
      const client = new Client({ name: "delete-history-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const response = await client.callTool({
          name: "delete_agent",
          arguments: { agentId: target.id, confirm: true },
        });
        expect(response.isError).not.toBe(true);
        expect(response.structuredContent).toEqual({ agentId: target.id, status: "deleted" });
        expect(manager.getAgent(target.id)).toBeNull();
        expect(await storage.get(target.id)).toBeNull();
        expect(await new AgentStorage(join(root, "agents"), logger).get(target.id)).toBeNull();
        const list = await catalog().executeTool("list_agents", { includeArchived: true });
        expect(list.structuredContent).toMatchObject({ agents: [{ id: IDS.peer }] });
        expect(await fs.readFile(join(cwd, "deliverable.txt"), "utf8")).toBe("keep this output");
        expect(
          await client.callTool({
            name: "delete_agent",
            arguments: { agentId: target.id, confirm: true },
          }),
        ).toMatchObject({
          structuredContent: { agentId: target.id, status: "not_found" },
        });
      } finally {
        await client.close();
        await server.close();
      }
    },
  );

  it("requires explicit confirmation and refuses self or ancestor deletion", async () => {
    await createAgent("parent");
    await createAgent("caller", { [PARENT_AGENT_ID_LABEL]: IDS.parent });
    await createAgent("peer");
    const tools = catalog(IDS.caller);
    await expect(tools.executeTool("delete_agent", { agentId: IDS.peer })).rejects.toThrow();
    await expect(
      tools.executeTool("delete_agent", { agentId: IDS.peer, confirm: false }),
    ).rejects.toThrow();
    for (const agentId of [IDS.caller, IDS.parent]) {
      await expect(tools.executeTool("delete_agent", { agentId, confirm: true })).rejects.toThrow(
        "Cannot delete the calling agent",
      );
    }
    expect((await storage.list()).map((record) => record.id).sort()).toEqual(
      [IDS.caller, IDS.parent, IDS.peer].sort(),
    );
  });

  it("reports a close failure without deleting the persistent record", async () => {
    const target = await createAgent("target");
    const close = vi
      .spyOn(target.session!, "close")
      .mockRejectedValueOnce(new Error("runtime still alive"));
    await expect(
      catalog().executeTool("delete_agent", { agentId: target.id, confirm: true }),
    ).rejects.toThrow("runtime still alive");
    close.mockRestore();
    expect(await storage.get(target.id)).toMatchObject({ id: target.id });
    expect(await new AgentStorage(join(root, "agents"), logger).get(target.id)).toMatchObject({
      id: target.id,
    });
    await storage.setTitle(target.id, "retry remains possible");
    expect(await storage.get(target.id)).toMatchObject({ title: "retry remains possible" });
  });

  it("reports disk failures instead of claiming deletion and allows a retry", async () => {
    const target = await createAgent("target");
    await manager.archiveAgent(target.id);
    const unlink = vi
      .spyOn(fs, "unlink")
      .mockRejectedValueOnce(Object.assign(new Error("record is locked"), { code: "EACCES" }));
    await expect(
      catalog().executeTool("delete_agent", { agentId: target.id, confirm: true }),
    ).rejects.toThrow("record is locked");
    unlink.mockRestore();
    expect(await storage.get(target.id)).toMatchObject({ id: target.id });
    expect(await new AgentStorage(join(root, "agents"), logger).get(target.id)).toMatchObject({
      id: target.id,
    });
    expect(
      await catalog().executeTool("delete_agent", { agentId: target.id, confirm: true }),
    ).toMatchObject({
      structuredContent: { agentId: target.id, status: "deleted" },
    });
    expect(await new AgentStorage(join(root, "agents"), logger).get(target.id)).toBeNull();
  });
});

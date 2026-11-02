import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import {
  readOmpSubagentSettings,
  updateOmpSubagentModel,
  updateOmpSubagentSettingsEnabled,
} from "./subagent-settings.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createAgentDir(): Promise<{ agentDir: string; env: NodeJS.ProcessEnv }> {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-subagent-settings-"));
  tempDirs.push(agentDir);
  return { agentDir, env: { PI_CODING_AGENT_DIR: agentDir } };
}

describe("OMP subagent settings", () => {
  test("lists bundled agents as inherited when config is absent", async () => {
    const { agentDir, env } = await createAgentDir();

    await expect(readOmpSubagentSettings(env)).resolves.toMatchObject({
      configPath: join(agentDir, "config.yml"),
      enabled: false,
      agents: [
        { name: "scout" },
        { name: "task" },
        { name: "sonic" },
        { name: "reviewer" },
        { name: "security-reviewer" },
      ],
    });
  });

  test("updates one model override without replacing unrelated config", async () => {
    const { agentDir, env } = await createAgentDir();
    const configPath = join(agentDir, "config.yml");
    await writeFile(
      configPath,
      "# Keep this comment\nmodelRoles:\n  review: openai/gpt-5.6-sol:high\ntask:\n  maxRecursionDepth: 3\n  agentModelOverrides:\n    scout: openai/gpt-5-mini\n",
      "utf8",
    );

    const settings = await updateOmpSubagentModel("reviewer", "@review", env);

    expect(settings.agents.find((agent) => agent.name === "reviewer")?.model).toBe("@review");
    const written = await readFile(configPath, "utf8");
    expect(written).toContain("# Keep this comment");
    expect(written).toContain("maxRecursionDepth: 3");
    expect(written).toContain("scout: openai/gpt-5-mini");
    expect(written).toContain('reviewer: "@review"');
  });

  test.each([
    { fastMode: true, serviceTier: "priority", model: "openai/gpt-5.6-sol:high" },
    { fastMode: false, serviceTier: "none", model: "@review:max" },
    { fastMode: "ultrafast" as const, serviceTier: "ultrafast", model: "openai/gpt-6.1-sol:xhigh" },
  ])(
    "round trips $model with speed $fastMode in native settings",
    async ({ fastMode, serviceTier, model }) => {
      const { agentDir, env } = await createAgentDir();
      const configPath = join(agentDir, "config.yml");
      await writeFile(
        configPath,
        "# Keep this comment\ntask:\n  maxRecursionDepth: 3\n  agentModelOverrides:\n    scout: openai/gpt-5-mini:low\n    custom: custom/model:max\n  agentServiceTierOverrides:\n    scout: none # Scout tier\n    custom: flex # Custom tier\n",
        "utf8",
      );

      const settings = await updateOmpSubagentModel("reviewer", model, env, { fastMode });

      expect(settings.agents.find((agent) => agent.name === "reviewer")).toMatchObject({
        model,
        fastMode,
        serviceTier,
      });
      expect(await readOmpSubagentSettings(env)).toEqual(settings);
      const written = await readFile(configPath, "utf8");
      expect(parse(written)).toEqual({
        task: {
          maxRecursionDepth: 3,
          agentModelOverrides: {
            scout: "openai/gpt-5-mini:low",
            custom: "custom/model:max",
            reviewer: model,
          },
          agentServiceTierOverrides: { scout: "none", custom: "flex", reviewer: serviceTier },
        },
      });
      expect(written).toContain("# Keep this comment");
      expect(written).toContain("# Scout tier");
      expect(written).toContain("# Custom tier");
    },
  );

  test.each([
    { serviceTier: "flex", fastMode: undefined },
    { serviceTier: "default", fastMode: undefined },
    { serviceTier: "auto", fastMode: undefined },
    { serviceTier: "priority", fastMode: true },
    { serviceTier: "ultrafast", fastMode: "ultrafast" },
    { serviceTier: "none", fastMode: false },
  ])(
    "preserves native $serviceTier when only the model is edited",
    async ({ serviceTier, fastMode }) => {
      const { agentDir, env } = await createAgentDir();
      const configPath = join(agentDir, "config.yml");
      await writeFile(
        configPath,
        `task:\n  agentModelOverrides:\n    reviewer: "@review:high"\n  agentServiceTierOverrides:\n    reviewer: ${serviceTier} # Native tier\n`,
        "utf8",
      );

      const initial = await readOmpSubagentSettings(env);
      expect(initial.agents.find((agent) => agent.name === "reviewer")?.serviceTier).toBe(
        serviceTier,
      );
      expect(initial.agents.find((agent) => agent.name === "reviewer")?.fastMode).toBe(fastMode);
      const model = "@unknown-role:future-effort";
      const settings = await updateOmpSubagentModel("reviewer", model, env);

      expect(settings.agents.find((agent) => agent.name === "reviewer")).toMatchObject({
        model,
        serviceTier,
      });
      expect(settings.agents.find((agent) => agent.name === "reviewer")?.fastMode).toBe(fastMode);
      expect(await readOmpSubagentSettings(env)).toEqual(settings);
      const written = await readFile(configPath, "utf8");
      expect(parse(written).task.agentServiceTierOverrides).toEqual({ reviewer: serviceTier });
      expect(written).toContain("# Native tier");
    },
  );

  test("removes the tier override explicitly without removing the model or sibling tiers", async () => {
    const { agentDir, env } = await createAgentDir();
    const configPath = join(agentDir, "config.yml");
    await writeFile(
      configPath,
      "task:\n  agentModelOverrides:\n    reviewer: openai/gpt-5.6-sol:high\n  agentServiceTierOverrides:\n    reviewer: priority\n    scout: none\n    custom: flex # Keep custom\n",
      "utf8",
    );

    const settings = await updateOmpSubagentModel("reviewer", "openai/gpt-5.6-sol:off", env, {
      fastMode: null,
    });

    const reviewer = settings.agents.find((agent) => agent.name === "reviewer");
    expect(reviewer?.model).toBe("openai/gpt-5.6-sol:off");
    expect(reviewer).not.toHaveProperty("fastMode");
    expect(reviewer).not.toHaveProperty("serviceTier");
    expect(await readOmpSubagentSettings(env)).toEqual(settings);
    const written = await readFile(configPath, "utf8");
    expect(parse(written).task).toEqual({
      agentModelOverrides: { reviewer: "openai/gpt-5.6-sol:off" },
      agentServiceTierOverrides: { scout: "none", custom: "flex" },
    });
    expect(written).toContain("# Keep custom");
  });

  test("removes the tier mapping when its final override is reset", async () => {
    const { agentDir, env } = await createAgentDir();
    const configPath = join(agentDir, "config.yml");
    await writeFile(
      configPath,
      "task:\n  agentModelOverrides:\n    reviewer: openai/gpt-5.6-sol:high\n  agentServiceTierOverrides:\n    reviewer: priority\n",
      "utf8",
    );

    await updateOmpSubagentModel("reviewer", "openai/gpt-5.6-sol:high", env, { fastMode: null });

    expect(parse(await readFile(configPath, "utf8"))).toEqual({
      task: { agentModelOverrides: { reviewer: "openai/gpt-5.6-sol:high" } },
    });
    const settings = await readOmpSubagentSettings(env);
    expect(settings.agents.find((agent) => agent.name === "reviewer")).not.toHaveProperty(
      "serviceTier",
    );
  });

  test("removes an override to restore inheritance", async () => {
    const { agentDir, env } = await createAgentDir();
    const configPath = join(agentDir, "config.yml");
    await writeFile(
      configPath,
      "task:\n  maxRecursionDepth: 3\n  agentModelOverrides:\n    reviewer: openai/gpt-5.6-sol:high\n",
      "utf8",
    );

    const settings = await updateOmpSubagentModel("reviewer", null, env);

    expect(settings.agents.find((agent) => agent.name === "reviewer")?.model).toBeUndefined();
    const written = await readFile(configPath, "utf8");
    expect(written).toContain("maxRecursionDepth: 3");
    expect(written).toContain("agentModelOverrides: {}");
  });

  test("restores model and tier inheritance together without changing other agents", async () => {
    const { agentDir, env } = await createAgentDir();
    const configPath = join(agentDir, "config.yml");
    await writeFile(
      configPath,
      "# Retain settings\ntask:\n  maxRecursionDepth: 3\n  agentModelOverrides:\n    reviewer: openai/gpt-5.6-sol:high\n    scout: openai/gpt-5-mini:low\n    custom: custom/model:max\n  agentServiceTierOverrides:\n    reviewer: priority\n    scout: none\n    custom: flex # Keep custom\n",
      "utf8",
    );

    const settings = await updateOmpSubagentModel("reviewer", null, env, { fastMode: true });

    const reviewer = settings.agents.find((agent) => agent.name === "reviewer");
    expect(reviewer).not.toHaveProperty("model");
    expect(reviewer).not.toHaveProperty("fastMode");
    expect(reviewer).not.toHaveProperty("serviceTier");
    expect(await readOmpSubagentSettings(env)).toEqual(settings);
    const written = await readFile(configPath, "utf8");
    expect(parse(written).task).toEqual({
      maxRecursionDepth: 3,
      agentModelOverrides: { scout: "openai/gpt-5-mini:low", custom: "custom/model:max" },
      agentServiceTierOverrides: { scout: "none", custom: "flex" },
    });
    expect(written).toContain("# Retain settings");
    expect(written).toContain("# Keep custom");
  });

  test("toggles the agentModelOverrides mapping without changing other task settings", async () => {
    const { agentDir, env } = await createAgentDir();
    const configPath = join(agentDir, "config.yml");
    await writeFile(configPath, "task:\n  maxRecursionDepth: 3\n", "utf8");

    await expect(updateOmpSubagentSettingsEnabled(true, env)).resolves.toMatchObject({
      enabled: true,
    });
    await expect(readFile(configPath, "utf8")).resolves.toContain("agentModelOverrides: {}");

    await expect(updateOmpSubagentSettingsEnabled(false, env)).resolves.toMatchObject({
      enabled: false,
    });
    const written = await readFile(configPath, "utf8");
    expect(written).toContain("maxRecursionDepth: 3");
    expect(written).not.toContain("agentModelOverrides");
  });

  test("disabling overrides clears bundled tiers while preserving custom tiers and task settings", async () => {
    const { agentDir, env } = await createAgentDir();
    const configPath = join(agentDir, "config.yml");
    await writeFile(
      configPath,
      "# Retain settings\ntask:\n  maxRecursionDepth: 3\n  agentModelOverrides:\n    reviewer: openai/gpt-5.6-sol:high\n    custom: custom/model\n  agentServiceTierOverrides:\n    scout: priority\n    task: none\n    sonic: flex\n    reviewer: priority\n    security-reviewer: priority\n    custom: flex # Keep custom\n",
      "utf8",
    );

    const settings = await updateOmpSubagentSettingsEnabled(false, env);

    expect(settings.enabled).toBe(false);
    for (const agent of settings.agents) {
      expect(agent).not.toHaveProperty("model");
      expect(agent).not.toHaveProperty("fastMode");
      expect(agent).not.toHaveProperty("serviceTier");
    }
    expect(await readOmpSubagentSettings(env)).toEqual(settings);
    const written = await readFile(configPath, "utf8");
    expect(parse(written)).toEqual({
      task: { maxRecursionDepth: 3, agentServiceTierOverrides: { custom: "flex" } },
    });
    expect(written).toContain("# Retain settings");
    expect(written).toContain("# Keep custom");
    await updateOmpSubagentSettingsEnabled(true, env);
    expect(parse(await readFile(configPath, "utf8"))).toEqual({
      task: {
        maxRecursionDepth: 3,
        agentModelOverrides: {},
        agentServiceTierOverrides: { custom: "flex" },
      },
    });
  });

  test("disabling overrides removes the task mapping when only bundled settings remain", async () => {
    const { agentDir, env } = await createAgentDir();
    const configPath = join(agentDir, "config.yml");
    await writeFile(
      configPath,
      "task:\n  agentModelOverrides: {}\n  agentServiceTierOverrides:\n    reviewer: priority\n",
      "utf8",
    );

    await updateOmpSubagentSettingsEnabled(false, env);

    expect(parse(await readFile(configPath, "utf8"))).toEqual({});
    expect(await readOmpSubagentSettings(env)).toMatchObject({ enabled: false });
  });

  test("rejects model changes while overrides are disabled", async () => {
    const { env } = await createAgentDir();

    await expect(updateOmpSubagentModel("task", "openai/gpt-5-mini", env)).rejects.toThrow(
      "Enable OMP subagent model overrides",
    );
  });

  test("rejects unknown agents and malformed task settings", async () => {
    const { agentDir, env } = await createAgentDir();
    await expect(updateOmpSubagentModel("unknown", "openai/gpt-5-mini", env)).rejects.toThrow(
      "Unknown bundled OMP subagent",
    );
    await writeFile(join(agentDir, "config.yml"), "task: disabled\n", "utf8");
    await expect(updateOmpSubagentModel("task", "openai/gpt-5-mini", env)).rejects.toThrow(
      "task must be a mapping",
    );
  });

  test.each(["priority", "[priority, none]"])(
    "rejects a malformed tier mapping %s without changing the original file",
    async (tiers) => {
      const { agentDir, env } = await createAgentDir();
      const configPath = join(agentDir, "config.yml");
      const original = `# Keep original\ntask:\n  agentModelOverrides:\n    reviewer: openai/gpt-5.6-sol:high\n  agentServiceTierOverrides: ${tiers}\n`;
      await writeFile(configPath, original, "utf8");

      await expect(readOmpSubagentSettings(env)).rejects.toThrow();
      await expect(
        updateOmpSubagentModel("reviewer", "openai/gpt-5.6-sol:low", env, { fastMode: true }),
      ).rejects.toThrow();
      await expect(readFile(configPath, "utf8")).resolves.toBe(original);
      await expect(updateOmpSubagentSettingsEnabled(false, env)).rejects.toThrow();
      await expect(readFile(configPath, "utf8")).resolves.toBe(original);
      await expect(updateOmpSubagentSettingsEnabled(true, env)).rejects.toThrow();
      await expect(readFile(configPath, "utf8")).resolves.toBe(original);
    },
  );
});

import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { readOmpCodexResetSettings, updateOmpCodexResetSettings } from "./codex-reset-settings.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-codex-reset-settings-"));
  tempDirs.push(agentDir);
  return {
    agentDir,
    configPath: join(agentDir, "config.yml"),
    env: { PI_CODING_AGENT_DIR: agentDir },
  };
}

describe("OMP Codex reset settings", () => {
  test("preserves unset without creating config", async () => {
    const { configPath, env } = await fixture();
    await expect(readOmpCodexResetSettings(env)).resolves.toEqual({
      configPath,
      autoRedeem: "unset",
    });
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("persists yes/no while preserving siblings and comments", async () => {
    const { configPath, env } = await fixture();
    await writeFile(
      configPath,
      "# Global comment\nmodelRoles:\n  default: test/model\ncodexResets:\n  autoRedeem: unset # Policy comment\n  salvageWindowMs: 5000 # Sibling comment\n",
    );
    for (const enabled of [true, false]) {
      const settings = await updateOmpCodexResetSettings(enabled, env);
      expect(settings).toEqual({ configPath, autoRedeem: enabled ? "yes" : "no" });
      expect(await readOmpCodexResetSettings(env)).toEqual(settings);
      const raw = await readFile(configPath, "utf8");
      expect(raw).toContain("# Global comment");
      expect(raw).toContain("# Policy comment");
      expect(raw).toContain("# Sibling comment");
      expect(parse(raw)).toEqual({
        modelRoles: { default: "test/model" },
        codexResets: { autoRedeem: enabled ? "yes" : "no", salvageWindowMs: 5000 },
      });
    }
  });

  test.each([
    ["true", "yes"],
    ["false", "no"],
    ["unset", "unset"],
    ["yes", "yes"],
    ["no", "no"],
  ])("reads native %s as %s", async (value, expected) => {
    const { configPath, env } = await fixture();
    await writeFile(configPath, `codexResets:\n  autoRedeem: ${value}\n`);
    expect((await readOmpCodexResetSettings(env)).autoRedeem).toBe(expected);
  });

  test("uses nested precedence and synchronizes existing dotted storage", async () => {
    const { configPath, env } = await fixture();
    await writeFile(configPath, '"codexResets.autoRedeem": yes # Legacy comment\n');
    expect((await readOmpCodexResetSettings(env)).autoRedeem).toBe("unset");
    await writeFile(
      configPath,
      '"codexResets.autoRedeem": yes # Legacy comment\ncodexResets:\n  autoRedeem: no\n',
    );
    expect((await readOmpCodexResetSettings(env)).autoRedeem).toBe("no");
    await updateOmpCodexResetSettings(false, env);
    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain("# Legacy comment");
    expect(parse(raw)).toEqual({
      "codexResets.autoRedeem": "no",
      codexResets: { autoRedeem: "no" },
    });
  });

  test("falls back to config.yaml and prefers config.yml when both exist", async () => {
    const { agentDir, configPath, env } = await fixture();
    const yamlPath = join(agentDir, "config.yaml");
    await writeFile(yamlPath, "codexResets:\n  autoRedeem: yes\n");
    expect(await updateOmpCodexResetSettings(false, env)).toEqual({
      configPath: yamlPath,
      autoRedeem: "no",
    });
    await writeFile(configPath, "codexResets:\n  autoRedeem: yes\n");
    expect(await readOmpCodexResetSettings(env)).toEqual({ configPath, autoRedeem: "yes" });
  });

  test.each([
    "[broken",
    "- list\n",
    "scalar\n",
    "codexResets: null\n",
    "codexResets: []\n",
    "codexResets:\n  autoRedeem: null\n",
    "codexResets:\n  autoRedeem: maybe\n",
    '"codexResets.autoRedeem": 1\n',
  ])("rejects malformed config without overwriting: %s", async (raw) => {
    const { configPath, env } = await fixture();
    await writeFile(configPath, raw);
    await expect(readOmpCodexResetSettings(env)).rejects.toThrow("Invalid OMP config");
    await expect(updateOmpCodexResetSettings(false, env)).rejects.toThrow("Invalid OMP config");
    expect(await readFile(configPath, "utf8")).toBe(raw);
  });

  test("serializes same-file reset writes", async () => {
    const { configPath, env } = await fixture();
    await Promise.all([
      updateOmpCodexResetSettings(true, env),
      updateOmpCodexResetSettings(false, env),
    ]);
    expect(await readOmpCodexResetSettings(env)).toEqual({ configPath, autoRedeem: "no" });
  });
});

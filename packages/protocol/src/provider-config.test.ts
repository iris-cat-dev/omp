import { describe, expect, test } from "vitest";
import {
  applyOmpProxyEnabled,
  ProviderOverrideSchema,
  ProviderRuntimeSettingsSchema,
  resolveOmpProxyUrl,
} from "./provider-config.js";
import { MutableDaemonConfigPatchSchema } from "./messages.js";

describe("OMP proxy configuration", () => {
  test("keeps a configured proxy enabled by default for existing configs", () => {
    expect(resolveOmpProxyUrl({ env: { PI_PROXY: "  http://127.0.0.1:7890  " } })).toBe(
      "http://127.0.0.1:7890",
    );
  });

  test("disables the proxy without deleting its configured URL", () => {
    const config = {
      env: { PI_PROXY: "http://127.0.0.1:7890", OTHER: "value" },
      params: { proxyEnabled: false },
    };

    expect(resolveOmpProxyUrl(config)).toBeUndefined();
    expect(applyOmpProxyEnabled({ env: config.env }, config)).toEqual({
      env: { PI_PROXY: "", OTHER: "value" },
    });
    expect(config.env.PI_PROXY).toBe("http://127.0.0.1:7890");
  });

  test("restores the saved proxy when enabled again", () => {
    const config = {
      env: { PI_PROXY: "http://127.0.0.1:7890" },
      params: { proxyEnabled: true },
    };

    expect(resolveOmpProxyUrl(config)).toBe("http://127.0.0.1:7890");
    expect(applyOmpProxyEnabled({ env: config.env }, config)).toEqual({ env: config.env });
  });
});

describe("OMP backend configuration", () => {
  test("does not opt existing provider configurations into a backend", () => {
    expect(ProviderRuntimeSettingsSchema.parse({ env: { OMP_HOME: "/tmp/omp" } })).toEqual({
      env: { OMP_HOME: "/tmp/omp" },
    });
    expect(ProviderOverrideSchema.parse({ enabled: true })).toEqual({ enabled: true });
  });

  test.each(["/opt/omp", "C:\\omp", "\\\\server\\share\\omp"])(
    "accepts an absolute SDK package root %s",
    (ompSdkPath) => {
      expect(
        ProviderRuntimeSettingsSchema.parse({ ompBackend: "sdk", ompSdkPath }).ompSdkPath,
      ).toBe(ompSdkPath);
    },
  );

  test.each(["./omp", "omp", "~/omp", "C:omp", ""])(
    "rejects a non-absolute SDK package root %s at every configuration boundary",
    (ompSdkPath) => {
      const settings = { ompBackend: "sdk", ompSdkPath };
      expect(ProviderRuntimeSettingsSchema.safeParse(settings).success).toBe(false);
      expect(ProviderOverrideSchema.safeParse(settings).success).toBe(false);
      expect(
        MutableDaemonConfigPatchSchema.safeParse({ providers: { omp: settings } }).success,
      ).toBe(false);
    },
  );

  test("rejects unsupported backend values rather than silently selecting CLI", () => {
    const settings = { ompBackend: "node" };
    expect(ProviderRuntimeSettingsSchema.safeParse(settings).success).toBe(false);
    expect(ProviderOverrideSchema.safeParse(settings).success).toBe(false);
    expect(MutableDaemonConfigPatchSchema.safeParse({ providers: { omp: settings } }).success).toBe(
      false,
    );
  });
});

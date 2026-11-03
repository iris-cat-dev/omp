import { describe, expect, test } from "vitest";
import {
  ProviderOverrideSchema,
  ProviderRuntimeSettingsSchema,
  ProxyPolicySchema,
} from "./provider-config.js";
import { MutableDaemonConfigPatchSchema } from "./messages.js";

describe("SDK proxy configuration boundaries", () => {
  test("preserves disabled policies and arbitrary model-provider routes", () => {
    const proxyPolicy = {
      enabled: false,
      default: { mode: "proxy", url: "http://127.0.0.1:7890" },
      providers: { "custom/model-provider": { mode: "direct" } },
      noProxy: ["internal.example"],
    };
    expect(ProxyPolicySchema.parse(proxyPolicy)).toEqual(proxyPolicy);
    expect(ProviderRuntimeSettingsSchema.parse({ proxyPolicy })).toEqual({ proxyPolicy });
    expect(ProviderOverrideSchema.parse({ proxyPolicy })).toEqual({ proxyPolicy });
    expect(MutableDaemonConfigPatchSchema.parse({ providers: { omp: { proxyPolicy } } })).toEqual({ providers: { omp: { proxyPolicy } } });
  });

  test("rejects malformed policies at public configuration boundaries", () => {
    const proxyPolicy = { enabled: true, default: { mode: "proxy", url: "not-a-url" } };
    expect(ProviderRuntimeSettingsSchema.safeParse({ proxyPolicy }).success).toBe(false);
    expect(ProviderOverrideSchema.safeParse({ proxyPolicy }).success).toBe(false);
    expect(MutableDaemonConfigPatchSchema.safeParse({ providers: { omp: { proxyPolicy } } }).success).toBe(false);
  });

  test.each([
    "ftp://proxy.example", "http://proxy.example/path", "https://proxy.example/?query=1",
    "http://proxy.example/#fragment", "http://%XX:password@proxy.example", "http://user:%FF@proxy.example",
  ])("rejects SDK-incompatible proxy URL %s", (url) => {
    const proxyPolicy = { enabled: true, default: { mode: "proxy", url } };
    expect(ProxyPolicySchema.safeParse(proxyPolicy).success).toBe(false);
    expect(MutableDaemonConfigPatchSchema.safeParse({ providers: { omp: { proxyPolicy } } }).success).toBe(false);
  });

  test("accepts encoded credentials and normalizes nonempty bypass rules", () => {
    expect(ProxyPolicySchema.parse({ enabled: true, default: { mode: "proxy", url: "https://user%40example:p%3Ass@proxy.example:8443/" }, noProxy: [" internal.example "] }).noProxy).toEqual(["internal.example"]);
    expect(ProxyPolicySchema.safeParse({ enabled: false, noProxy: [" "] }).success).toBe(false);
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

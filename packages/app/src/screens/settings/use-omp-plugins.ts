import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type {
  OmpPluginDoctorCheck,
  OmpPluginInfo,
  OmpPluginMarketplaceCatalogEntry,
  OmpPluginMarketplaceInfo,
} from "@omp-desktop/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import type { PluginPageState } from "./plugins-page-state";
import { getMarketplacePluginState } from "./marketplace-plugin-state";

type PluginScope = "user" | "project";
type PluginNotice = "applied" | "preview" | "catalogRefreshed" | null;

// Native OMP reserves these suffixes for npm, even if a catalog has that name.
const npmDistTags: Partial<Record<string, true>> = {
  latest: true,
  next: true,
  beta: true,
  alpha: true,
  canary: true,
  rc: true,
  dev: true,
  stable: true,
  nightly: true,
  experimental: true,
};

interface PluginContext {
  serverId: string;
  cwd?: string;
  client: DaemonClient | null;
  connected: boolean;
  active: boolean;
  epoch: number;
  locked: boolean;
  load: Promise<boolean> | null;
}

interface PluginState {
  context: PluginContext;
  plugins: OmpPluginInfo[];
  marketplaces: OmpPluginMarketplaceInfo[];
  pageState: PluginPageState;
  error: string | null;
  output: string | null;
  notice: PluginNotice;
  operation: string | null;
  doctorChecks: OmpPluginDoctorCheck[] | null;
}

function initialState(context: PluginContext): PluginState {
  return {
    context,
    plugins: [],
    marketplaces: [],
    pageState: context.connected && context.client ? "loading" : "offline",
    error: null,
    output: null,
    notice: null,
    operation: null,
    doctorChecks: null,
  };
}

export function getPluginOperationId(plugin: OmpPluginInfo): string {
  return plugin.id ?? plugin.name;
}

export function getPluginRowId(plugin: OmpPluginInfo): string {
  return `${getPluginOperationId(plugin)}:${plugin.scope ?? "default"}`;
}

/** Distinguishes registered marketplace references from npm and local sources. */
export function isOmpMarketplaceSpec(
  source: string,
  marketplaces: readonly OmpPluginMarketplaceInfo[],
): boolean {
  const match = /^([^@/\\:\s]+)@([^@/\\:\s]+)$/.exec(source.trim());
  const marketplaceName = match?.[2];
  return (
    !!marketplaceName &&
    npmDistTags[marketplaceName] !== true &&
    !/^[\d~^>=<]/.test(marketplaceName) &&
    marketplaces.some((entry) => entry.name === marketplaceName)
  );
}

/** Native OMP disk configuration, scoped to the selected host and project. */
export function useOmpPlugins(serverId: string, cwd?: string) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const hostConnected = useHostRuntimeIsConnected(serverId);
  const connected = !!serverId && hostConnected;
  const context = useMemo<PluginContext>(
    () => ({ serverId, cwd, client, connected, active: true, epoch: 0, locked: false, load: null }),
    [serverId, cwd, client, connected],
  );
  const currentContext = useRef(context);
  if (currentContext.current !== context) {
    currentContext.current.active = false;
    currentContext.current = context;
  }
  const [storedState, setState] = useState(() => initialState(context));
  // Changing context must hide old installations before effects or pending RPCs run.
  const state = storedState.context === context ? storedState : initialState(context);
  if (state !== storedState) setState(state);

  const isCurrent = useCallback(
    () => context.active && currentContext.current === context,
    [context],
  );
  const publish = useCallback(
    (patch: Partial<Omit<PluginState, "context">>) => {
      if (!isCurrent()) return;
      setState((previous) => (previous.context === context ? { ...previous, ...patch } : previous));
    },
    [context, isCurrent],
  );

  const load = useCallback(async (): Promise<boolean> => {
    if (!isCurrent() || !client || !connected) return false;
    if (context.load) return context.load;
    const epoch = context.epoch;
    const valid = () => isCurrent() && context.epoch === epoch;
    const run = (async () => {
      publish({ pageState: "loading", ...(!context.locked ? { error: null } : {}) });
      let installedLoaded = false;
      let nextPageState: PluginPageState = "error";
      let listError: string | null = null;
      try {
        const result = await client.listOmpPlugins(cwd);
        if (!valid()) return false;
        listError = result.plugins.length === 0 && result.rawOutput ? result.rawOutput : null;
        installedLoaded = listError === null;
        nextPageState = listError ? "error" : result.plugins.length ? "ready" : "empty";
        publish({
          plugins: result.plugins,
          ...(listError ? { error: listError } : !context.locked ? { error: null } : {}),
        });
      } catch (error) {
        if (!valid()) return false;
        listError = toErrorMessage(error);
        publish({ error: listError });
      }
      // A catalog failure must not discard a successfully read installed list.
      try {
        if (!valid()) return false;
        const result = await client.listOmpPluginMarketplaces(cwd);
        if (!valid()) return false;
        if (result.rawOutput) throw new Error(result.rawOutput);
        publish({ marketplaces: result.marketplaces });
      } catch (error) {
        if (!valid()) return false;
        const marketplaceError = toErrorMessage(error);
        publish({ error: listError ? `${listError}\n${marketplaceError}` : marketplaceError });
      }
      if (valid()) publish({ pageState: nextPageState });
      return valid() && installedLoaded;
    })();
    context.load = run;
    try {
      return await run;
    } finally {
      if (context.load === run) context.load = null;
    }
  }, [client, connected, context, cwd, isCurrent, publish]);

  useEffect(() => {
    context.active = true;
    void load();
    return () => {
      context.active = false;
      context.epoch += 1;
      context.load = null;
      context.locked = false;
    };
  }, [context, load]);

  const runOperation = useCallback(
    async (key: string, action: (valid: () => boolean) => Promise<boolean>): Promise<boolean> => {
      if (!client || !connected || !isCurrent() || context.locked || context.load) return false;
      const epoch = context.epoch;
      const valid = () => isCurrent() && context.epoch === epoch;
      context.locked = true;
      publish({ operation: key, error: null, notice: null });
      try {
        const succeeded = await action(valid);
        return valid() && succeeded;
      } catch (error) {
        if (valid()) publish({ error: toErrorMessage(error) });
        return false;
      } finally {
        if (valid()) {
          context.locked = false;
          publish({ operation: null });
        }
      }
    },
    [client, connected, context, isCurrent, publish],
  );

  const confirmInstall = useCallback(
    (spec: string) =>
      confirmDialog({
        title: t("plugins.trustTitle"),
        message: `${t("plugins.ompSource")}: ${spec}\n\n${t("settings.host.ompPlugins.trustWarning")}`,
        confirmLabel: t("plugins.trustInstall"),
        cancelLabel: t("common.actions.cancel"),
        destructive: false,
      }),
    [t],
  );

  const toggle = useCallback(
    (plugin: OmpPluginInfo, enabled: boolean) =>
      runOperation(getPluginRowId(plugin), async (valid) => {
        if (!client) return false;
        if (plugin.scope === "project" && !cwd)
          throw new Error(t("settings.host.ompPlugins.scope.hint"));
        const result = await client.setOmpPluginEnabled(
          getPluginOperationId(plugin),
          enabled,
          plugin.scope,
          cwd,
        );
        if (!valid()) return false;
        publish({ output: result.output ?? null });
        if (!result.ok)
          throw new Error(
            result.output ||
              t("settings.host.ompPlugins.feedback.toggleFailed", { id: plugin.name }),
          );
        publish({ notice: "applied" });
        return load();
      }),
    [client, cwd, load, publish, runOperation, t],
  );

  const remove = useCallback(
    (plugin: OmpPluginInfo) =>
      runOperation(getPluginRowId(plugin), async (valid) => {
        if (!client) return false;
        if (plugin.scope === "project" && !cwd)
          throw new Error(t("settings.host.ompPlugins.scope.hint"));
        const confirmed = await confirmDialog({
          title: t("settings.host.ompPlugins.removeConfirmTitle", {
            id: getPluginOperationId(plugin),
          }),
          message: t("settings.host.ompPlugins.removeConfirmMessage", {
            scope: t(
              plugin.scope === "project"
                ? "settings.host.ompPlugins.scope.project"
                : "settings.host.ompPlugins.scope.user",
            ),
            cwd: cwd ?? t("settings.host.ompPlugins.context.user"),
          }),
          confirmLabel: t("settings.host.ompPlugins.actions.remove"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed || !valid()) return false;
        const result = await client.removeOmpPlugin(
          getPluginOperationId(plugin),
          plugin.scope,
          cwd,
        );
        if (!valid()) return false;
        publish({ output: result.output ?? null });
        if (!result.ok)
          throw new Error(
            result.output ||
              t("settings.host.ompPlugins.feedback.removeFailed", { id: plugin.name }),
          );
        publish({ notice: "applied" });
        return load();
      }),
    [client, cwd, load, publish, runOperation, t],
  );

  const upgrade = useCallback(
    (plugin: OmpPluginInfo) => {
      if (plugin.linked) return Promise.resolve(false);
      return runOperation(getPluginRowId(plugin), async (valid) => {
        if (!client) return false;
        if (plugin.scope === "project" && !cwd)
          throw new Error(t("settings.host.ompPlugins.scope.hint"));
        const result = await client.upgradeOmpPlugin(
          getPluginOperationId(plugin),
          plugin.scope,
          cwd,
        );
        if (!valid()) return false;
        publish({ output: result.output ?? null });
        if (!result.ok)
          throw new Error(
            result.output ||
              t("settings.host.ompPlugins.feedback.upgradeFailed", { id: plugin.name }),
          );
        publish({ notice: "applied" });
        return load();
      });
    },
    [client, cwd, load, publish, runOperation, t],
  );

  const install = useCallback(
    (source: string, scope: PluginScope = "user", dryRun = false): Promise<boolean> => {
      const spec = source.trim();
      if (!spec) return Promise.resolve(false);
      const marketplaceSpec = isOmpMarketplaceSpec(spec, state.marketplaces);
      return runOperation("install", async (valid) => {
        if (!client) return false;
        if (marketplaceSpec && scope === "project" && !cwd)
          throw new Error(t("settings.host.ompPlugins.scope.hint"));
        if (!dryRun && (!(await confirmInstall(spec)) || !valid())) return false;
        publish({ output: null });
        const result = await client.installOmpPlugin({
          spec,
          dryRun,
          cwd,
          ...(marketplaceSpec ? { scope } : {}),
        });
        if (!valid()) return false;
        publish({ output: result.output ?? null });
        if (!result.ok)
          throw new Error(
            result.output || t("settings.host.ompPlugins.feedback.installFailed", { id: spec }),
          );
        publish({ notice: dryRun ? "preview" : "applied" });
        return dryRun ? false : load();
      });
    },
    [client, confirmInstall, cwd, load, publish, runOperation, state.marketplaces, t],
  );

  const installMarketplace = useCallback(
    (
      plugin: OmpPluginMarketplaceCatalogEntry,
      marketplaceName: string,
      scope: PluginScope,
    ): Promise<boolean> => {
      const { installed, updateAvailable } = getMarketplacePluginState(
        plugin,
        marketplaceName,
        state.plugins,
        scope,
      );
      const spec = `${plugin.name}@${marketplaceName}`;
      return runOperation(
        installed ? getPluginRowId(installed) : `${spec}:${scope}`,
        async (valid) => {
          if (!client) return false;
          if (scope === "project" && !cwd)
            throw new Error(t("settings.host.ompPlugins.scope.hint"));
          if (installed && (!updateAvailable || installed.linked)) return false;
          if (!installed && (!(await confirmInstall(spec)) || !valid())) return false;
          const result = installed
            ? await client.upgradeOmpPlugin(getPluginOperationId(installed), installed.scope, cwd)
            : await client.installOmpPlugin({ spec, scope, cwd });
          if (!valid()) return false;
          publish({ output: result.output ?? null });
          if (!result.ok)
            throw new Error(
              result.output ||
                t(
                  installed
                    ? "settings.host.ompPlugins.feedback.upgradeFailed"
                    : "settings.host.ompPlugins.feedback.installFailed",
                  { id: spec },
                ),
            );
          publish({ notice: "applied" });
          return load();
        },
      );
    },
    [client, confirmInstall, cwd, load, publish, runOperation, state.plugins, t],
  );

  const readMarketplaces = useCallback(
    async (valid: () => boolean): Promise<boolean> => {
      if (!client || !valid()) return false;
      const result = await client.listOmpPluginMarketplaces(cwd);
      if (!valid()) return false;
      if (result.rawOutput) throw new Error(result.rawOutput);
      publish({ marketplaces: result.marketplaces });
      return true;
    },
    [client, cwd, publish],
  );

  const addMarketplace = useCallback(
    (input: string): Promise<boolean> => {
      const source = input.trim();
      if (!source) return Promise.resolve(false);
      return runOperation("marketplace", async (valid) => {
        if (!client) return false;
        const result = await client.addOmpPluginMarketplace(source, cwd);
        if (!valid()) return false;
        publish({ output: result.output ?? null });
        if (!result.ok)
          throw new Error(
            result.output || t("settings.host.ompPlugins.marketplace.feedback.addFailed"),
          );
        if (!(await readMarketplaces(valid))) return false;
        publish({ notice: "catalogRefreshed" });
        return true;
      });
    },
    [client, cwd, publish, readMarketplaces, runOperation, t],
  );

  const removeMarketplace = useCallback(
    (name: string) =>
      runOperation("marketplace", async (valid) => {
        if (!client) return false;
        const result = await client.removeOmpPluginMarketplace(name, cwd);
        if (!valid()) return false;
        publish({ output: result.output ?? null });
        if (!result.ok)
          throw new Error(
            result.output ||
              t("settings.host.ompPlugins.marketplace.feedback.removeFailed", { id: name }),
          );
        if (!(await readMarketplaces(valid))) return false;
        publish({ notice: "catalogRefreshed" });
        return true;
      }),
    [client, cwd, publish, readMarketplaces, runOperation, t],
  );

  const refreshMarketplace = useCallback(
    (name: string) =>
      runOperation("marketplace", async (valid) => {
        if (!client) return false;
        const result = await client.updateOmpPluginMarketplace(name, cwd);
        if (!valid()) return false;
        publish({ output: result.output ?? null });
        if (!result.ok)
          throw new Error(
            result.output ||
              t("settings.host.ompPlugins.marketplace.feedback.refreshFailed", { id: name }),
          );
        if (!(await readMarketplaces(valid))) return false;
        publish({ notice: "catalogRefreshed" });
        return true;
      }),
    [client, cwd, publish, readMarketplaces, runOperation, t],
  );

  const doctor = useCallback(
    (fix: boolean) =>
      runOperation("doctor", async (valid) => {
        if (!client) return false;
        const result = await client.runOmpPluginDoctor(fix, cwd);
        if (!valid()) return false;
        publish({
          doctorChecks: result.checks.length ? result.checks : null,
          output: result.rawOutput ?? null,
        });
        if (fix) {
          publish({ notice: "applied" });
          return load();
        }
        return true;
      }),
    [client, cwd, load, publish, runOperation],
  );

  return {
    plugins: state.plugins,
    marketplaces: state.marketplaces,
    pageState: state.pageState,
    error: state.error,
    output: state.output,
    notice: state.notice,
    operation: state.operation,
    controlsDisabled:
      !connected || !client || state.pageState === "loading" || state.operation !== null,
    doctorChecks: state.doctorChecks,
    load,
    toggle,
    remove,
    upgrade,
    install,
    installMarketplace,
    addMarketplace,
    removeMarketplace,
    refreshMarketplace,
    doctor,
  };
}

import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { OpenFileDisposition } from "@/workspace/file-open";
import { openExternalUrl } from "@/utils/open-external-url";
import { getDesktopHost } from "@/desktop/host";
import { isSystemAssistantPath, type InlinePathTarget } from "./parse";
import {
  useAssistantFileLinkResolverContext,
  type AssistantFileLinkResolverContextValue,
} from "./provider";
import {
  classifyForResolution,
  fetchDaemonResolution,
  UnresolvedFileLinkError,
  type AssistantFileLinkResolution,
  type AssistantFileLinkSource,
} from "./resolver";

export interface UseFileLinkResult {
  target: InlinePathTarget | null;
  externalUrl: string | null;
  canOpen: boolean;
  onHoverIn: () => void;
  onPress: () => void;
  open: (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => void;
}

export interface AssistantFileLinkActions {
  open(source: AssistantFileLinkSource, disposition: OpenFileDisposition): void;
  canOpen(source: AssistantFileLinkSource): boolean;
  canResolveFile(source: AssistantFileLinkSource): boolean;
}

type AssistantFileLinkQueryKey = readonly [
  "assistantFileLink",
  string | null,
  string | null,
  string,
];

const DISABLED_QUERY_KEY = ["assistantFileLink", null, null, ""] as const;

export function useFileLink(source: AssistantFileLinkSource): UseFileLinkResult {
  const { t } = useTranslation();
  const context = useAssistantFileLinkResolverContext();
  const queryClient = useQueryClient();
  const stableSource = useStableSource(source);
  const activeConfig = context.configRef.current;
  const workspaceRoot = activeConfig.workspaceRoot;
  const serverId = activeConfig.serverId;
  const localDaemon = context.localDaemon;
  const canOpen = useMemo(
    () => canOpenAssistantFileLink(stableSource, workspaceRoot, localDaemon),
    [stableSource, workspaceRoot, localDaemon],
  );
  const resolution = useMemo(
    () =>
      classifyForResolution(stableSource, {
        workspaceRoot,
      }),
    [stableSource, workspaceRoot],
  );
  const queryKey = useMemo(
    () =>
      resolution.kind === "needsLookup"
        ? assistantFileLinkQueryKey({
            serverId,
            workspaceRoot,
            ambiguousQuery: resolution.ambiguousQuery,
          })
        : DISABLED_QUERY_KEY,
    [resolution, serverId, workspaceRoot],
  );

  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (resolution.kind !== "needsLookup") {
        throw new Error("Assistant file link lookup requested for a sync link.");
      }
      return fetchDaemonResolution({
        ambiguousQuery: resolution.ambiguousQuery,
        token: resolution.token,
        target: resolution.target,
        workspaceRoot,
        getDirectorySuggestions: context.getDirectorySuggestions,
      });
    },
    enabled: false,
    retry: 0,
    staleTime: Infinity,
  });

  const open = useStableEvent(
    (nextSource: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      openAssistantFileLink({
        source: nextSource,
        disposition,
        context,
        queryClient,
        localDaemon,
        formatNoFileFoundMessage: (token) => t("common.errors.noFileFound", { token }),
        formatOpenFailedMessage: (token, reason) =>
          t("common.errors.linkOpenFailed", { token, reason }),
        formatUnsupportedMessage: (token) => t("common.errors.unsupportedLink", { token }),
      });
    },
  );

  const onHoverIn = useStableEvent(() => {
    if (!canOpen || resolution.kind !== "needsLookup") {
      return;
    }

    void queryClient.prefetchQuery({
      queryKey,
      queryFn: () =>
        fetchDaemonResolution({
          ambiguousQuery: resolution.ambiguousQuery,
          token: resolution.token,
          target: resolution.target,
          workspaceRoot,
          getDirectorySuggestions: context.getDirectorySuggestions,
        }),
      retry: 0,
      staleTime: Infinity,
    });
  });

  const onPress = useStableEvent(() => {
    open(stableSource, "side");
  });

  const target = useMemo(() => {
    if (resolution.kind === "resolved") {
      return resolution.value.kind === "file" ? resolution.value.target : null;
    }
    return query.data ?? null;
  }, [query.data, resolution]);

  const externalUrl =
    resolution.kind === "resolved" && resolution.value.kind === "external"
      ? resolution.value.url
      : null;
  return useMemo(
    () => ({ target, externalUrl, onHoverIn, onPress, open, canOpen }),
    [target, externalUrl, onHoverIn, onPress, open, canOpen],
  );
}

export function useAssistantFileLinkActions(): AssistantFileLinkActions {
  const context = useAssistantFileLinkResolverContext();
  const actionLink = useFileLink(ACTION_LINK_SOURCE);

  const open = useStableEvent(
    (source: AssistantFileLinkSource, disposition: OpenFileDisposition) => {
      actionLink.open(source, disposition);
    },
  );
  const canOpen = useCallback(
    (source: AssistantFileLinkSource) =>
      canOpenAssistantFileLink(
        source,
        context.configRef.current.workspaceRoot,
        context.localDaemon,
      ),
    [context],
  );
  const canResolveFile = useCallback(
    (source: AssistantFileLinkSource) =>
      canResolveAssistantFileLinkToFile(source, context.configRef.current.workspaceRoot),
    [context.configRef],
  );

  return useMemo(() => ({ open, canOpen, canResolveFile }), [open, canOpen, canResolveFile]);
}

function openAssistantFileLink(input: {
  source: AssistantFileLinkSource;
  disposition: OpenFileDisposition;
  context: AssistantFileLinkResolverContextValue;
  queryClient: QueryClient;
  localDaemon: boolean;
  formatNoFileFoundMessage: (token: string) => string;
  formatOpenFailedMessage: (token: string, reason: string) => string;
  formatUnsupportedMessage: (token: string) => string;
}): void {
  const capturedConfig = input.context.configRef.current;
  const capturedResolution = classifyForResolution(input.source, {
    workspaceRoot: capturedConfig.workspaceRoot,
  });
  const reportError = (reason: string) => {
    const current = input.context.configRef.current;
    if (
      current.serverId !== capturedConfig.serverId ||
      current.workspaceRoot !== capturedConfig.workspaceRoot
    )
      return;
    current.toast?.show(input.formatOpenFailedMessage(input.source.href, reason), {
      variant: "error",
      testID: "assistant-file-link-open-error-toast",
    });
  };

  if (!canOpenAssistantFileLink(input.source, capturedConfig.workspaceRoot, input.localDaemon)) {
    capturedConfig.toast?.show(input.formatUnsupportedMessage(input.source.href), {
      variant: "error",
      testID: "assistant-file-link-unsupported-toast",
    });
    return;
  }

  if (capturedResolution.kind === "resolved") {
    void dispatchResolvedLink({
      resolution: capturedResolution,
      disposition: input.disposition,
      capturedServerId: capturedConfig.serverId,
      capturedWorkspaceRoot: capturedConfig.workspaceRoot,
      context: input.context,
      localDaemon: input.localDaemon,
    }).catch((error: unknown) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
    return;
  }

  const capturedQueryKey = assistantFileLinkQueryKey({
    serverId: capturedConfig.serverId,
    workspaceRoot: capturedConfig.workspaceRoot,
    ambiguousQuery: capturedResolution.ambiguousQuery,
  });

  const run = async () => {
    try {
      const target = await input.queryClient.fetchQuery({
        queryKey: capturedQueryKey,
        queryFn: () =>
          fetchDaemonResolution({
            ambiguousQuery: capturedResolution.ambiguousQuery,
            token: capturedResolution.token,
            target: capturedResolution.target,
            workspaceRoot: capturedConfig.workspaceRoot,
            getDirectorySuggestions: input.context.getDirectorySuggestions,
          }),
        retry: 0,
        staleTime: Infinity,
      });
      await dispatchFileTarget({
        target,
        disposition: input.disposition,
        capturedServerId: capturedConfig.serverId,
        capturedWorkspaceRoot: capturedConfig.workspaceRoot,
        context: input.context,
        localDaemon: input.localDaemon,
      });
    } catch (error) {
      if (error instanceof UnresolvedFileLinkError) {
        dispatchUnresolvedError({
          noFileFoundMessage: input.formatNoFileFoundMessage(capturedResolution.token),
          capturedServerId: capturedConfig.serverId,
          capturedWorkspaceRoot: capturedConfig.workspaceRoot,
          context: input.context,
        });
      } else {
        reportError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  void run();
}

function canOpenAssistantFileLink(
  source: AssistantFileLinkSource,
  workspaceRoot: string | undefined,
  localDaemon: boolean,
): boolean {
  const resolution = classifyForResolution(source, { workspaceRoot });
  let target: InlinePathTarget;
  if (resolution.kind === "needsLookup") {
    target = resolution.target;
  } else if (resolution.value.kind === "file") {
    target = resolution.value.target;
  } else {
    return resolution.value.kind === "external";
  }
  if (!isSystemAssistantPath(target)) return true;
  const root = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = target.path.replace(/\\/g, "/");
  const normalizeCase = (value: string) => (/^[A-Za-z]:/.test(value) ? value.toLowerCase() : value);
  return Boolean(
    localDaemon &&
    root &&
    getDesktopHost()?.opener?.openPath &&
    normalizeCase(path).startsWith(`${normalizeCase(root ?? "")}/`),
  );
}

function canResolveAssistantFileLinkToFile(
  source: AssistantFileLinkSource,
  workspaceRoot: string | undefined,
): boolean {
  const resolution = classifyForResolution(source, { workspaceRoot });
  return resolution.kind === "needsLookup" || resolution.value.kind === "file";
}

function useStableSource(source: AssistantFileLinkSource): AssistantFileLinkSource {
  const { href, text, title, markup, sourceInfo, sourceType } = source;
  return useMemo(
    () => ({ href, text, title, markup, sourceInfo, sourceType }),
    [href, text, title, markup, sourceInfo, sourceType],
  );
}

function assistantFileLinkQueryKey(input: {
  serverId?: string;
  workspaceRoot?: string;
  ambiguousQuery: string;
}): AssistantFileLinkQueryKey {
  return [
    "assistantFileLink",
    input.serverId ?? null,
    input.workspaceRoot ?? null,
    input.ambiguousQuery,
  ];
}

async function dispatchResolvedLink(input: {
  resolution: Extract<AssistantFileLinkResolution, { kind: "resolved" }>;
  disposition: OpenFileDisposition;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
  localDaemon: boolean;
}) {
  const { value } = input.resolution;
  if (value.kind === "file") {
    await dispatchFileTarget({
      target: value.target,
      disposition: input.disposition,
      capturedServerId: input.capturedServerId,
      capturedWorkspaceRoot: input.capturedWorkspaceRoot,
      context: input.context,
      localDaemon: input.localDaemon,
    });
    return;
  }
  if (value.kind === "external") {
    await dispatchExternalUrl({
      url: value.url,
      capturedServerId: input.capturedServerId,
      capturedWorkspaceRoot: input.capturedWorkspaceRoot,
      context: input.context,
    });
  }
}

async function dispatchFileTarget(input: {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
  localDaemon: boolean;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  if (isSystemAssistantPath(input.target)) {
    if (!input.localDaemon || !input.capturedWorkspaceRoot) {
      throw new Error("Local desktop file opening is unavailable.");
    }
    const opener = getDesktopHost()?.opener?.openPath;
    if (!opener) throw new Error("Local desktop file opening is unavailable.");
    await opener({ path: input.target.path, workspaceRoot: input.capturedWorkspaceRoot });
    return;
  }
  current.onOpenWorkspaceFile?.(input.target, input.disposition);
}

async function dispatchExternalUrl(input: {
  url: string;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  await openExternalUrl(input.url);
}

async function dispatchUnresolvedError(input: {
  noFileFoundMessage: string;
  capturedServerId?: string;
  capturedWorkspaceRoot?: string;
  context: AssistantFileLinkResolverContextValue;
}) {
  const current = input.context.configRef.current;
  if (
    current.serverId !== input.capturedServerId ||
    current.workspaceRoot !== input.capturedWorkspaceRoot
  ) {
    return;
  }
  current.toast?.show(input.noFileFoundMessage, {
    variant: "error",
    testID: "assistant-file-link-not-found-toast",
  });
}

const ACTION_LINK_SOURCE: AssistantFileLinkSource = {
  href: "",
};

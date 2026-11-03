import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { filePreviewRenderKind } from "@/components/file-pane-render-mode";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { FilePanelBar } from "@/file-pane/bar";
import { FileHtmlPreview } from "@/file-pane/html-preview";
import { FileMarkdownPreview } from "@/file-pane/markdown-preview";
import { FileSourceView } from "@/file-pane/source/view";
import {
  useLocalFilePreviewStore,
  type LocalFilePreviewStore,
  type LocalFilePreviewEntry,
} from "./local-file-preview-store";

export function LocalFilePreview({ previewId }: { previewId: string }) {
  const { t } = useTranslation();
  const selectEntry = useCallback(
    (state: LocalFilePreviewStore) => state.entries[previewId],
    [previewId],
  );
  const entry = useLocalFilePreviewStore(selectEntry);
  const name = entry?.name ?? "";
  const onModeChange = useCallback(
    (mode: "preview" | "source") => {
      useLocalFilePreviewStore.getState().setMode(previewId, mode);
    },
    [previewId],
  );
  useEffect(() => {
    void useLocalFilePreviewStore.getState().load(previewId);
  }, [previewId]);

  const result = entry?.result;
  const content = result?.status === "ready" ? result.content : undefined;
  const lineCount = useMemo(() => {
    if (content === undefined) return undefined;
    let count = 1;
    for (let index = 0; index < content.length; index++) {
      if (content.charCodeAt(index) === 10) count++;
    }
    return count;
  }, [content]);

  return (
    <View style={styles.root} testID="local-file-preview">
      {entry ? (
        <FilePanelBar
          size={entry.file?.size ?? 0}
          lineCount={lineCount}
          mode={entry.mode}
          onModeChange={onModeChange}
          showTreeToggle={false}
        />
      ) : null}
      <View style={styles.metadata}>
        {entry ? (
          <Text selectable numberOfLines={1} style={styles.fileName}>
            {name || t("externalFilePreview.unnamed")}
          </Text>
        ) : null}
        <Text style={styles.localOnly} testID="local-file-preview-local-only">
          {t("externalFilePreview.localOnly")}
        </Text>
      </View>
      <View style={styles.content}>
        <LocalPreviewBody entry={entry} previewId={previewId} content={content} />
      </View>
      {content === "" ? (
        <Text style={styles.empty} testID="local-file-preview-empty">
          {t("externalFilePreview.empty")}
        </Text>
      ) : null}
    </View>
  );
}

function LocalPreviewBody({
  entry,
  previewId,
  content,
}: {
  entry: LocalFilePreviewEntry | undefined;
  previewId: string;
  content: string | undefined;
}) {
  const { t } = useTranslation();
  const theme = UnistylesRuntime.getTheme();
  const name = entry?.name ?? "";
  const location = useMemo(() => ({ path: name }), [name]);
  const visualTheme = useMemo(
    () => ({
      colorScheme: theme.colorScheme,
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      cursor: theme.colors.terminal.cursor,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
      syntax: theme.colors.syntax,
    }),
    [theme],
  );
  const result = entry?.result;
  const error = entry?.error ?? (result?.status === "error" ? result.error : undefined);
  if (!entry) {
    return (
      <View style={styles.centerState} testID="local-file-preview-expired">
        <Text accessibilityRole="alert" style={styles.message}>
          {t("externalFilePreview.expired")}
        </Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centerState} testID={`local-file-preview-error-${error}`}>
        <Text accessibilityRole="alert" style={styles.message}>
          {t(`externalFilePreview.errors.${error}`)}
        </Text>
      </View>
    );
  }
  if (content === undefined) {
    return (
      <View style={styles.centerState} testID="local-file-preview-loading">
        <LoadingSpinner color={theme.colors.foregroundMuted} />
        <Text style={styles.message}>{t("externalFilePreview.loading")}</Text>
      </View>
    );
  }
  const renderKind = filePreviewRenderKind(name);
  if (entry.mode === "preview" && renderKind === "markdown") {
    return (
      <ScrollView
        style={styles.markdownScroll}
        showsVerticalScrollIndicator
        testID="local-file-preview-markdown-scroll"
      >
        <FileMarkdownPreview source={content} />
      </ScrollView>
    );
  }
  if (entry.mode === "preview" && renderKind === "html") {
    return <FileHtmlPreview html={content} testID="local-file-preview-html" />;
  }
  return (
    <FileSourceView
      key={previewId}
      content={content}
      filename={name}
      location={location}
      navigationRevision={0}
      size={entry.file?.size ?? 0}
      theme={visualTheme}
      tooLargeMessage={t("externalFilePreview.errors.tooLarge")}
      workspaceRoot=""
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, minWidth: 0, backgroundColor: theme.colors.surface0 },
  content: { flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" },
  markdownScroll: { flex: 1, minHeight: 0, minWidth: 0 },
  metadata: { padding: theme.spacing[3], gap: theme.spacing[1] },
  fileName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  localOnly: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  message: { color: theme.colors.foregroundMuted, textAlign: "center" },
}));

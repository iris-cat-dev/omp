import { useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Platform, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { isNative, isWeb } from "@/constants/platform";
import { MarkdownTextSpan } from "@/components/markdown-text";
import { MarkdownLinkText } from "@/components/markdown/link-text";
import { colorMarkdownLinkChildren } from "@/components/markdown/link-children";
import { ompBrandColors } from "@/styles/theme";
import { AssistantLinkPressProvider, type AssistantLinkPress } from "./link-press-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { markdownCopyDataSet } from "@/assistant-selection-copy/markup";
import { useAssistantFileLinkResolverContext } from "./provider";
import type { AssistantFileLinkSource } from "./resolver";
import { useFileLink } from "./use-file-link";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getDesktopHost } from "@/desktop/host";

interface AssistantMarkdownLinkProps {
  source: AssistantFileLinkSource;
  style: StyleProp<TextStyle>;
  monoSurface?: boolean;
  children: ReactNode;
}

const MARKDOWN_CODE_LINK_DATASET = {
  ...CODE_SURFACE_DATASET,
  ...markdownCopyDataSet.code,
} as const;

export function AssistantMarkdownLink({
  source,
  style,
  monoSurface,
  children,
}: AssistantMarkdownLinkProps) {
  const { t } = useTranslation();
  const { target, externalUrl, onHoverIn, onPress, canOpen, canReveal, onContextMenu } =
    useFileLink(source);
  const { configRef } = useAssistantFileLinkResolverContext();
  const workspaceRoot = configRef.current.workspaceRoot;
  const tooltipPath = useMemo(
    () => (target ? formatInlinePathTargetForTooltip(target, workspaceRoot) : null),
    [target, workspaceRoot],
  );
  const linkPress = useMemo<AssistantLinkPress>(
    () => ({ onPress, accessibilityRole: canOpen ? "link" : undefined }),
    [onPress, canOpen],
  );
  const unwrapForMarkdownCopy = source.sourceType === "inline-code" || source.markup === "linkify";
  const isAnchor = isWeb && source.href.startsWith("#") && source.href.length > 1;
  const interactive = canOpen || isAnchor;
  const textStyle = interactive ? style : [style, styles.unsupportedText];
  const content = colorMarkdownLinkChildren(
    children,
    interactive ? styles.linkColor.color : styles.unsupportedText.color,
  );
  const handleClick = useStableEvent((event: MouseEvent<HTMLAnchorElement>) => {
    if (isAnchor || event.button !== 0) return;
    event.preventDefault();
    onPress();
  });
  const handleAuxClick = useStableEvent((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 1 || isAnchor) return;
    event.preventDefault();
    onPress();
  });
  const handleContextMenu = useStableEvent((event: MouseEvent<HTMLAnchorElement>) => {
    if (canReveal) {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu();
      return;
    }
    const showContextMenu = getDesktopHost()?.menu?.showContextMenu;
    if (!externalUrl || !showContextMenu) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void showContextMenu({
      kind: "assistant-http-link",
      url: externalUrl,
      openExternalLabel: t("contextMenu.openExternal"),
      copyAddressLabel: t("contextMenu.copyAddress"),
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      configRef.current.toast?.show(
        t("common.errors.linkOpenFailed", { token: externalUrl, reason }),
        { variant: "error" },
      );
    });
  });

  if (isNative) {
    // Must be a MarkdownTextSpan, not a plain <Text>: on iOS the link renders
    // inside the paragraph's native UITextView, and a plain <Text> nested there
    // is not hoisted into a UITextViewChild, so its text is silently dropped
    // (the link disappears). The span composes correctly and stays selectable.
    //
    // Tap-to-open: react-native-uitextview only wires onPress onto the *string*
    // children it turns into RNUITextViewChild nodes — the element children that
    // markdown emits for link text pass through untouched, so an onPress placed
    // here never reaches a tappable native node. We thread it down through
    // AssistantLinkPressProvider so each leaf text span re-attaches it to its
    // own string children, where the native tap recognizer can find it. iOS
    // only: Android forwards onPress through nested <Text> already, and web uses
    // the <a> path below.
    const span = (
      <MarkdownTextSpan
        accessibilityRole={interactive ? "link" : undefined}
        monoSurface={monoSurface}
        onPress={onPress}
        style={textStyle}
      >
        {content}
      </MarkdownTextSpan>
    );
    return (
      <FileLinkHoverTooltip filePath={tooltipPath}>
        {Platform.OS === "ios" ? (
          <AssistantLinkPressProvider value={linkPress}>{span}</AssistantLinkPressProvider>
        ) : (
          span
        )}
      </FileLinkHoverTooltip>
    );
  }

  if (!interactive) {
    return (
      <span onClickCapture={onPress} style={LINK_ANCHOR_STYLE}>
        <Text dataSet={monoSurface ? MARKDOWN_CODE_LINK_DATASET : undefined} style={textStyle}>
          {content}
        </Text>
      </span>
    );
  }

  const anchor = (
    <a
      {...(unwrapForMarkdownCopy ? { "data-paseo-markdown-unwrap": "true" } : {})}
      href={source.href}
      title={source.title}
      onClickCapture={handleClick}
      onAuxClickCapture={handleAuxClick}
      onContextMenu={handleContextMenu}
      style={LINK_ANCHOR_STYLE}
    >
      {isAnchor ? (
        <Text dataSet={monoSurface ? MARKDOWN_CODE_LINK_DATASET : undefined} style={textStyle}>
          {content}
        </Text>
      ) : (
        <MarkdownLinkText
          dataSet={monoSurface ? MARKDOWN_CODE_LINK_DATASET : undefined}
          style={textStyle}
          onHoverIn={onHoverIn}
        >
          {content}
        </MarkdownLinkText>
      )}
    </a>
  );

  return <FileLinkHoverTooltip filePath={tooltipPath}>{anchor}</FileLinkHoverTooltip>;
}

interface AssistantMarkdownCodeLinkProps {
  source: AssistantFileLinkSource;
  inheritedStyles: TextStyle;
  codeInlineStyle: TextStyle;
  linkStyle: TextStyle;
  children: ReactNode;
}

export function AssistantMarkdownCodeLink({
  source,
  inheritedStyles,
  codeInlineStyle,
  linkStyle,
  children,
}: AssistantMarkdownCodeLinkProps) {
  const style = useMemo(
    () => [inheritedStyles, codeInlineStyle, linkStyle],
    [inheritedStyles, codeInlineStyle, linkStyle],
  );
  return (
    <AssistantMarkdownLink source={source} style={style} monoSurface>
      {children}
    </AssistantMarkdownLink>
  );
}

function formatInlinePathTargetForTooltip(
  target: { path: string; lineStart?: number; lineEnd?: number },
  workspaceRoot: string | undefined,
): string {
  let result = relativizePathToWorkspace(target.path, workspaceRoot);
  if (target.lineStart) {
    result += `:${target.lineStart}`;
    if (target.lineEnd && target.lineEnd !== target.lineStart) {
      result += `-${target.lineEnd}`;
    }
  }
  return result;
}

function relativizePathToWorkspace(filePath: string, workspaceRoot: string | undefined): string {
  if (!workspaceRoot) {
    return filePath;
  }
  const root = workspaceRoot.replace(/\/+$/, "");
  if (!root) {
    return filePath;
  }
  if (filePath === root) {
    return ".";
  }
  const prefix = `${root}/`;
  if (filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length);
  }
  return filePath;
}

interface AssistantInlineCodePathLinkProps {
  content: string;
  inheritedStyles: TextStyle;
  codeInlineStyle: TextStyle;
  linkStyle: TextStyle;
}

export function AssistantInlineCodePathLink({
  content,
  inheritedStyles,
  codeInlineStyle,
  linkStyle,
}: AssistantInlineCodePathLinkProps) {
  const source = useMemo<AssistantFileLinkSource>(
    () => ({
      href: content,
      text: content,
      sourceType: "inline-code",
    }),
    [content],
  );

  return (
    <AssistantMarkdownCodeLink
      source={source}
      inheritedStyles={inheritedStyles}
      codeInlineStyle={codeInlineStyle}
      linkStyle={linkStyle}
    >
      {content}
    </AssistantMarkdownCodeLink>
  );
}

const FILE_LINK_TOOLTIP_TRIGGER_STYLE: ViewStyle = {
  // RN doesn't type "inline-flex" but RN-web honors it at runtime, which keeps
  // the tooltip wrapper from breaking inline link flow.
  display: "inline-flex" as ViewStyle["display"],
};

function FileLinkHoverTooltip({
  filePath,
  children,
}: {
  filePath: string | null;
  children: ReactNode;
}) {
  if (!isWeb) {
    return children;
  }
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <View style={FILE_LINK_TOOLTIP_TRIGGER_STYLE}>{children}</View>
      </TooltipTrigger>
      {filePath ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {filePath}
          </Text>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}

const LINK_ANCHOR_STYLE: CSSProperties = {
  display: "contents",
  color: "inherit",
  textDecoration: "none",
};

const styles = StyleSheet.create((theme) => ({
  unsupportedText: {
    color: theme.colors.foreground,
    textDecorationLine: "none",
  },
  linkColor: {
    color: theme.colorScheme === "dark" ? ompBrandColors.cyan : ompBrandColors.cyanOnLight,
  },
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

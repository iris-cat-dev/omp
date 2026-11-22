import { useMemo, type ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import Markdown, { type ASTNode } from "react-native-markdown-display";
import { ListTodo } from "lucide-react-native";
import { StyleSheet, useUnistyles, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { getMarkdownFenceLanguage } from "@/components/markdown/fence/language";
import { MarkdownTextSpan } from "@/components/markdown-text";
import { createPlanMarkdownStyles } from "@/styles/markdown-styles";
import type { Theme } from "@/styles/theme";
import { getMarkdownListMarker } from "@/utils/markdown-list";

type MarkdownRuleStyles = Record<string, TextStyle & ViewStyle & { [key: string]: unknown }>;

function MarkdownInlineText({
  inheritedStyle,
  ruleStyle,
  monoSurface,
  children,
}: {
  inheritedStyle: StyleProp<TextStyle>;
  ruleStyle: StyleProp<TextStyle>;
  monoSurface?: boolean;
  children: ReactNode;
}) {
  const style = useMemo(() => [inheritedStyle, ruleStyle], [inheritedStyle, ruleStyle]);
  return (
    <MarkdownTextSpan style={style} monoSurface={monoSurface}>
      {children}
    </MarkdownTextSpan>
  );
}

function MarkdownListItemContent({
  contentStyle,
  children,
}: {
  contentStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const style = useMemo(() => [contentStyle, LIST_ITEM_CONTENT_INNER], [contentStyle]);
  return <View style={style}>{children}</View>;
}

function MarkdownParagraph({
  paragraphStyle,
  isLastChild,
  children,
}: {
  paragraphStyle: StyleProp<ViewStyle>;
  isLastChild: boolean;
  children: ReactNode;
}) {
  const style = useMemo<StyleProp<ViewStyle>>(
    () => [paragraphStyle, isLastChild ? PARAGRAPH_LAST_CHILD : null],
    [paragraphStyle, isLastChild],
  );
  return <View style={style}>{children}</View>;
}

function createPlanMarkdownRules() {
  return {
    text: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText key={node.key} inheritedStyle={inheritedStyles} ruleStyle={styles.text}>
        {node.content}
      </MarkdownInlineText>
    ),
    textgroup: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText
        key={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.textgroup}
      >
        {children}
      </MarkdownInlineText>
    ),
    code_block: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <HighlightedCodeBlock
        key={node.key}
        code={node.content}
        language={null}
        inheritedStyles={inheritedStyles}
        textStyle={styles.code_block}
      />
    ),
    fence: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <HighlightedCodeBlock
        key={node.key}
        code={node.content}
        language={getMarkdownFenceLanguage(node.sourceInfo)}
        inheritedStyles={inheritedStyles}
        textStyle={styles.fence}
      />
    ),
    code_inline: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText
        key={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.code_inline}
        monoSurface
      >
        {node.content}
      </MarkdownInlineText>
    ),
    bullet_list: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => (
      <View key={node.key} style={styles.bullet_list}>
        {children}
      </View>
    ),
    ordered_list: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => (
      <View key={node.key} style={styles.ordered_list}>
        {children}
      </View>
    ),
    list_item: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => {
      const { isOrdered, marker } = getMarkdownListMarker(node, parent);
      const iconStyle = isOrdered ? styles.ordered_list_icon : styles.bullet_list_icon;
      const contentStyle = isOrdered ? styles.ordered_list_content : styles.bullet_list_content;

      return (
        <View key={node.key} style={styles.list_item}>
          <Text style={iconStyle}>{marker}</Text>
          <MarkdownListItemContent contentStyle={contentStyle}>{children}</MarkdownListItemContent>
        </View>
      );
    },
    paragraph: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => {
      const isLastChild = parent[0]?.children?.at(-1)?.key === node.key;
      return (
        <MarkdownParagraph
          key={node.key}
          paragraphStyle={styles.paragraph}
          isLastChild={isLastChild}
        >
          {children}
        </MarkdownParagraph>
      );
    },
  };
}

const ThemedListTodo = withUnistyles(ListTodo);
const planIconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export function PlanCard({
  title,
  description,
  status,
  text,
  children,
  footer,
  disableOuterSpacing = false,
  testID,
}: {
  title?: string;
  description?: string;
  status?: string;
  text?: string;
  children?: ReactNode;
  footer?: ReactNode;
  disableOuterSpacing?: boolean;
  testID?: string;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const markdownStyles = createPlanMarkdownStyles(theme);
  const markdownRules = createPlanMarkdownRules();
  const resolvedTitle = title ?? t("agentStream.permission.plan");

  const containerStyle = useMemo(
    () => [styles.container, disableOuterSpacing && styles.containerCompact],
    [disableOuterSpacing],
  );

  return (
    <View testID={testID} style={containerStyle}>
      <View style={styles.header}>
        <View style={styles.iconSurface}>
          <ThemedListTodo size={16} strokeWidth={1.8} uniProps={planIconColorMapping} />
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{resolvedTitle}</Text>
          {description ? <Text style={styles.description}>{description}</Text> : null}
        </View>
        {status ? (
          <View style={styles.statusBadge}>
            <Text style={styles.statusText}>{status}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.body}>
        {children ?? (
          <Markdown style={markdownStyles} rules={markdownRules}>
            {text ?? ""}
          </Markdown>
        )}
      </View>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  containerCompact: {
    marginVertical: 0,
  },
  header: {
    minHeight: 52,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  iconSurface: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  statusBadge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 16,
  },
  body: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  footer: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
}));

const LIST_ITEM_CONTENT_INNER = { flex: 1, flexShrink: 1, minWidth: 0 };
const PARAGRAPH_LAST_CHILD = { marginBottom: 0 };

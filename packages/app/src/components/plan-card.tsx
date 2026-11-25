import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ListTodo } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import type { Theme } from "@/styles/theme";

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
  const { t } = useTranslation();
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
        {children ?? <MarkdownRenderer text={text ?? ""} variant="plan" />}
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

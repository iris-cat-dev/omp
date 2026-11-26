import { memo, useEffect, useState, type ComponentProps } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, TriangleAlertIcon } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { proseLineHeight } from "@/styles/markdown-styles";
import type { Theme } from "@/styles/theme";
import type { AssistantMessage } from "./message";
import type { AuthenticationErrorDetails } from "./authentication-error";

const WarningIcon = withUnistyles(TriangleAlertIcon);
const ExpandedIcon = withUnistyles(ChevronDown);
const CollapsedIcon = withUnistyles(ChevronRight);
const warningColor = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingVertical: theme.spacing[3],
  },
  compactTop: { paddingTop: 0 },
  compactBottom: { paddingBottom: 0 },
  notice: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.statusWarning,
    paddingLeft: theme.spacing[4],
    gap: theme.spacing[2],
  },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: proseLineHeight(theme.fontSize.content),
  },
  provider: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  description: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: proseLineHeight(theme.fontSize.content),
  },
  guidance: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: proseLineHeight(theme.fontSize.base),
  },
  disclosure: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  disclosureText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  details: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: proseLineHeight(theme.fontSize.code),
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
}));

export const AuthenticationErrorMessage = memo(function AuthenticationErrorMessage({
  error,
  spacing = "default",
}: {
  error: AuthenticationErrorDetails;
  spacing?: ComponentProps<typeof AssistantMessage>["spacing"];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [error.details]);
  const Chevron = expanded ? ExpandedIcon : CollapsedIcon;
  const detailsLabel = t("authenticationError.details");

  return (
    <View
      style={[
        styles.container,
        (spacing === "compactTop" || spacing === "compactBoth") && styles.compactTop,
        (spacing === "compactBottom" || spacing === "compactBoth") && styles.compactBottom,
      ]}
      testID="authentication-error-message"
    >
      <View style={styles.notice}>
        <View accessibilityRole="alert">
          <View style={styles.heading}>
            <WarningIcon size={16} uniProps={warningColor} />
            <Text style={styles.title} selectable>
              {t(`authenticationError.title.${error.kind === "missing" ? "missing" : "refresh"}`)}
            </Text>
            {error.provider ? <Text style={styles.provider}>{error.provider}</Text> : null}
          </View>
          <Text style={styles.description} selectable>
            {t(`authenticationError.description.${error.kind}`)}
          </Text>
        </View>
        <Text style={styles.guidance} selectable>
          {t(
            `authenticationError.guidance.${
              error.kind === "missing" ? "login" : error.kind === "region" ? "region" : "connection"
            }`,
          )}
        </Text>
        <Pressable
          style={styles.disclosure}
          accessibilityRole="button"
          accessibilityLabel={detailsLabel}
          accessibilityState={{ expanded }}
          aria-expanded={expanded}
          onPress={() => setExpanded((current) => !current)}
          testID="authentication-error-details-toggle"
        >
          <Chevron size={12} uniProps={mutedColor} />
          <Text style={styles.disclosureText}>{detailsLabel}</Text>
        </Pressable>
        {expanded ? (
          <Text style={styles.details} selectable testID="authentication-error-details">
            {error.details}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

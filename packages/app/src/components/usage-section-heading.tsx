import { ChevronDown, ChevronUp, type LucideIcon } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

export function UsageSectionHeading({
  icon: Icon,
  title,
  value,
  expanded,
  onPress,
  testID,
  iconColor,
}: {
  icon: LucideIcon;
  title: string;
  value?: string;
  expanded?: boolean;
  onPress?: () => void;
  testID?: string;
  iconColor?: string;
}) {
  const { theme } = useUnistyles();
  const Chevron = expanded ? ChevronUp : ChevronDown;
  const content = (
    <>
      <View aria-hidden style={styles.iconTile}>
        <Icon size={theme.iconSize.md} color={iconColor ?? theme.colors.foregroundMuted} />
      </View>
      <View style={styles.labels}>
        <Text style={styles.title}>{title}</Text>
        {value ? <Text style={styles.value}>{value}</Text> : null}
      </View>
      {onPress ? (
        <View aria-hidden>
          <Chevron size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
        </View>
      ) : null}
    </>
  );
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${title} ${value}` : title}
      accessibilityState={{ expanded }}
      aria-expanded={expanded}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: theme.spacing[8],
    borderRadius: theme.borderRadius.md,
  },
  pressed: { backgroundColor: theme.colors.surface2 },
  iconTile: {
    height: 28,
    width: 28,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  labels: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: theme.spacing[2],
    rowGap: theme.spacing[0.5],
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  value: {
    flexShrink: 1,
    marginStart: "auto",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
}));

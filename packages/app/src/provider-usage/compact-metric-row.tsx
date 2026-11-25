import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

export function CompactMetricRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text selectable style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

const wrappingText = {
  maxWidth: "100%" as const,
  ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
};

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: theme.spacing[2],
    rowGap: theme.spacing[0.5],
  },
  label: {
    ...wrappingText,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  value: {
    ...wrappingText,
    marginStart: "auto",
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
}));

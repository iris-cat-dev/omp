import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { VisualFeedbackEditorProps } from "./types";
export type { VisualFeedbackEditorProps } from "./types";

export function VisualFeedbackEditor({ request, onCancel }: VisualFeedbackEditorProps) {
  const { t } = useTranslation();
  const header = useMemo(
    () => ({ title: request.title || t("visualFeedback.title") }),
    [request.title, t],
  );
  return (
    <AdaptiveModalSheet visible onClose={onCancel} header={header}>
      <View style={styles.content}>
        <Text style={styles.message}>{t("visualFeedback.unsupported")}</Text>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: 24 },
  message: { color: theme.colors.foreground },
}));

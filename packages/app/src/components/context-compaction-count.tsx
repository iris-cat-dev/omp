import { Text, type StyleProp, type TextStyle } from "react-native";
import { useTranslation } from "react-i18next";

interface ContextCompactionCountProps {
  count: number | null | undefined;
  style: StyleProp<TextStyle>;
}

export function ContextCompactionCount({ count, style }: ContextCompactionCountProps) {
  const { t } = useTranslation();
  if (count == null) return null;
  return <Text style={style}>{t("contextWindow.compactionCount", { count })}</Text>;
}

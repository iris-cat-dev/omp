import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { searchPluginAttachments } from "@omp-desktop/plugin/host";
import type { PluginAttachmentItem } from "@omp-desktop/plugin";
import type { ExternalTextComposerAttachment } from "@/attachments/types";
import type { AttachmentMenuItem } from "@/composer/input/input";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { AttachmentFrame, AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/utils/open-external-url";
import { usePluginContributions } from "./hooks";
import { resolvePluginIcon } from "./icons";

export function usePluginAttachmentPicker({ hostId, disabled, onAttach }: { hostId: string; disabled: boolean; onAttach: (attachment: ExternalTextComposerAttachment) => void }) {
  const contributions = usePluginContributions("attachment");
  const sources = useMemo(() => contributions.filter(({ instance }) => instance.installation.owner === "desktop" || instance.hostId === hostId), [contributions, hostId]);
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PluginAttachmentItem[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("ready");
  const [error, setError] = useState<string | null>(null);
  const selected = sources.find((entry) => entry.key === selectedKey);
  const close = useCallback(() => setSelectedKey(null), []);
  useEffect(() => { setSelectedKey(null); }, [hostId]);
  useEffect(() => {
    if (!selectedKey) return;
    let cancelled = false;
    setItems([]); setError(null);
    if (!selected) { setStatus("unavailable"); return; }
    setStatus("loading");
    const timer = setTimeout(() => {
      void searchPluginAttachments(selected.contribution, selected.instance.invoke, query).then((result) => {
        if (cancelled || selected.instance.scope.signal.aborted) return;
        setItems(result.items); setStatus("ready");
      }).catch((failure) => {
        if (!cancelled && !selected.instance.scope.signal.aborted) { setError(failure instanceof Error ? failure.message : String(failure)); setStatus("ready"); }
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [selectedKey, selected?.instance, selected?.contribution, query]);
  const menuItems = useMemo<AttachmentMenuItem[]>(() => sources.map(({ key, instance, contribution }) => {
    const Icon = resolvePluginIcon(contribution.icon);
    return { id: key, label: contribution.title, icon: <Icon size={16} color={theme.colors.foregroundMuted} />, disabled,
      onSelect() { instance.scope.assertCurrent(); setQuery(""); setSelectedKey(key); },
    };
  }), [sources, disabled, theme.colors.foregroundMuted]);
  const picker = <AdaptiveModalSheet visible={selectedKey !== null} onClose={close} testID="plugin-attachment-picker" header={{ title: selected?.contribution.pickerTitle ?? t("plugins.unavailable"), search: selected ? { onChange: setQuery, resetKey: selectedKey ?? undefined, placeholder: selected.contribution.searchPlaceholder, autoFocus: true, testID: "plugin-attachment-search" } : undefined }}>
    <View style={{ gap: 8 }}>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {status === "unavailable" ? <Text style={styles.hint}>{t("plugins.unavailable")}</Text> : null}
      {status === "loading" ? <Text style={styles.hint}>{t("plugins.attachments.searching")}</Text> : null}
      {status === "ready" && !error && !items.length ? <Text style={styles.hint}>{t("plugins.attachments.empty")}</Text> : null}
      {selected && items.map((item) => <Pressable key={item.id} disabled={disabled} accessibilityRole="button" testID={`plugin-attachment-result-${item.id}`} style={styles.row} onPress={() => {
        selected.instance.scope.assertCurrent();
        onAttach({ kind: "external_text", id: JSON.stringify([selected.instance.installation.owner, selected.instance.hostId, selected.instance.installation.id, selected.contribution.id, item.id]), title: item.title, subtitle: item.subtitle, text: item.text,
          externalResource: { provider: `${selected.instance.installation.id}/${selected.contribution.id}`, providerLabel: selected.contribution.title, resourceType: item.resourceType, id: item.id, identifier: item.identifier, title: item.title, url: item.url } });
        close();
      }}><Text style={styles.title}>{item.identifier} · {item.title}</Text>{item.subtitle ? <Text style={styles.hint}>{item.subtitle}</Text> : null}</Pressable>)}
    </View>
  </AdaptiveModalSheet>;
  return { menuItems, picker };
}

export function ExternalTextAttachmentPill({ attachment, index, disabled, onRemove }: { attachment: ExternalTextComposerAttachment; index: number; disabled: boolean; onRemove: (index: number) => void }) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  return <>
    <AttachmentPill testID="composer-external-text-attachment-pill" disabled={disabled} onOpen={() => setOpen(true)} onRemove={() => onRemove(index)} openAccessibilityLabel={attachment.title} removeAccessibilityLabel={t("plugins.attachments.remove")}>
      <AttachmentLabel title={attachment.externalResource.identifier} subtitle={attachment.title} />
    </AttachmentPill>
    <ExternalTextAttachmentPreview title={attachment.title} text={attachment.text} externalResource={attachment.externalResource} visible={open} onClose={() => setOpen(false)} />
  </>;
}

interface ExternalTextSnapshotProps {
  title: string;
  text: string;
  externalResource: ExternalTextComposerAttachment["externalResource"];
}

function ExternalTextAttachmentPreview({ title, text, externalResource, visible, onClose }: ExternalTextSnapshotProps & { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return <AdaptiveModalSheet visible={visible} onClose={onClose} testID="plugin-attachment-preview" header={{ title, subtitle: externalResource.providerLabel }} footer={<Button variant="outline" onPress={() => openExternalUrl(externalResource.url)}>{t("plugins.attachments.openSource")}</Button>}>
    <Text selectable style={styles.text}>{text}</Text>
  </AdaptiveModalSheet>;
}

export function ExternalTextAttachmentFrame({ title, text, externalResource, children }: ExternalTextSnapshotProps & { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <>
    <AttachmentFrame onPress={() => setOpen(true)} accessibilityLabel={title}>{children}</AttachmentFrame>
    <ExternalTextAttachmentPreview title={title} text={text} externalResource={externalResource} visible={open} onClose={() => setOpen(false)} />
  </>;
}

const styles = StyleSheet.create((theme) => ({
  row: { paddingVertical: theme.spacing[3], gap: theme.spacing[1], borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));

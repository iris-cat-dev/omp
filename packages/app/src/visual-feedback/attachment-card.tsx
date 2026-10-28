import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { MessageSquareCode } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  VisualFeedbackAttachmentImage,
  VisualFeedbackComposerAttachment,
} from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { AttachmentLightbox } from "@/components/attachment-lightbox";
import { AttachmentLabel, AttachmentPill, AttachmentThumbnail } from "@/components/attachment-pill";
import { Button } from "@/components/ui/button";
import { ICON_SIZE, type Theme } from "@/styles/theme";

interface VisualFeedbackAttachmentPillProps {
  attachment: VisualFeedbackComposerAttachment;
  index: number;
  disabled?: boolean;
  onOpen: (attachment: VisualFeedbackComposerAttachment) => void;
  onRemove: (index: number) => void;
}

export function VisualFeedbackAttachmentPill({
  attachment,
  index,
  disabled,
  onOpen,
  onRemove,
}: VisualFeedbackAttachmentPillProps) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => onOpen(attachment), [attachment, onOpen]);
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  const image = attachment.preview ?? attachment.image;
  const annotationSummary = t("visualFeedback.attachmentSummary", {
    count: attachment.annotations.length,
  });
  const summary =
    attachment.feedback.trim() ||
    attachment.annotations.find((annotation) => annotation.text.trim())?.text.trim() ||
    attachment.text.trim() ||
    annotationSummary;

  return (
    <AttachmentPill
      onOpen={handleOpen}
      onRemove={handleRemove}
      disabled={disabled}
      openAccessibilityLabel={`${t("visualFeedback.attachmentOpen")}: ${summary} · ${annotationSummary}`}
      removeAccessibilityLabel={t("visualFeedback.attachmentRemove")}
      testID={`visual-feedback-attachment-${index}`}
    >
      <View style={styles.pillBody}>
        {image ? <AttachmentThumbnail metadata={image.metadata} /> : null}
        <AttachmentLabel
          icon={image ? undefined : feedbackIcon}
          title={t("visualFeedback.menuLabel")}
          subtitle={summary}
        />
      </View>
    </AttachmentPill>
  );
}

interface VisualFeedbackAttachmentPreviewProps {
  attachment: VisualFeedbackComposerAttachment | null;
  onClose: () => void;
}

export function VisualFeedbackAttachmentPreview({
  attachment,
  onClose,
}: VisualFeedbackAttachmentPreviewProps) {
  const { t } = useTranslation();
  const annotationCount = attachment?.annotations.length ?? 0;
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("visualFeedback.menuLabel"),
      subtitle: (
        <Text style={styles.subtitle}>
          {t("visualFeedback.attachmentPending")} ·{" "}
          {t("visualFeedback.attachmentSummary", { count: annotationCount })}
        </Text>
      ),
    }),
    [annotationCount, t],
  );
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          onPress={onClose}
          testID="visual-feedback-preview-close"
        >
          {t("visualFeedback.closePreview")}
        </Button>
      </View>
    ),
    [onClose, t],
  );

  return (
    <AdaptiveModalSheet
      visible={attachment !== null}
      onClose={onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={900}
      testID="visual-feedback-attachment-preview"
    >
      {attachment ? <PreviewContent key={attachment.id} attachment={attachment} /> : null}
    </AdaptiveModalSheet>
  );
}

function PreviewContent({ attachment }: { attachment: VisualFeedbackComposerAttachment }) {
  const { t } = useTranslation();
  const [imageOpen, setImageOpen] = useState(false);
  const openImage = useCallback(() => setImageOpen(true), []);
  const closeImage = useCallback(() => setImageOpen(false), []);
  const image = attachment.preview ?? attachment.image;
  const imageLabel = t(
    attachment.preview ? "visualFeedback.annotatedImage" : "visualFeedback.originalImage",
  );

  return (
    <>
      {attachment.text.trim() ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t("visualFeedback.text")}</Text>
          <Text selectable style={styles.body}>
            {attachment.text}
          </Text>
        </View>
      ) : null}
      {attachment.feedback.trim() ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t("visualFeedback.feedback")}</Text>
          <Text selectable style={styles.body}>
            {attachment.feedback}
          </Text>
        </View>
      ) : null}
      {image ? (
        <View style={styles.section}>
          <View style={styles.imageHeading}>
            <Text style={styles.heading}>{imageLabel}</Text>
            <Text style={styles.subtitle}>
              {image.width} × {image.height}
            </Text>
          </View>
          <PreviewImage
            key={image.metadata.id}
            image={image}
            label={imageLabel}
            onOpen={openImage}
          />
        </View>
      ) : null}
      {attachment.annotations.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t("visualFeedback.notes")}</Text>
          {attachment.annotations.map((annotation, index) => (
            <View key={annotation.id} style={styles.note}>
              <View style={styles.noteNumber}>
                <Text style={styles.noteNumberText}>{index + 1}</Text>
              </View>
              <View style={styles.noteContent}>
                <Text style={styles.noteKind}>{t(`visualFeedback.${annotation.kind}`)}</Text>
                {annotation.text.trim() ? (
                  <Text selectable style={styles.body}>
                    {annotation.text}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <AttachmentLightbox
        metadata={imageOpen && image ? image.metadata : null}
        onClose={closeImage}
      />
    </>
  );
}

function PreviewImage({
  image,
  label,
  onOpen,
}: {
  image: VisualFeedbackAttachmentImage;
  label: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const uri = useAttachmentPreviewUrl(image.metadata);
  const [errored, setErrored] = useState(false);
  const handleError = useCallback(() => setErrored(true), []);
  const source = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  const imageStyle = useMemo(
    () => [styles.image, { aspectRatio: image.width / image.height }],
    [image.height, image.width],
  );

  return (
    <Pressable
      onPress={onOpen}
      disabled={!uri || errored}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.imageFrame}
      testID="visual-feedback-preview-image"
    >
      {errored && <Text style={styles.imageError}>{t("message.attachments.imageLoadFailed")}</Text>}
      {!errored && uri && (
        <Image
          source={source}
          style={imageStyle}
          contentFit="contain"
          accessibilityLabel={label}
          onError={handleError}
        />
      )}
      {!errored && !uri && <View style={imageStyle} />}
    </Pressable>
  );
}

const ThemedMessageSquareCode = withUnistyles(MessageSquareCode);
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const feedbackIcon = (
  <ThemedMessageSquareCode size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
);

const styles = StyleSheet.create((theme) => ({
  pillBody: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface1,
  },
  section: {
    gap: theme.spacing[3],
  },
  heading: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
  imageHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  imageFrame: {
    overflow: "hidden",
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface0,
  },
  image: {
    width: "100%",
    maxHeight: 480,
  },
  imageError: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  note: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  noteNumber: {
    minWidth: 24,
    minHeight: 24,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  noteNumberText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  noteContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  noteKind: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    width: "100%",
    flexDirection: "row",
    justifyContent: "flex-end",
  },
}));

import { useCallback, useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Check, Film, Image as ImageIcon } from "lucide-react-native";
import type { WallpaperCandidate } from "@omp-desktop/protocol/desktop-wallpaper";
import type { WallpaperThumbnailResult } from "./wallpaper-thumbnail-queue";

export interface WallpaperGridAppearance {
  gap: number;
  nameGap: number;
  fontSize: number;
  fontFamily: string;
  primary: string;
  foreground: string;
  muted: string;
  border: string;
  surface0: string;
  surface2: string;
  radius: number;
  smallRadius: number;
}

const IMAGE_STYLE: CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };

interface CellProps {
  item: WallpaperCandidate;
  index: number;
  column: number;
  preview: WallpaperThumbnailResult | null | undefined;
  applied: boolean;
  selected: boolean;
  managing: boolean;
  disabled: boolean;
  tabbable: boolean;
  textHeight: number;
  appearance: WallpaperGridAppearance;
  buttonRef: (node: HTMLButtonElement | null) => void;
  onFocus: (id: string) => void;
  onActivate: (id: string) => void;
}

function useCellStyles(
  appearance: WallpaperGridAppearance,
  textHeight: number,
  applied: boolean,
  selected: boolean,
  disabled: boolean,
) {
  return useMemo(() => {
    const badge: CSSProperties = {
      position: "absolute",
      top: 3,
      right: 3,
      borderRadius: appearance.smallRadius,
      background: appearance.surface0,
      padding: 2,
      display: "flex",
    };
    return {
      button: {
        width: 96,
        padding: 0,
        border: 0,
        background: "transparent",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        outlineColor: appearance.primary,
      } satisfies CSSProperties,
      cover: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        boxSizing: "border-box",
        width: 96,
        height: 72,
        overflow: "hidden",
        borderRadius: appearance.radius,
        border: `2px solid ${applied ? appearance.primary : appearance.border}`,
        background: appearance.surface2,
      } satisfies CSSProperties,
      placeholder: {
        fontSize: appearance.fontSize,
        padding: 4,
        textAlign: "center",
        color: appearance.muted,
      } satisfies CSSProperties,
      name: {
        display: "block",
        width: 96,
        height: textHeight,
        lineHeight: "1.25",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        overflow: "hidden",
        marginTop: appearance.nameGap,
      } satisfies CSSProperties,
      badge,
      appliedBadge: { ...badge, right: "auto", left: 3 } satisfies CSSProperties,
      selectedBadge: {
        ...badge,
        right: "auto",
        left: 3,
        width: 14,
        height: 14,
        border: `1px solid ${selected ? appearance.primary : appearance.border}`,
      } satisfies CSSProperties,
    };
  }, [appearance, textHeight, applied, selected, disabled]);
}

export function WallpaperCandidateCell({
  item,
  index,
  column,
  preview,
  applied,
  selected,
  managing,
  disabled,
  tabbable,
  textHeight,
  appearance,
  buttonRef,
  onFocus,
  onActivate,
}: CellProps) {
  const { t } = useTranslation();
  const styles = useCellStyles(appearance, textHeight, applied, selected, disabled);
  const handleFocus = useCallback(() => onFocus(item.candidateId), [onFocus, item.candidateId]);
  const handleActivate = useCallback(
    () => onActivate(item.candidateId),
    [onActivate, item.candidateId],
  );
  const kind = t(`settings.appearance.wallpaper.library.${item.kind}`);
  let state = "";
  if (managing && selected) state = t("settings.appearance.wallpaper.library.selected");
  else if (applied) state = t("settings.appearance.wallpaper.library.applied");
  const label = `${item.name}\n${item.path}\n${kind}${state ? ` · ${state}` : ""}`;
  return (
    <div role="gridcell" aria-colindex={column + 1} aria-selected={managing ? selected : applied}>
      <button
        ref={buttonRef}
        type="button"
        data-candidate-id={item.candidateId}
        data-candidate-index={index}
        tabIndex={tabbable ? 0 : -1}
        disabled={disabled}
        aria-label={label}
        aria-pressed={managing ? selected : applied}
        title={label}
        onFocus={handleFocus}
        onClick={handleActivate}
        style={styles.button}
      >
        <span style={styles.cover}>
          {preview?.url ? (
            <img src={preview.url} alt="" draggable={false} style={IMAGE_STYLE} />
          ) : (
            <span style={styles.placeholder}>
              {preview?.failed
                ? t("settings.appearance.wallpaper.library.previewUnavailable")
                : t("settings.appearance.wallpaper.library.previewLoading")}
            </span>
          )}
          <span aria-hidden style={styles.badge}>
            {item.kind === "video" ? (
              <Film size={12} color={appearance.foreground} />
            ) : (
              <ImageIcon size={12} color={appearance.foreground} />
            )}
          </span>
          {applied && !managing ? (
            <span aria-hidden style={styles.appliedBadge}>
              <Check size={12} color={appearance.primary} />
            </span>
          ) : null}
          {managing ? (
            <span aria-hidden style={styles.selectedBadge}>
              {selected ? <Check size={14} color={appearance.primary} /> : null}
            </span>
          ) : null}
        </span>
        <span style={styles.name}>{item.name}</span>
      </button>
    </div>
  );
}

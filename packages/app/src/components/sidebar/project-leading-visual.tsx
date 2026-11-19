import type { ReactNode } from "react";
import { ActivityIndicator, View, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleAlert, Folder, FolderOpen } from "lucide-react-native";
import { ProjectIconView } from "@/components/project-icon-view";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  getProjectStatusBadgeContent,
  type ProjectStatusBadgeContent,
  type ProjectStatusBadgeDotBucket,
} from "@/utils/project-status-badge-content";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import { StatusRing } from "@/components/status-ring";
import { getStatusRingOffset } from "@/components/status-ring/geometry";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";

// Keep the project marker on the same 16px rail as Cursor's repository icon. Status remains a
// small corner signal instead of increasing the row height.
const STATUS_BADGE_SIZE = 8;
const STATUS_BADGE_OFFSET = -2;
const PROJECT_ICON_SIZE = 16;
const LEADING_SLOT_HEIGHT = PROJECT_ICON_SIZE;

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedFolder = withUnistyles(Folder);
const ThemedFolderOpen = withUnistyles(FolderOpen);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const needsInputColorMapping = (theme: Theme) => ({
  color: theme.colors.surface0,
  fill: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
});

/** The folder shows the project's expansion state even while the row is hovered. */
export function ProjectLeadingVisual({
  statusBucket,
  backdrop,
  collapsed,
  isArchiving = false,
}: {
  /** Aggregate status of the project's workspaces; null when it shouldn't be surfaced. */
  statusBucket: SidebarStateBucket | null;
  /** The row's current background, so the status badge can knock out of it. */
  backdrop: SidebarSurfaceBackdrop;
  collapsed: boolean;
  isArchiving?: boolean;
}) {
  if (isArchiving) {
    return (
      <View style={styles.projectLeadingVisualSlot} testID="project-status-indicator-archiving">
        <ThemedActivityIndicator size={8} uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }

  const FolderIcon = collapsed ? ThemedFolder : ThemedFolderOpen;
  return (
    <ProjectStatusFrame statusBucket={statusBucket} backdrop={backdrop}>
      <FolderIcon size={PROJECT_ICON_SIZE} uniProps={foregroundMutedColorMapping} />
    </ProjectStatusFrame>
  );
}

/** Status-grouped conversation rows identify their project with its own icon. */
export function ProjectStatusIndicator({
  iconDataUri,
  displayName,
  projectViewKey,
  statusBucket,
  backdrop,
  loading = false,
  testID,
}: {
  iconDataUri: string | null;
  displayName: string;
  projectViewKey: string;
  statusBucket: SidebarStateBucket | null;
  /** The row's current background, so the status badge can knock out of it. */
  backdrop: SidebarSurfaceBackdrop;
  loading?: boolean;
  testID?: string;
}) {
  const placeholderInitial = projectIconPlaceholderLabelFromDisplayName(displayName)
    .charAt(0)
    .toUpperCase();
  return (
    <ProjectStatusFrame
      statusBucket={statusBucket}
      backdrop={backdrop}
      loading={loading}
      testID={testID}
    >
      <ProjectIconView
        iconDataUri={iconDataUri}
        initial={placeholderInitial}
        projectViewKey={projectViewKey}
        size={PROJECT_ICON_SIZE}
        textStyle={styles.projectIconFallbackText}
      />
    </ProjectStatusFrame>
  );
}

function ProjectStatusFrame({
  children,
  statusBucket,
  backdrop,
  loading = false,
  testID,
}: {
  children: ReactNode;
  statusBucket: SidebarStateBucket | null;
  backdrop: SidebarSurfaceBackdrop;
  loading?: boolean;
  testID?: string;
}) {
  // A row that's still starting up and a row that's working are both "busy", and at this size
  // there's no room to draw the difference — so `loading` just resolves to the running bucket
  // and they share one badge.
  const badgeBucket = loading ? "running" : statusBucket;
  const badgeContent = getProjectStatusBadgeContent(badgeBucket);

  return (
    <View
      style={styles.projectLeadingVisualSlot}
      testID={
        testID ??
        (statusBucket && statusBucket !== "done"
          ? `project-status-indicator-${statusBucket}`
          : "project-icon-only")
      }
    >
      <View style={styles.projectIconBox}>
        {children}
        {badgeContent === null || badgeBucket === null ? null : (
          <ProjectStatusBadge
            content={badgeContent}
            statusBucket={badgeBucket}
            backdrop={backdrop}
          />
        )}
      </View>
    </View>
  );
}

function ProjectStatusBadge({
  content,
  statusBucket,
  backdrop,
}: {
  content: ProjectStatusBadgeContent;
  statusBucket: SidebarStateBucket;
  backdrop: SidebarSurfaceBackdrop;
}) {
  // Running skips the shell. The ring is wider than the 12pt shell and carries its own knockout,
  // so nesting it inside would clip it against the very thing that was meant to separate it from
  // the icon. It anchors to the same corner instead, growing around the centre the dot had.
  if (content.kind === "dot" && content.bucket === "running") {
    return (
      <View
        role="status"
        accessibilityLabel={STATUS_BUCKET_LABELS[statusBucket]}
        style={styles.statusRingAnchor}
        testID="project-status-badge"
      >
        <StatusRing backdrop={backdrop} />
      </View>
    );
  }
  return (
    <View
      role="status"
      accessibilityLabel={STATUS_BUCKET_LABELS[statusBucket]}
      style={[styles.statusBadge, getStatusBadgeBackdropStyle(backdrop)]}
      testID="project-status-badge"
    >
      {content.kind === "alert" ? (
        <ThemedCircleAlert size={STATUS_BADGE_SIZE} uniProps={needsInputColorMapping} />
      ) : (
        <ProjectStatusDot bucket={content.bucket} />
      )}
    </View>
  );
}

function getStatusBadgeBackdropStyle(backdrop: SidebarSurfaceBackdrop): ViewStyle {
  switch (backdrop) {
    case "surfaceSidebar":
      return styles.statusBadgeOnSidebar;
    case "surfaceSidebarHover":
      return styles.statusBadgeOnSidebarHover;
    case "surfaceSidebarSelected":
      return styles.statusBadgeOnSidebarSelected;
    case "surface2":
      return styles.statusBadgeOnSurface2;
  }
}

function ProjectStatusDot({ bucket }: { bucket: ProjectStatusBadgeDotBucket }) {
  return <View testID="project-status-dot" style={getStatusDotColorStyle(bucket)} />;
}

function getStatusDotColorStyle(bucket: ProjectStatusBadgeDotBucket): ViewStyle {
  if (bucket === "failed") return styles.statusDotFailed;
  if (bucket === "running") return styles.statusDotRunning;
  return styles.statusDotAttention;
}

const styles = StyleSheet.create((theme) => {
  // Dot statuses sit *inside* the shell rather than replacing it, so they carry the same ring
  // the alert does. The geometry is shared here and baked into each colored variant so the
  // style prop stays a single stable object; the colors come from the one bucket-to-color map
  // so this badge can't drift from the status dots everywhere else.
  const statusDot = (bucket: ProjectStatusBadgeDotBucket) =>
    ({
      width: STATUS_INDICATOR_FILLED_DOT_SIZE,
      height: STATUS_INDICATOR_FILLED_DOT_SIZE,
      borderRadius: theme.borderRadius.full,
      backgroundColor: getStatusDotColor({ theme, bucket }) ?? undefined,
    }) as const;

  return {
    // The icon owns the full leading slot; increasing it expands the project row naturally.
    projectLeadingVisualSlot: {
      width: PROJECT_ICON_SIZE,
      height: LEADING_SLOT_HEIGHT,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    // Anchors the corner badge to the icon rather than to the taller slot.
    projectIconBox: {
      position: "relative",
      width: PROJECT_ICON_SIZE,
      height: PROJECT_ICON_SIZE,
    },
    projectIconFallbackText: {
      fontSize: 10,
    },
    // The shell the alert and dot statuses share. It straddles the icon's bottom-right corner
    // (half in, half out) so the project icon stays readable. The shell is a knockout:
    // it is filled with the colour of the row behind it, which is what makes the ring around the
    // dot read as a gap in the icon rather than as a white halo drawn on top of it.
    statusBadge: {
      position: "absolute",
      right: STATUS_BADGE_OFFSET,
      bottom: STATUS_BADGE_OFFSET,
      width: STATUS_BADGE_SIZE,
      height: STATUS_BADGE_SIZE,
      borderRadius: theme.borderRadius.full,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    // Same corner as the shell, re-centred for the wider ring.
    statusRingAnchor: {
      position: "absolute",
      right: getStatusRingOffset(STATUS_BADGE_OFFSET, STATUS_BADGE_SIZE),
      bottom: getStatusRingOffset(STATUS_BADGE_OFFSET, STATUS_BADGE_SIZE),
    },
    statusBadgeOnSidebar: { backgroundColor: theme.colors.surfaceSidebar },
    statusBadgeOnSidebarHover: { backgroundColor: theme.colors.surfaceSidebarHover },
    statusBadgeOnSidebarSelected: { backgroundColor: theme.colors.surfaceSidebarSelected },
    statusBadgeOnSurface2: { backgroundColor: theme.colors.surface2 },
    statusDotRunning: statusDot("running"),
    statusDotFailed: statusDot("failed"),
    statusDotAttention: statusDot("attention"),
  };
});

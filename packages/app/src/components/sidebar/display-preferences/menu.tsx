import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Captions,
  Circle,
  CircleCheck,
  CircleDashed,
  EyeOff,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  Hand,
  MonitorSmartphone,
  MousePointer,
  Server,
  Settings2,
  Tag,
} from "lucide-react-native";
import {
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuSubTrigger,
  MenuSurface,
  MenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { TOUCH_LIST_ROW_ACTION_SIZE } from "@/components/ui/control-geometry";
import { HostStatusDot } from "@/components/host-status-dot";
import { isWeb } from "@/constants/platform";
import { useTouchInteraction } from "@/hooks/use-fine-pointer";
import { useHosts } from "@/runtime/host-runtime";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { ProjectIconView } from "@/components/project-icon-view";
import { useProjectIcons } from "@/projects/icons";
import { resolveSidebarProjectIconTargets } from "@/utils/sidebar-project-row-model";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";
import {
  hasActiveSidebarLabelFilter,
  SIDEBAR_UNLABELLED_LABEL_KEY,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import type { TouchInteractionPreference } from "@/utils/device-input";
import {
  workspaceLabelKey,
  type WorkspaceLabelColor,
} from "@omp-desktop/protocol/workspace-labels";
import { SIDEBAR_CHECKS_DISPLAYS, type SidebarChecksDisplay } from "./checks-display";
import { useSidebarDisplayPreferences } from "./model";
import { SIDEBAR_ROW_ITEMS, type SidebarRowItem } from "./row-items";
import { useWorkspaceLabelProjection } from "@/workspace-labels";
import { WorkspaceLabelDot } from "@/workspace-labels/swatch";
import { WorkspaceLabelManagerModal } from "@/workspace-labels/manager-modal";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedSettings2 = withUnistyles(Settings2);
/** CI's mark: the subject of the checks row, and the shape the icon-only option leaves behind. */
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircle = withUnistyles(Circle);

/** Fits the item's 16pt leading slot with a hair of room, matching the trailing check. */
const OPTION_ICON_SIZE = 14;
const MENU_WIDTH = 232;

/**
 * Unlabelled's stand-in for a color dot: the same circle at the same size, hollow.
 *
 * 11 rather than the dot's 10 because lucide draws a `size` box and puts a stroked r=10-of-24
 * circle inside it, so the ring's outer edge lands on the dots' edge at 11 and 1pt short at 10.
 * The glyphs are what have to agree here, not the boxes they are centred in.
 */
const UNLABELLED_MARK = <ThemedCircle size={11} uniProps={mutedIconMapping} />;

type OptionIcon = ComponentType<{
  size: number;
  uniProps: (theme: Theme) => { color: string };
}>;

// Root rows show their current values without competing decorative icons.
const GROUPING_ICONS: Record<SidebarGroupMode, OptionIcon> = {
  project: withUnistyles(Folder),
  status: withUnistyles(CircleDashed),
};

// The same marks these things carry on the workspace row itself, so the menu and the row it
// configures name each item the same way twice.
const ROW_ITEM_ICONS: Record<SidebarRowItem, OptionIcon> = {
  branch: withUnistyles(GitBranch),
  project: withUnistyles(Folder),
  host: withUnistyles(Server),
  changeRequest: withUnistyles(GitPullRequest),
  services: withUnistyles(Globe),
  labels: withUnistyles(Tag),
};

// These mark how much of the row an option spends, not what CI is, so they are the shapes each
// answer produces: a glyph with words beside it, the glyph on its own, nothing.
const CHECKS_DISPLAY_ICONS: Record<SidebarChecksDisplay, OptionIcon> = {
  iconAndText: withUnistyles(Captions),
  icon: ThemedCircleCheck,
  none: withUnistyles(EyeOff),
};

const GROUPING_MODES: readonly SidebarGroupMode[] = ["project", "status"];

const GROUPING_LABEL_KEYS: Record<SidebarGroupMode, string> = {
  project: "sidebar.display.grouping.project",
  status: "sidebar.display.grouping.status",
};

const ROW_ITEM_LABEL_KEYS: Record<SidebarRowItem, string> = {
  branch: "sidebar.display.show.branch",
  project: "sidebar.display.show.project",
  host: "sidebar.display.show.host",
  changeRequest: "sidebar.display.show.changeRequest",
  services: "sidebar.display.show.services",
  labels: "sidebar.display.show.labels",
};

const CHECKS_DISPLAY_LABEL_KEYS: Record<SidebarChecksDisplay, string> = {
  iconAndText: "sidebar.display.checks.iconAndText",
  icon: "sidebar.display.checks.icon",
  none: "sidebar.display.checks.none",
};

const TOUCH_MODES: readonly TouchInteractionPreference[] = ["auto", "on", "off"];

const TOUCH_MODE_ICONS: Record<TouchInteractionPreference, OptionIcon> = {
  auto: withUnistyles(MonitorSmartphone),
  on: withUnistyles(Hand),
  off: withUnistyles(MousePointer),
};

const TOUCH_MODE_LABEL_KEYS: Record<TouchInteractionPreference, string> = {
  auto: "sidebar.display.touchMode.auto",
  on: "sidebar.display.touchMode.on",
  off: "sidebar.display.touchMode.off",
};

/**
 * What the sidebar shows and how it is arranged.
 *
 * The root is one row per decision with its current value; the options live a level down. The
 * shape is deliberate — every option of every decision on one surface is what this menu used to
 * be, and it grew a row for each host on top of that.
 */
export function SidebarDisplayPreferencesMenu(): ReactElement {
  const { t } = useTranslation();
  const isTouchInteraction = useTouchInteraction();
  const preferences = useSidebarDisplayPreferences();
  const hosts = useHosts();
  const { allProjects } = useSidebarModel();
  const { labels } = useWorkspaceLabelProjection();
  const [managerOpen, setManagerOpen] = useState(false);
  const openManager = useCallback(() => setManagerOpen(true), []);
  const closeManager = useCallback(() => setManagerOpen(false), []);

  const triggerStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      isTouchInteraction && styles.triggerTouch,
      ((!isTouchInteraction && hovered) || pressed) && styles.triggerHovered,
    ],
    [isTouchInteraction],
  );

  const showHostFilter = hosts.length > 1;
  // This page is also the recovery path for a hidden project, so even one project is actionable.
  const showProjectFilter = allProjects.length > 0;
  // Nothing to filter by means no row at all. The active-filter half is not redundant: the merged
  // catalog only counts hosts that are online, so a host dropping off would otherwise take away
  // the only way back to a filter that is still hiding workspaces.
  const showLabelFilter = labels.length > 0 || hasActiveSidebarLabelFilter(preferences.labelFilter);

  const pages = useMemo<MenuPageDefinition[]>(() => {
    const definitions: MenuPageDefinition[] = [
      {
        id: "grouping",
        title: t("sidebar.display.grouping.label"),
        content: (
          <OptionList
            values={GROUPING_MODES}
            icons={GROUPING_ICONS}
            labelKeys={GROUPING_LABEL_KEYS}
            selectedValue={preferences.grouping}
            onSelect={preferences.setGrouping}
            testIDPrefix="sidebar-grouping"
          />
        ),
      },
      {
        id: "show",
        title: t("sidebar.display.show.label"),
        content: <ShowPage preferences={preferences} />,
      },
      {
        id: "checks",
        title: t("sidebar.display.show.checks"),
        content: (
          <OptionList
            values={SIDEBAR_CHECKS_DISPLAYS}
            icons={CHECKS_DISPLAY_ICONS}
            labelKeys={CHECKS_DISPLAY_LABEL_KEYS}
            selectedValue={preferences.checksDisplay}
            onSelect={preferences.setChecksDisplay}
            testIDPrefix="sidebar-checks-display"
          />
        ),
      },
      {
        id: "touchMode",
        title: t("sidebar.display.touchMode.label"),
        content: (
          <OptionList
            values={TOUCH_MODES}
            icons={TOUCH_MODE_ICONS}
            labelKeys={TOUCH_MODE_LABEL_KEYS}
            selectedValue={preferences.touchMode}
            onSelect={preferences.setTouchMode}
            testIDPrefix="sidebar-touch-mode"
          />
        ),
      },
    ];

    if (showHostFilter) {
      definitions.push({
        id: "hostFilter",
        title: t("sidebar.display.hostFilter.label"),
        content: <HostFilterPage preferences={preferences} hosts={hosts} />,
      });
    }
    if (showProjectFilter) {
      definitions.push({
        id: "projectFilter",
        title: t("sidebar.display.projectFilter.label"),
        content: <ProjectFilterPage projects={allProjects} preferences={preferences} />,
      });
    }
    if (showLabelFilter) {
      definitions.push({
        id: "labelFilter",
        title: t("workspaceLabels.title"),
        content: (
          <LabelFilterPage labels={labels} preferences={preferences} onManage={openManager} />
        ),
      });
    }
    return definitions;
  }, [
    t,
    preferences,
    hosts,
    showHostFilter,
    showProjectFilter,
    allProjects,
    showLabelFilter,
    labels,
    openManager,
  ]);

  return (
    <>
      <MenuRoot compactMode="sheet">
        <MenuTrigger
          hitSlop={isTouchInteraction ? 4 : undefined}
          style={triggerStyle}
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={t("sidebar.display.trigger")}
          testID="sidebar-display-preferences-menu"
        >
          <ThemedSettings2 size={isTouchInteraction ? 16 : 14} uniProps={mutedIconMapping} />
        </MenuTrigger>
        <MenuSurface
          align="end"
          width={MENU_WIDTH}
          pages={pages}
          sheetTitle={t("sidebar.display.heading")}
          testID="sidebar-display-preferences-content"
        >
          <MenuSubTrigger
            id="grouping"
            value={t(GROUPING_LABEL_KEYS[preferences.grouping])}
            testID="sidebar-display-grouping"
          >
            {t("sidebar.display.grouping.label")}
          </MenuSubTrigger>
          <MenuSubTrigger id="show" testID="sidebar-display-show">
            {t("sidebar.display.show.label")}
          </MenuSubTrigger>
          {showHostFilter ? (
            <>
              <MenuSeparator />
              {/* A filtered sidebar looks like workspaces went missing, so the branch says so
                from the root rather than making you open it to find out. */}
              <MenuSubTrigger
                id="hostFilter"
                indicator={preferences.hostFilters.length > 0}
                testID="sidebar-display-host-filter"
              >
                {t("sidebar.display.hostFilter.label")}
              </MenuSubTrigger>
            </>
          ) : null}
          {showProjectFilter ? (
            <>
              {/* Host and Project narrow the same list, so they read as one block. The separator
                belongs above whichever of the two is showing first — with a single host there is
                no Host row and Project is what has to carry it. */}
              {showHostFilter ? null : <MenuSeparator />}
              <MenuSubTrigger
                id="projectFilter"
                indicator={preferences.hiddenProjectViewKeys.length > 0}
                testID="sidebar-display-project-filter"
              >
                {t("sidebar.display.projectFilter.label")}
              </MenuSubTrigger>
            </>
          ) : null}
          {showLabelFilter ? (
            <>
              <MenuSeparator />
              <MenuSubTrigger
                id="labelFilter"
                indicator={hasActiveSidebarLabelFilter(preferences.labelFilter)}
                testID="sidebar-display-label-filter"
              >
                {t("workspaceLabels.title")}
              </MenuSubTrigger>
            </>
          ) : null}
          <MenuSeparator />
          <MenuSubTrigger
            id="touchMode"
            value={t(TOUCH_MODE_LABEL_KEYS[preferences.touchMode])}
            indicator={preferences.touchMode !== "auto"}
            testID="sidebar-display-touch-mode"
          >
            {t("sidebar.display.touchMode.label")}
          </MenuSubTrigger>
          {isTouchInteraction && preferences.grouping === "project" ? (
            <MenuItem
              selected={preferences.reorderMode}
              onSelect={preferences.toggleReorderMode}
              testID="sidebar-display-reorder"
            >
              {t("sidebar.display.reorder.label")}
            </MenuItem>
          ) : null}
        </MenuSurface>
      </MenuRoot>
      <WorkspaceLabelManagerModal visible={managerOpen} onClose={closeManager} />
    </>
  );
}

/**
 * Every label you could filter by, wherever it lives, one row each.
 *
 * The catalog is the merged cross-host one on purpose: a workspace row draws its label in its own
 * host's color because it would otherwise lie, but this page is the whole set of things to filter
 * on and a per-host split would only make you visit it twice.
 *
 * Clear is absent rather than disabled when it has nothing to act on.
 */
function LabelFilterPage({
  labels,
  preferences,
  onManage,
}: {
  labels: ReturnType<typeof useWorkspaceLabelProjection>["labels"];
  preferences: Preferences;
  onManage: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const selected = preferences.labelFilter.labels;
  return (
    <>
      {labels.map((label) => (
        <LabelFilterItem
          key={workspaceLabelKey(label.name)}
          name={label.name}
          label={label.name}
          color={label.color}
          selected={selected.includes(workspaceLabelKey(label.name))}
          onToggle={preferences.toggleLabelFilter}
          testID={`sidebar-label-filter-option-${label.name}`}
        />
      ))}
      <LabelFilterItem
        name={SIDEBAR_UNLABELLED_LABEL_KEY}
        label={t("workspaceLabels.unlabelled")}
        color={null}
        selected={selected.includes(SIDEBAR_UNLABELLED_LABEL_KEY)}
        onToggle={preferences.toggleLabelFilter}
        testID="sidebar-label-filter-option-unlabelled"
      />
      {hasActiveSidebarLabelFilter(preferences.labelFilter) ? (
        <>
          <MenuSeparator />
          <MenuItem
            closeOnSelect={false}
            onSelect={preferences.clearLabelFilter}
            testID="sidebar-label-filter-clear"
          >
            {t("workspaceLabels.filter.clear")}
          </MenuItem>
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem onSelect={onManage} testID="sidebar-label-manage">
        {t("workspaceLabels.manage.open")}
      </MenuItem>
    </>
  );
}

/**
 * One label: its colour leading, its name, and the engine's own check when it is filtered on.
 *
 * The same row the host filter uses, because it is the same question — one press in, one press
 * out, several at once. Four attempts at giving exclusion a shape in this row are in the branch
 * history; each bought a new awkwardness, because two controls in one 232pt menu row is a lot of
 * machinery for a filter nobody asked to invert.
 */
function LabelFilterItem({
  name,
  label,
  color,
  selected,
  onToggle,
  testID,
}: {
  /** The filter key this row acts on. Empty for Unlabelled — see `SIDEBAR_UNLABELLED_LABEL_KEY`. */
  name: string;
  label: string;
  /** `null` is Unlabelled, the one row with no color to stand for. */
  color: WorkspaceLabelColor | null;
  selected: boolean;
  onToggle: (name: string) => void;
  testID: string;
}): ReactElement {
  const handleSelect = useCallback(() => onToggle(name), [name, onToggle]);
  const leading = useMemo(
    () => (color ? <WorkspaceLabelDot color={color} /> : UNLABELLED_MARK),
    [color],
  );

  return (
    <MenuItem
      selected={selected}
      leading={leading}
      closeOnSelect={false}
      onSelect={handleSelect}
      testID={testID}
    >
      {label}
    </MenuItem>
  );
}

type Preferences = ReturnType<typeof useSidebarDisplayPreferences>;

/** One option row: its mark on the left, its label, and a check when it is the chosen one. */
function OptionItem<Value extends string>({
  value,
  icon: Icon,
  label,
  selected,
  closeOnSelect = true,
  onSelect,
  testID,
}: {
  value: Value;
  icon: OptionIcon;
  label: string;
  selected: boolean;
  closeOnSelect?: boolean;
  onSelect: (value: Value) => void;
  testID: string;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(value), [onSelect, value]);
  const leading = useMemo(
    () => <Icon size={OPTION_ICON_SIZE} uniProps={mutedIconMapping} />,
    [Icon],
  );
  return (
    <MenuItem
      selected={selected}
      leading={leading}
      closeOnSelect={closeOnSelect}
      onSelect={handleSelect}
      testID={testID}
    >
      {label}
    </MenuItem>
  );
}

/** A page of mutually exclusive options — pick one and the menu closes. */
function OptionList<Value extends string>({
  values,
  icons,
  labelKeys,
  selectedValue,
  onSelect,
  testIDPrefix,
}: {
  values: readonly Value[];
  icons: Record<Value, OptionIcon>;
  labelKeys: Record<Value, string>;
  selectedValue: Value;
  onSelect: (value: Value) => void;
  testIDPrefix: string;
}): ReactNode {
  const { t } = useTranslation();
  return values.map((value) => (
    <OptionItem
      key={value}
      value={value}
      icon={icons[value]}
      label={t(labelKeys[value])}
      selected={value === selectedValue}
      onSelect={onSelect}
      testID={`${testIDPrefix}-${value}`}
    />
  ));
}

/** Independent row details, followed by the checks display options. */
function ShowPage({ preferences }: { preferences: Preferences }): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {SIDEBAR_ROW_ITEMS.map((item) => (
        <OptionItem
          key={item}
          value={item}
          icon={ROW_ITEM_ICONS[item]}
          label={t(ROW_ITEM_LABEL_KEYS[item])}
          selected={preferences.rowItems[item]}
          closeOnSelect={false}
          onSelect={preferences.toggleRowItem}
          testID={`sidebar-row-item-${item}`}
        />
      ))}
      <ChecksSubTrigger />
    </>
  );
}

/**
 * No value on the row, only the chevron. The three answers are all long enough that the value
 * fills the row and stops reading as an answer sitting at the right edge — it turns into a second
 * line of label. The chevron alone says there is a decision in here, and the page says what it is.
 */
function ChecksSubTrigger(): ReactElement {
  const { t } = useTranslation();
  const leading = useMemo(
    () => <ThemedCircleCheck size={OPTION_ICON_SIZE} uniProps={mutedIconMapping} />,
    [],
  );
  return (
    <MenuSubTrigger id="checks" leading={leading} testID="sidebar-display-checks">
      {t("sidebar.display.show.checks")}
    </MenuSubTrigger>
  );
}

/**
 * Every project the sidebar can show, including hidden projects.
 *
 * A check means the project is visible. This is the same persisted visibility state changed by
 * the project's "Hide project" action, so filtering and recovery no longer compete in two pages.
 */
function ProjectFilterPage({
  projects,
  preferences,
}: {
  projects: readonly SidebarProjectEntry[];
  preferences: Preferences;
}): ReactElement {
  const { t } = useTranslation();
  const iconTargets = useMemo(() => resolveSidebarProjectIconTargets(projects), [projects]);
  // Shares TanStack's cache with the sidebar's own call, so this subscribes rather than refetches.
  const iconByProjectViewKey = useProjectIcons({ projects: iconTargets });

  return (
    <>
      <MenuItem
        selected={preferences.hiddenProjectViewKeys.length === 0}
        closeOnSelect={false}
        onSelect={preferences.showAllProjects}
        testID="sidebar-project-filter-all"
      >
        {t("sidebar.display.projectFilter.all")}
      </MenuItem>
      {projects.map((project) => (
        <ProjectFilterItem
          key={project.viewKey}
          viewKey={project.viewKey}
          label={project.projectName}
          iconDataUri={iconByProjectViewKey.get(project.viewKey) ?? null}
          selected={!preferences.hiddenProjectViewKeys.includes(project.viewKey)}
          onToggle={preferences.toggleProjectVisibility}
        />
      ))}
    </>
  );
}

function ProjectFilterItem({
  viewKey,
  label,
  iconDataUri,
  selected,
  onToggle,
}: {
  viewKey: string;
  label: string;
  iconDataUri: string | null;
  selected: boolean;
  onToggle: (viewKey: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onToggle(viewKey), [viewKey, onToggle]);
  const leading = useMemo(
    () => (
      <ProjectIconView
        iconDataUri={iconDataUri}
        initial={projectIconPlaceholderLabelFromDisplayName(label).charAt(0).toUpperCase()}
        projectViewKey={viewKey}
        size={OPTION_ICON_SIZE}
        textStyle={styles.projectIconText}
      />
    ),
    [iconDataUri, label, viewKey],
  );

  return (
    <MenuItem
      selected={selected}
      leading={leading}
      closeOnSelect={false}
      onSelect={handleSelect}
      testID={`sidebar-project-filter-${viewKey}`}
    >
      {label}
    </MenuItem>
  );
}

function HostFilterPage({
  preferences,
  hosts,
}: {
  preferences: Preferences;
  hosts: ReturnType<typeof useHosts>;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <MenuItem
        selected={preferences.hostFilters.length === 0}
        closeOnSelect={false}
        onSelect={preferences.clearHostFilters}
        testID="sidebar-host-filter-all"
      >
        {t("sidebar.display.hostFilter.all")}
      </MenuItem>
      {hosts.map((host) => (
        <HostFilterItem
          key={host.serverId}
          serverId={host.serverId}
          label={host.label?.trim() || host.serverId}
          selected={preferences.hostFilters.includes(host.serverId)}
          onToggle={preferences.toggleHostFilter}
        />
      ))}
    </>
  );
}

/** The one option row whose mark is live state rather than an icon. */
function HostFilterItem({
  serverId,
  label,
  selected,
  onToggle,
}: {
  serverId: string;
  label: string;
  selected: boolean;
  onToggle: (serverId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onToggle(serverId), [onToggle, serverId]);
  const leading = useMemo(
    () => (
      <View testID={`sidebar-host-filter-status-${serverId}`}>
        <HostStatusDot serverId={serverId} />
      </View>
    ),
    [serverId],
  );

  return (
    <MenuItem
      selected={selected}
      closeOnSelect={false}
      leading={leading}
      onSelect={handleSelect}
      testID={`sidebar-host-filter-${serverId}`}
    >
      {label}
    </MenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  triggerTouch: {
    width: TOUCH_LIST_ROW_ACTION_SIZE,
    height: TOUCH_LIST_ROW_ACTION_SIZE,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // The icon sits in a 14pt menu slot, so the fallback initial is sized down to match rather
  // than reusing the sidebar row's 16pt figure.
  projectIconText: {
    fontSize: 8,
  },
}));

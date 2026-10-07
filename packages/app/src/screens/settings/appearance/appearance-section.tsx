import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  Image,
  Platform,
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Monitor, Moon, Sun } from "lucide-react-native";
import {
  SYNTAX_THEME_OPTIONS,
  type SyntaxThemeId,
  type SyntaxThemeOption,
} from "@omp-desktop/highlight";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { buildWallpaperMediaSrc } from "@/wallpaper/media-src";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useContributedThemes } from "@/appearance/provider";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import {
  MAX_CODE_FONT_SIZE,
  MAX_CONTENT_FONT_SIZE,
  MAX_UI_BASE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_CONTENT_FONT_SIZE,
  MIN_UI_BASE_FONT_SIZE,
  parseClampedFontSize,
  sanitizeFontFamily,
  useAppSettings,
  type AppSettings,
  DEFAULT_THEME_PREFERENCE,
} from "@/hooks/use-settings";
import {
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  ICON_SIZE,
  PLUGIN_THEME_PREFERENCE,
  THEME_OPTIONS,
  THEME_SWATCHES,
  type Theme,
} from "@/styles/theme";
import { isNative } from "@/constants/platform";
import type { ContributedThemeOption as PluginThemeOption } from "@/appearance/provider";
import { settingsStyles } from "@/styles/settings";
import { AppearancePreview } from "./appearance-preview";
import { pickDirectory } from "@/desktop/pick-directory";
import { isElectronRuntime } from "@/desktop/host";

// ---------------------------------------------------------------------------
// Theme-reactive leaf icons (withUnistyles + uniProps color mapping — no
// useUnistyles). Icon sizes read the static ICON_SIZE token; the appearance
// feature does not scale icons.
// ---------------------------------------------------------------------------

const ThemedSun = withUnistyles(Sun);
const ThemedMoon = withUnistyles(Moon);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedChevronDown = withUnistyles(ChevronDown);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type BuiltInThemePreference = Exclude<AppSettings["theme"], typeof PLUGIN_THEME_PREFERENCE>;

function getThemeLabel(t: TFunction, value: BuiltInThemePreference): string {
  return t(`settings.appearance.theme.options.${value}`);
}

// Platform default stacks can be the bare native tokens ("normal"/"monospace");
// those read as a bug, so show a human label in the placeholder instead.
const BARE_DEFAULT_STACKS: ReadonlySet<string> = new Set(["normal", "monospace"]);

function resolveDefaultStackPlaceholder(t: TFunction, stack: string): string {
  return BARE_DEFAULT_STACKS.has(stack) ? t("settings.appearance.fonts.systemDefault") : stack;
}

// Local size string (digits only) -> preview override number. Empty/invalid
// yields undefined so the preview falls back to the committed theme value.
function sizeDraftToOverride(value: string): number | undefined {
  if (value.length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dropdownTriggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, pressed ? styles.triggerPressed : null];
}

// ---------------------------------------------------------------------------
// Theme picker
// ---------------------------------------------------------------------------

interface ThemeLeadingProps {
  themeValue: BuiltInThemePreference;
}

function ThemeLeading({ themeValue }: ThemeLeadingProps) {
  switch (themeValue) {
    case "light":
      return <ThemedSun size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
    case "dark":
      return <ThemedMoon size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
    case "auto":
      return <ThemedMonitor size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
    default:
      return <ThemeSwatch color={THEME_SWATCHES[themeValue]} />;
  }
}

interface ThemeSwatchProps {
  color: string;
}

function ThemeSwatch({ color }: ThemeSwatchProps) {
  const swatchStyle = useMemo(() => [styles.swatch, { backgroundColor: color }], [color]);
  return <View style={swatchStyle} />;
}

interface ThemeMenuItemProps {
  themeValue: BuiltInThemePreference;
  selected: boolean;
  onChange: (theme: BuiltInThemePreference) => void;
}

function ThemeMenuItem({ themeValue, selected, onChange }: ThemeMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onChange(themeValue);
  }, [onChange, themeValue]);
  const leading = useMemo(() => <ThemeLeading themeValue={themeValue} />, [themeValue]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} leading={leading}>
      {getThemeLabel(t, themeValue)}
    </DropdownMenuItem>
  );
}

interface PluginThemeMenuItemProps {
  option: PluginThemeOption;
  selected: boolean;
  onSelect: (option: PluginThemeOption) => void;
}

function PluginThemeMenuItem({ option, selected, onSelect }: PluginThemeMenuItemProps) {
  const handleSelect = useCallback(() => {
    onSelect(option);
  }, [onSelect, option]);
  const leading = useMemo(() => <ThemeSwatch color={option.swatch} />, [option.swatch]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} leading={leading}>
      {option.name}
    </DropdownMenuItem>
  );
}

interface ThemeRowProps {
  value: AppSettings["theme"];
  pluginThemes: PluginThemeOption[];
  selectedPluginTheme: PluginThemeOption | null;
  onChange: (theme: BuiltInThemePreference) => void;
  onSelectPluginTheme: (option: PluginThemeOption) => void;
}

function ThemeRow({
  value,
  pluginThemes,
  selectedPluginTheme,
  onChange,
  onSelectPluginTheme,
}: ThemeRowProps) {
  const { t } = useTranslation();
  // A selected contribution that is no longer installed shows the fallback the app renders.
  const builtInValue = value === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : value;
  const selectedLabel = selectedPluginTheme
    ? selectedPluginTheme.name
    : getThemeLabel(t, builtInValue);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.theme.title")}</Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.appearance.theme.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          {selectedPluginTheme ? (
            <ThemeSwatch color={selectedPluginTheme.swatch} />
          ) : (
            <ThemeLeading themeValue={builtInValue} />
          )}
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {THEME_OPTIONS.map((option, index) => {
            const previousOption = THEME_OPTIONS[index - 1];
            return (
              <Fragment key={option.name}>
                {previousOption && previousOption.group !== option.group ? (
                  <DropdownMenuSeparator />
                ) : null}
                <ThemeMenuItem
                  themeValue={option.name}
                  selected={selectedPluginTheme === null && builtInValue === option.name}
                  onChange={onChange}
                />
              </Fragment>
            );
          })}
          {pluginThemes.length > 0 ? <DropdownMenuSeparator /> : null}
          {pluginThemes.map((option) => (
            <PluginThemeMenuItem
              key={option.id}
              option={option}
              selected={selectedPluginTheme?.id === option.id}
              onSelect={onSelectPluginTheme}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

interface AutoExpandReasoningRowProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

function AutoExpandReasoningRow({ value, onChange }: AutoExpandReasoningRowProps) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.general.autoExpandReasoning.label")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.general.autoExpandReasoning.description")}
        </Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

interface ChatOutlineRowProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

function ChatOutlineRow({ value, onChange }: ChatOutlineRowProps) {
  const { t } = useTranslation();
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.appearance.chatOutline.title")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.chatOutline.description")}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={t("settings.appearance.chatOutline.title")}
      />
    </View>
  );
}

const TOOL_CALL_DETAIL_LEVELS: readonly AppSettings["toolCallDetailLevel"][] = [
  "detailed",
  "overview",
];

function getToolCallDetailLevelLabel(
  t: TFunction,
  value: AppSettings["toolCallDetailLevel"],
): string {
  return t(`settings.general.toolCallDetail.options.${value}`);
}

interface ToolCallDetailMenuItemProps {
  value: AppSettings["toolCallDetailLevel"];
  selected: boolean;
  onChange: (value: AppSettings["toolCallDetailLevel"]) => void;
}

function ToolCallDetailMenuItem({ value, selected, onChange }: ToolCallDetailMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {getToolCallDetailLevelLabel(t, value)}
    </DropdownMenuItem>
  );
}

interface ToolCallDetailRowProps {
  value: AppSettings["toolCallDetailLevel"];
  onChange: (value: AppSettings["toolCallDetailLevel"]) => void;
}

function ToolCallDetailRow({ value, onChange }: ToolCallDetailRowProps) {
  const { t } = useTranslation();
  const selectedLabel = getToolCallDetailLevelLabel(t, value);
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.general.toolCallDetail.label")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.general.toolCallDetail.description")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.general.toolCallDetail.accessibilityLabel", {
            value: selectedLabel,
          })}
        >
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {TOOL_CALL_DETAIL_LEVELS.map((option) => (
            <ToolCallDetailMenuItem
              key={option}
              value={option}
              selected={value === option}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Fonts: family text fields + numeric size fields (commit on blur/submit)
// ---------------------------------------------------------------------------

interface FontFamilyRowProps {
  title: string;
  hint: string;
  accessibilityLabel: string;
  placeholder: string;
  value: string;
  draft: string;
  withBorder: boolean;
  onChangeDraft: (value: string) => void;
  onCommit: (value: string) => void;
}

function FontFamilyRow({
  title,
  hint,
  accessibilityLabel,
  placeholder,
  value,
  draft,
  withBorder,
  onChangeDraft,
  onCommit,
}: FontFamilyRowProps) {
  const handleCommit = useCallback(() => {
    onCommit(draft);
  }, [draft, onCommit]);

  // Resync from the committed value when it changes elsewhere.
  useEffect(() => {
    onChangeDraft(value);
    // Only resync on external value changes, not on local keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <TextInput
        initialValue={draft}
        onChangeText={onChangeDraft}
        onBlur={handleCommit}
        onSubmitEditing={handleCommit}
        placeholder={placeholder}
        placeholderTextColor={styles.placeholderColor.color}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={styles.fontFamilyInput}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

interface FontSizeRowProps {
  title: string;
  hint: string;
  accessibilityLabel: string;
  draft: string;
  withBorder?: boolean;
  onChangeDraft: (value: string) => void;
  onCommit: () => void;
}

function FontSizeRow({
  title,
  hint,
  accessibilityLabel,
  draft,
  withBorder = true,
  onChangeDraft,
  onCommit,
}: FontSizeRowProps) {
  return (
    <View style={withBorder ? styles.rowWithBorder : settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <View style={styles.sizeField}>
        <TextInput
          initialValue={draft}
          onChangeText={onChangeDraft}
          onBlur={onCommit}
          onSubmitEditing={onCommit}
          keyboardType="number-pad"
          inputMode="numeric"
          selectTextOnFocus
          style={styles.sizeInput}
          accessibilityLabel={accessibilityLabel}
        />
        <Text style={styles.unit}>px</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Syntax highlight theme picker (commits immediately)
// ---------------------------------------------------------------------------

function syntaxLabelForId(id: SyntaxThemeId): string {
  const option = SYNTAX_THEME_OPTIONS.find((entry) => entry.id === id);
  return option ? option.label : id;
}

interface SyntaxMenuItemProps {
  option: SyntaxThemeOption;
  selected: boolean;
  onChange: (id: SyntaxThemeId) => void;
}

function SyntaxMenuItem({ option, selected, onChange }: SyntaxMenuItemProps) {
  const handleSelect = useCallback(() => {
    onChange(option.id);
  }, [onChange, option.id]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {option.label}
    </DropdownMenuItem>
  );
}

interface SyntaxRowProps {
  value: SyntaxThemeId;
  onChange: (id: SyntaxThemeId) => void;
}

function SyntaxRow({ value, onChange }: SyntaxRowProps) {
  const { t } = useTranslation();
  const selectedLabel = syntaxLabelForId(value);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.appearance.syntax.highlightTheme")}
        </Text>
        <Text style={settingsStyles.rowHint}>
          {t("settings.appearance.syntax.highlightThemeHint")}
        </Text>
      </View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={dropdownTriggerStyle}
          accessibilityLabel={t("settings.appearance.syntax.highlightThemeAccessibility", {
            value: selectedLabel,
          })}
        >
          <Text style={styles.triggerText}>{selectedLabel}</Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {SYNTAX_THEME_OPTIONS.map((option) => (
            <SyntaxMenuItem
              key={option.id}
              option={option}
              selected={value === option.id}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const {
    options: pluginThemes,
    selected: selectedPluginTheme,
    select: selectPluginTheme,
  } = useContributedThemes();
  const showInterfaceFontFamilyRow = !isNative;
  const uiFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_UI_FONT_STACK);
  const monoFontPlaceholder = resolveDefaultStackPlaceholder(t, DEFAULT_MONO_FONT_STACK);

  const [uiFontDraft, setUiFontDraft] = useState(settings.uiFontFamily);
  const [monoFontDraft, setMonoFontDraft] = useState(settings.monoFontFamily);
  const [uiBaseSizeDraft, setUiBaseSizeDraft] = useState(String(settings.uiBaseFontSize));
  const [contentSizeDraft, setContentSizeDraft] = useState(String(settings.contentFontSize));
  const [codeSizeDraft, setCodeSizeDraft] = useState(String(settings.codeFontSize));

  // Resync numeric drafts when the committed value changes elsewhere.
  useEffect(() => {
    setUiBaseSizeDraft(String(settings.uiBaseFontSize));
  }, [settings.uiBaseFontSize]);
  useEffect(() => {
    setContentSizeDraft(String(settings.contentFontSize));
  }, [settings.contentFontSize]);
  useEffect(() => {
    setCodeSizeDraft(String(settings.codeFontSize));
  }, [settings.codeFontSize]);

  const handleThemeChange = useCallback(
    (theme: BuiltInThemePreference) => {
      void updateSettings({ theme });
    },
    [updateSettings],
  );

  const handlePluginThemeChange = useCallback(
    (option: PluginThemeOption) => {
      selectPluginTheme(option);
    },
    [selectPluginTheme],
  );

  const handleSyntaxThemeChange = useCallback(
    (syntaxTheme: SyntaxThemeId) => {
      void updateSettings({ syntaxTheme });
    },
    [updateSettings],
  );

  const handleAutoExpandReasoningChange = useCallback(
    (autoExpandReasoning: boolean) => {
      void updateSettings({ autoExpandReasoning });
    },
    [updateSettings],
  );

  const handleToolCallDetailLevelChange = useCallback(
    (toolCallDetailLevel: AppSettings["toolCallDetailLevel"]) => {
      void updateSettings({ toolCallDetailLevel });
    },
    [updateSettings],
  );

  const handleChatOutlineChange = useCallback(
    (chatOutlineEnabled: boolean) => {
      void updateSettings({ chatOutlineEnabled });
    },
    [updateSettings],
  );

  const commitUiFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setUiFontDraft(settings.uiFontFamily);
        return;
      }
      setUiFontDraft(sanitized);
      if (sanitized !== settings.uiFontFamily) {
        void updateSettings({ uiFontFamily: sanitized });
      }
    },
    [settings.uiFontFamily, updateSettings],
  );

  const commitMonoFontFamily = useCallback(
    (value: string) => {
      const sanitized = sanitizeFontFamily(value);
      if (sanitized === null) {
        setMonoFontDraft(settings.monoFontFamily);
        return;
      }
      setMonoFontDraft(sanitized);
      if (sanitized !== settings.monoFontFamily) {
        void updateSettings({ monoFontFamily: sanitized });
      }
    },
    [settings.monoFontFamily, updateSettings],
  );

  const handleUiBaseSizeChange = useCallback((value: string) => {
    setUiBaseSizeDraft(value.replace(/[^\d]/g, ""));
  }, []);

  const handleCodeSizeChange = useCallback((value: string) => {
    setCodeSizeDraft(value.replace(/[^\d]/g, ""));
  }, []);

  const handleContentSizeChange = useCallback((value: string) => {
    setContentSizeDraft(value.replace(/[^\d]/g, ""));
  }, []);

  const commitUiBaseSize = useCallback(() => {
    const parsed = parseClampedFontSize(uiBaseSizeDraft, {
      min: MIN_UI_BASE_FONT_SIZE,
      max: MAX_UI_BASE_FONT_SIZE,
    });
    const next = parsed ?? settings.uiBaseFontSize;
    setUiBaseSizeDraft(String(next));
    if (next !== settings.uiBaseFontSize) {
      void updateSettings({ uiBaseFontSize: next });
    }
  }, [settings.uiBaseFontSize, uiBaseSizeDraft, updateSettings]);

  const commitCodeSize = useCallback(() => {
    const parsed = parseClampedFontSize(codeSizeDraft, {
      min: MIN_CODE_FONT_SIZE,
      max: MAX_CODE_FONT_SIZE,
    });
    const next = parsed ?? settings.codeFontSize;
    setCodeSizeDraft(String(next));
    if (next !== settings.codeFontSize) {
      void updateSettings({ codeFontSize: next });
    }
  }, [codeSizeDraft, settings.codeFontSize, updateSettings]);

  const commitContentSize = useCallback(() => {
    const parsed = parseClampedFontSize(contentSizeDraft, {
      min: MIN_CONTENT_FONT_SIZE,
      max: MAX_CONTENT_FONT_SIZE,
    });
    const next = parsed ?? settings.contentFontSize;
    setContentSizeDraft(String(next));
    if (next !== settings.contentFontSize) {
      void updateSettings({ contentFontSize: next });
    }
  }, [contentSizeDraft, settings.contentFontSize, updateSettings]);

  // Live-while-typing: the in-progress drafts drive the preview without
  // committing to the global theme. Empty/invalid fields fall back to the
  // theme value inside the preview.
  const previewOverrides = useMemo(
    () => ({
      contentFontSize: sizeDraftToOverride(contentSizeDraft),
      monoFontFamily: monoFontDraft,
      codeFontSize: sizeDraftToOverride(codeSizeDraft),
    }),
    [codeSizeDraft, contentSizeDraft, monoFontDraft],
  );

  return (
    <View>
      <SettingsSection title={t("settings.appearance.theme.title")}>
        <View style={settingsStyles.card}>
          <ThemeRow
            value={settings.theme}
            pluginThemes={pluginThemes}
            selectedPluginTheme={selectedPluginTheme}
            onChange={handleThemeChange}
            onSelectPluginTheme={handlePluginThemeChange}
          />
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.appearance.detailLevel.title")}>
        <View style={settingsStyles.card}>
          <AutoExpandReasoningRow
            value={settings.autoExpandReasoning}
            onChange={handleAutoExpandReasoningChange}
          />
          <ToolCallDetailRow
            value={settings.toolCallDetailLevel}
            onChange={handleToolCallDetailLevelChange}
          />
          {!isNative ? (
            <ChatOutlineRow
              value={settings.chatOutlineEnabled}
              onChange={handleChatOutlineChange}
            />
          ) : null}
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.appearance.fonts.title")}>
        <View style={settingsStyles.card}>
          {showInterfaceFontFamilyRow ? (
            <FontFamilyRow
              title={t("settings.appearance.fonts.interfaceFont")}
              hint={t("settings.appearance.fonts.interfaceFontHint")}
              accessibilityLabel={t("settings.appearance.fonts.interfaceFontAccessibility")}
              placeholder={uiFontPlaceholder}
              value={settings.uiFontFamily}
              draft={uiFontDraft}
              withBorder={false}
              onChangeDraft={setUiFontDraft}
              onCommit={commitUiFontFamily}
            />
          ) : null}
          <FontSizeRow
            title={t("settings.appearance.fonts.interfaceSize")}
            hint={t("settings.appearance.fonts.interfaceSizeHint")}
            accessibilityLabel={t("settings.appearance.fonts.interfaceSizeAccessibility")}
            draft={uiBaseSizeDraft}
            withBorder={showInterfaceFontFamilyRow}
            onChangeDraft={handleUiBaseSizeChange}
            onCommit={commitUiBaseSize}
          />
          <FontSizeRow
            title={t("settings.appearance.fonts.contentSize")}
            hint={t("settings.appearance.fonts.contentSizeHint")}
            accessibilityLabel={t("settings.appearance.fonts.contentSizeAccessibility")}
            draft={contentSizeDraft}
            onChangeDraft={handleContentSizeChange}
            onCommit={commitContentSize}
          />
          <FontFamilyRow
            title={t("settings.appearance.fonts.codeFont")}
            hint={t("settings.appearance.fonts.codeFontHint")}
            accessibilityLabel={t("settings.appearance.fonts.codeFontAccessibility")}
            placeholder={monoFontPlaceholder}
            value={settings.monoFontFamily}
            draft={monoFontDraft}
            withBorder
            onChangeDraft={setMonoFontDraft}
            onCommit={commitMonoFontFamily}
          />
          <FontSizeRow
            title={t("settings.appearance.fonts.codeSize")}
            hint={t("settings.appearance.fonts.codeSizeHint")}
            accessibilityLabel={t("settings.appearance.fonts.codeSizeAccessibility")}
            draft={codeSizeDraft}
            onChangeDraft={handleCodeSizeChange}
            onCommit={commitCodeSize}
          />
        </View>
      </SettingsSection>
      <WallpaperSection />
      <SettingsSection title={t("settings.appearance.syntax.title")}>
        <View style={settingsStyles.card}>
          <SyntaxRow value={settings.syntaxTheme} onChange={handleSyntaxThemeChange} />
        </View>
        <View style={styles.preview}>
          <AppearancePreview overrides={previewOverrides} />
        </View>
      </SettingsSection>
    </View>
  );
}
// ---------------------------------------------------------------------------
// Wallpaper
// ---------------------------------------------------------------------------

const WALLPAPER_SOURCES: readonly AppSettings["wallpaperSource"][] = ["none", "file", "url"];

const THUMB_VIDEO_STYLE = { width: "100%", height: "100%", objectFit: "cover" } as const;

const OPACITY_SLIDER_OUTER_STYLE = {
  width: "100%",
  height: 24,
  display: "flex",
  alignItems: "center",
  cursor: "pointer",
  touchAction: "none",
} as const;

const OPACITY_SLIDER_TRACK_STYLE = {
  width: "100%",
  height: 6,
  borderRadius: 3,
  position: "relative",
} as const;

const OPACITY_SLIDER_BASE_STYLE = {
  position: "absolute",
  inset: 0,
  borderRadius: 3,
  backgroundColor: "rgba(128,128,128,0.2)",
} as const;

const OPACITY_SLIDER_FILL_STYLE = {
  position: "absolute",
  left: 0,
  top: 0,
  height: "100%",
  borderRadius: 3,
  backgroundColor: "var(--colors-primary, #00dbe4)",
} as const;

const OPACITY_SLIDER_THUMB_STYLE = {
  position: "absolute",
  top: -5,
  width: 16,
  height: 16,
  borderRadius: 8,
  backgroundColor: "#fff",
  boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
  border: "1px solid rgba(0,0,0,0.1)",
} as const;

function wallpaperSourceLabel(t: TFunction, value: AppSettings["wallpaperSource"]): string {
  return t(`settings.appearance.wallpaper.source.${value}`);
}

function isVideoFilename(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return [".mp4", ".webm", ".m4v", ".mov", ".ogv"].includes(name.slice(dot).toLowerCase());
}

function WallpaperThumbContent({
  file,
  thumb,
}: {
  file: { path: string; name: string };
  thumb?: { dataUrl?: string; video?: boolean };
}) {
  const imageSource = useMemo(() => ({ uri: thumb?.dataUrl }), [thumb?.dataUrl]);
  const htmlProps = useMemo(
    () => ({
      dangerouslySetInnerHTML: {
        __html: `<video src="${buildWallpaperMediaSrc(file.path).replace(/"/g, "&quot;")}" muted autoplay loop playsinline style="width:100%;height:100%;object-fit:cover"></video>`,
      },
    }),
    [file.path],
  );
  if (thumb?.video || isVideoFilename(file.name)) {
    if (Platform.OS !== "web") {
      return <View style={styles.wallpaperThumbPlaceholder} />;
    }
    return <div style={THUMB_VIDEO_STYLE} {...htmlProps} />;
  }
  if (thumb?.dataUrl) {
    return <Image source={imageSource} style={styles.wallpaperThumbImage} resizeMode="cover" />;
  }
  return <View style={styles.wallpaperThumbPlaceholder} />;
}

interface WallpaperSourceMenuItemProps {
  source: AppSettings["wallpaperSource"];
  selected: boolean;
  onSelect: (source: AppSettings["wallpaperSource"]) => void;
}

function WallpaperSourceMenuItem({ source, selected, onSelect }: WallpaperSourceMenuItemProps) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onSelect(source);
  }, [onSelect, source]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {wallpaperSourceLabel(t, source)}
    </DropdownMenuItem>
  );
}

interface WallpaperDirectoryRowProps {
  dir: string | null;
  onPick: () => void;
}

function WallpaperDirectoryRow({ dir, onPick }: WallpaperDirectoryRowProps) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPick}
      accessibilityRole="button"
      accessibilityLabel={t("settings.appearance.wallpaper.directory.pickerTitle")}
    >
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.appearance.wallpaper.directory.label")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {dir || t("settings.appearance.wallpaper.directory.hint")}
          </Text>
        </View>
        <Text style={styles.triggerText}>
          {t("settings.appearance.wallpaper.directory.browse")}
        </Text>
      </View>
    </Pressable>
  );
}

interface WallpaperThumbItemProps {
  file: { path: string; name: string };
  thumb?: { dataUrl?: string; video?: boolean };
  selected: boolean;
  onSelect: (path: string) => void;
}

function WallpaperThumbItem({ file, thumb, selected, onSelect }: WallpaperThumbItemProps) {
  const handlePress = useCallback(() => {
    onSelect(file.path);
  }, [onSelect, file.path]);
  return (
    <Pressable onPress={handlePress} accessibilityRole="button" accessibilityLabel={file.name}>
      <View style={[styles.wallpaperThumb, selected ? styles.wallpaperThumbSelected : null]}>
        <WallpaperThumbContent file={file} thumb={thumb} />
      </View>
      <Text style={styles.wallpaperThumbName} numberOfLines={1}>
        {file.name}
      </Text>
    </Pressable>
  );
}

interface WallpaperPreviewGridProps {
  scanning: boolean;
  files: { path: string; name: string }[];
  thumbnails: Record<string, { dataUrl?: string; video?: boolean }>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function WallpaperPreviewGrid({
  scanning,
  files,
  thumbnails,
  selectedPath,
  onSelect,
}: WallpaperPreviewGridProps) {
  const { t } = useTranslation();
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [gridRowHeight, setGridRowHeight] = useState<number | null>(null);

  const handleTogglePreview = useCallback(() => {
    setPreviewExpanded((prev) => !prev);
  }, []);

  const handleGridLayout = useCallback((event: LayoutChangeEvent) => {
    const h = event.nativeEvent.layout.height;
    if (h > 0) {
      setGridRowHeight((prev) => (prev === null ? h : prev));
    }
  }, []);

  if (scanning) {
    return (
      <View style={styles.wallpaperPreviewContainer}>
        <Text style={styles.wallpaperPreviewHint}>
          {t("settings.appearance.wallpaper.preview.scanning")}
        </Text>
      </View>
    );
  }
  if (files.length === 0) {
    return (
      <View style={styles.wallpaperPreviewContainer}>
        <Text style={styles.wallpaperPreviewHint}>
          {t("settings.appearance.wallpaper.preview.empty")}
        </Text>
      </View>
    );
  }

  let gridStyle: { opacity: number } | { maxHeight: number; overflow: "hidden" } | null = null;
  if (gridRowHeight === null) {
    gridStyle = { opacity: 0 };
  } else if (!previewExpanded) {
    gridStyle = { maxHeight: gridRowHeight * 2, overflow: "hidden" };
  }

  const toggleLabel = previewExpanded
    ? t("settings.appearance.wallpaper.preview.collapse")
    : t("settings.appearance.wallpaper.preview.expand");
  const toggleText = previewExpanded
    ? t("settings.appearance.wallpaper.preview.collapse")
    : t("settings.appearance.wallpaper.preview.expand", { count: files.length });

  return (
    <View style={styles.wallpaperPreviewContainer}>
      <View style={[styles.wallpaperGrid, gridStyle]} onLayout={handleGridLayout}>
        {files.map((file) => (
          <WallpaperThumbItem
            key={file.path}
            file={file}
            thumb={thumbnails[file.path]}
            selected={selectedPath === file.path}
            onSelect={onSelect}
          />
        ))}
      </View>
      {files.length > 8 ? (
        <Pressable
          onPress={handleTogglePreview}
          accessibilityRole="button"
          accessibilityLabel={toggleLabel}
          style={styles.wallpaperPreviewToggle}
        >
          <Text style={styles.wallpaperPreviewToggleText}>{toggleText}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

interface OpacitySliderProps {
  opacity: number;
  onChange: (value: number) => void;
}

function OpacitySlider({ opacity, onChange }: OpacitySliderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fillPercent = ((opacity - 0.1) / 0.9) * 100;
  const fillStyle = useMemo(
    () => ({ ...OPACITY_SLIDER_FILL_STYLE, width: `${fillPercent}%` }),
    [fillPercent],
  );
  const thumbStyle = useMemo(
    () => ({ ...OPACITY_SLIDER_THUMB_STYLE, left: `calc(${fillPercent}% - 7px)` }),
    [fillPercent],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateFromEvent = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const value = Math.round((0.1 + ratio * 0.9) * 100) / 100;
      onChange(value);
    };
    const handlePointerDown = (e: PointerEvent) => {
      e.preventDefault();
      updateFromEvent(e.clientX);
      const handleMove = (ev: PointerEvent) => updateFromEvent(ev.clientX);
      const handleUp = () => {
        document.removeEventListener("pointermove", handleMove);
        document.removeEventListener("pointerup", handleUp);
      };
      document.addEventListener("pointermove", handleMove);
      document.addEventListener("pointerup", handleUp);
    };
    el.addEventListener("pointerdown", handlePointerDown);
    return () => {
      el.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [onChange]);

  return (
    <div ref={containerRef} style={OPACITY_SLIDER_OUTER_STYLE}>
      <div style={OPACITY_SLIDER_TRACK_STYLE}>
        <div style={OPACITY_SLIDER_BASE_STYLE} />
        <div style={fillStyle} />
        <div style={thumbStyle} />
      </div>
    </div>
  );
}

function WallpaperSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const [wallpaperFiles, setWallpaperFiles] = useState<{ path: string; name: string }[]>([]);
  const [thumbnails, setThumbnails] = useState<
    Record<string, { dataUrl?: string; video?: boolean }>
  >({});
  const [scanning, setScanning] = useState(false);

  const desktop = typeof window !== "undefined" ? (window.paseoDesktop ?? null) : null;

  const handleToggle = useCallback(
    (wallpaperEnabled: boolean) => {
      void updateSettings({ wallpaperEnabled });
    },
    [updateSettings],
  );

  const handleSourceChange = useCallback(
    (wallpaperSource: AppSettings["wallpaperSource"]) => {
      void updateSettings({ wallpaperSource });
    },
    [updateSettings],
  );

  const handleUrlChange = useCallback(
    (url: string) => {
      void updateSettings({ wallpaperUrl: url || null });
    },
    [updateSettings],
  );

  const handleDirPick = useCallback(async () => {
    if (!isElectronRuntime()) {
      return;
    }
    try {
      const dir = await pickDirectory();
      if (dir) {
        void updateSettings({ wallpaperDir: dir });
      }
    } catch {
      // dialog unavailable or cancelled — silently ignore
    }
  }, [updateSettings]);

  const handleSelectWallpaper = useCallback(
    (filePath: string) => {
      void updateSettings({ wallpaperPath: filePath });
    },
    [updateSettings],
  );

  // Scan wallpaper directory when it changes
  useEffect(() => {
    if (
      !settings.wallpaperEnabled ||
      settings.wallpaperSource !== "file" ||
      !settings.wallpaperDir
    ) {
      setWallpaperFiles([]);
      setThumbnails({});
      return;
    }
    if (!desktop || typeof desktop.invoke !== "function") {
      setWallpaperFiles([]);
      return;
    }

    let cancelled = false;
    setScanning(true);
    setWallpaperFiles([]);
    setThumbnails({});

    const invoke = desktop.invoke;
    const applyFrame = (path: string, frame: unknown) => {
      const f = frame as { dataUrl: string | null; video?: boolean } | null;
      if (f?.dataUrl) {
        const dataUrl = f.dataUrl;
        setThumbnails((prev) => ({ ...prev, [path]: { dataUrl } }));
      } else if (f?.video) {
        setThumbnails((prev) => ({ ...prev, [path]: { video: true } }));
      }
    };
    invoke("paseo:wallpaper:scanDir", { dir: settings.wallpaperDir })
      .then((result) => {
        if (cancelled) return [];
        const files = (result as { path: string; name: string }[]) ?? [];
        setWallpaperFiles(files);
        // Load thumbnails for each file
        for (const file of files) {
          invoke("paseo:wallpaper:getFrame", { path: file.path })
            .then((frame) => {
              if (!cancelled) applyFrame(file.path, frame);
              return null;
            })
            .catch(() => {
              // thumbnail load failed — skip
            });
        }
        return files;
      })
      .catch(() => {
        if (!cancelled) setWallpaperFiles([]);
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });

    return () => {
      cancelled = true;
    };
  }, [settings.wallpaperEnabled, settings.wallpaperSource, settings.wallpaperDir, desktop]);

  const handleOpacityChange = useCallback(
    (value: number) => {
      void updateSettings({ wallpaperOpacity: value });
    },
    [updateSettings],
  );

  const opacityPercent = Math.round((settings.wallpaperOpacity ?? 0.85) * 100);

  return (
    <SettingsSection title={t("settings.appearance.wallpaper.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.appearance.wallpaper.enabled")}
            </Text>
          </View>
          <Switch
            value={settings.wallpaperEnabled}
            onValueChange={handleToggle}
            accessibilityLabel={t("settings.appearance.wallpaper.enabled")}
            testID="wallpaper-enabled-switch"
          />
        </View>
        {settings.wallpaperEnabled ? (
          <>
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>
                  {t("settings.appearance.wallpaper.source.label")}
                </Text>
              </View>
              <DropdownMenu>
                <DropdownMenuTrigger
                  style={dropdownTriggerStyle}
                  accessibilityLabel={t("settings.appearance.wallpaper.source.label")}
                  testID="wallpaper-source-trigger"
                >
                  <Text style={styles.triggerText}>
                    {wallpaperSourceLabel(t, settings.wallpaperSource)}
                  </Text>
                  <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end" width={160}>
                  {WALLPAPER_SOURCES.map((source) => (
                    <WallpaperSourceMenuItem
                      key={source}
                      source={source}
                      selected={settings.wallpaperSource === source}
                      onSelect={handleSourceChange}
                    />
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </View>

            {settings.wallpaperSource === "file" ? (
              <>
                {/* Directory picker */}
                <WallpaperDirectoryRow dir={settings.wallpaperDir} onPick={handleDirPick} />

                {/* Preview grid */}
                {settings.wallpaperDir ? (
                  <WallpaperPreviewGrid
                    scanning={scanning}
                    files={wallpaperFiles}
                    thumbnails={thumbnails}
                    selectedPath={settings.wallpaperPath}
                    onSelect={handleSelectWallpaper}
                  />
                ) : null}
              </>
            ) : null}

            {settings.wallpaperSource === "url" ? (
              <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
                <View style={settingsStyles.rowContent}>
                  <Text style={settingsStyles.rowTitle}>
                    {t("settings.appearance.wallpaper.url.label")}
                  </Text>
                  <Text style={settingsStyles.rowHint}>
                    {t("settings.appearance.wallpaper.url.hint")}
                  </Text>
                </View>
                <TextInput
                  initialValue={settings.wallpaperUrl ?? ""}
                  onChangeText={handleUrlChange}
                  placeholder={t("settings.appearance.wallpaper.url.hint")}
                  accessibilityLabel={t("settings.appearance.wallpaper.url.accessibilityLabel")}
                  style={styles.wallpaperInput}
                  testID="wallpaper-url-input"
                />
              </View>
            ) : null}
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>
                  {t("settings.appearance.wallpaper.opacity.label")}
                </Text>
                <Text style={settingsStyles.rowHint}>
                  {t("settings.appearance.wallpaper.opacity.hint")} {opacityPercent}%
                </Text>
              </View>
              <View style={styles.opacitySliderRow}>
                <View style={styles.opacitySliderContainer}>
                  {Platform.OS === "web" ? (
                    <OpacitySlider
                      opacity={settings.wallpaperOpacity ?? 0.85}
                      onChange={handleOpacityChange}
                    />
                  ) : null}
                </View>
                <Text style={styles.opacityValue}>{opacityPercent}%</Text>
              </View>
            </View>
          </>
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  preview: {
    marginTop: theme.spacing[4],
  },
  rowWithBorder: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerPressed: {
    opacity: 0.85,
  },
  triggerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  swatch: {
    width: ICON_SIZE.md,
    height: ICON_SIZE.md,
    borderRadius: ICON_SIZE.md / 2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  fontFamilyInput: {
    flexGrow: 1,
    flexShrink: 1,
    maxWidth: 280,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "left",
  },
  sizeField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sizeInput: {
    width: 64,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "right",
  },
  unit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
  wallpaperInput: {
    flexGrow: 1,
    flexShrink: 1,
    maxWidth: 280,
    minHeight: 36,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "left",
  },
  opacityValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    minWidth: 48,
  },
  opacitySliderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 200,
  },
  opacitySliderContainer: {
    flex: 1,
    maxWidth: 200,
  },
  opacitySlider: {
    width: "100%",
    accentColor: theme.colors.primary,
  },
  wallpaperPreviewContainer: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  wallpaperPreviewHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
  },
  wallpaperGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  wallpaperPreviewToggle: {
    alignSelf: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  wallpaperPreviewToggleText: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.sm,
  },
  wallpaperThumb: {
    width: 96,
    height: 72,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  wallpaperThumbSelected: {
    borderColor: theme.colors.primary,
    borderWidth: 2,
  },
  wallpaperThumbImage: {
    width: "100%",
    height: "100%",
  },
  wallpaperThumbPlaceholder: {
    width: "100%",
    height: "100%",
    backgroundColor: theme.colors.surface2,
  },
  wallpaperThumbName: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    marginTop: theme.spacing[1],
    maxWidth: 96,
    textAlign: "center",
  },
}));

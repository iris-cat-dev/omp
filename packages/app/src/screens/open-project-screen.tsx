import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, Text, View, type ViewStyle } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { ArrowRight, Boxes, FolderOpen, Inbox, Sparkles } from "lucide-react-native";
import { OmpIcon } from "@/components/icons/omp-icon";
import { MenuHeader } from "@/components/headers/menu-header";
import { Switch } from "@/components/ui/switch";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useAppSettings } from "@/hooks/use-settings";
import { usePluginBackgroundState } from "@/plugins/background";
import { usePanelStore } from "@/stores/panel-store";
import {
  useIsCompactFormFactor,
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import {
  buildHostAgentDetailRoute,
  buildSettingsAddHostRoute,
  buildSettingsHostSectionRoute,
} from "@/utils/host-routes";
import { ImportSessionSheet } from "@/components/import-session-sheet";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useOpenProject } from "@/hooks/use-open-project";
import type { Href } from "expo-router";
import { ompBrandColors } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { resolveActiveHostServerId } from "@/types/host-connection";

const OMP_MAGENTA = ompBrandColors.magenta;
const OMP_CYAN = ompBrandColors.cyan;
const OMP_BRAND_GRADIENT = [OMP_MAGENTA, OMP_CYAN] as const;

const TILE_ACCENTS = {
  magenta: {
    color: OMP_MAGENTA,
    glow: "rgba(248, 79, 204, 0.13)",
  },
  cyan: {
    color: OMP_CYAN,
    glow: "rgba(0, 219, 228, 0.11)",
  },
} as const;

type TileAccent = keyof typeof TILE_ACCENTS;

const LIGHT_TILE_HOVER_SHADOW = "0 12px 32px rgba(20, 20, 20, 0.08)";

const webBrandMarkStyle =
  Platform.OS === "web"
    ? inlineUnistylesStyle({
        boxShadow: "0 0 56px rgba(248, 79, 204, 0.08), 0 0 30px rgba(0, 219, 228, 0.05)",
      })
    : null;

const POSTER_PIXEL_BUDGET = 2_200_000;
const POSTER_HUE = 41;
const POSTER_LOADER_ID = "omp-poster-loader";
const POSTER_LOADER_SRC = "/omp-poster-loader.js";

interface PosterStencil {
  free: () => void;
  render: (elapsedMs: number) => void;
  resize: (width: number, height: number) => void;
}

interface PosterModule {
  enabled: boolean;
  init: () => Promise<unknown>;
  createStencil: (
    canvas: HTMLCanvasElement,
    hue?: number,
  ) => PosterStencil | Promise<PosterStencil>;
}

declare global {
  interface Window {
    __OMP_POSTER_MODULE__?: PosterModule;
  }
}

let posterModulePromise: Promise<PosterModule> | null = null;

function loadPosterModule(): Promise<PosterModule> {
  if (window.__OMP_POSTER_MODULE__) {
    return Promise.resolve(window.__OMP_POSTER_MODULE__);
  }
  if (posterModulePromise) return posterModulePromise;

  const loadPromise = new Promise<PosterModule>((resolve, reject) => {
    document.getElementById(POSTER_LOADER_ID)?.remove();

    const script = document.createElement("script");
    script.id = POSTER_LOADER_ID;
    script.type = "module";
    script.src = POSTER_LOADER_SRC;
    script.addEventListener(
      "load",
      () => {
        const posterModule = window.__OMP_POSTER_MODULE__;
        if (posterModule) {
          resolve(posterModule);
          return;
        }
        script.remove();
        reject(new Error("OMP poster module loaded without exposing its API"));
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        script.remove();
        reject(new Error(`Failed to load ${POSTER_LOADER_SRC}`));
      },
      { once: true },
    );
    document.head.append(script);
  });

  posterModulePromise = loadPromise.catch((error: unknown) => {
    posterModulePromise = null;
    throw error;
  });
  return posterModulePromise;
}

const webDotCloudScanlineStyle =
  Platform.OS === "web"
    ? inlineUnistylesStyle<ViewStyle & Pick<CSSProperties, "backgroundImage">>({
        backgroundImage:
          "repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.4) 0 1px, transparent 1px 3px)",
      })
    : null;

function OmpDotCloud({ animationsEnabled }: { animationsEnabled: boolean }) {
  const hostRef = useRef<View>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || !("gpu" in navigator)) return;

    const loadedPosterModule = window.__OMP_POSTER_MODULE__;
    if (!animationsEnabled) {
      if (loadedPosterModule) loadedPosterModule.enabled = false;
      return;
    }
    if (loadedPosterModule) loadedPosterModule.enabled = true;

    const host = hostRef.current as unknown as HTMLDivElement | null;
    if (!host) return;

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      imageRendering: "pixelated",
    });
    host.append(canvas);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stencil: PosterStencil | null = null;
    let animationFrame: number | null = null;
    let resizeFrame: number | null = null;
    let elapsedMs = 0;
    let startedAt: number | null = null;
    let disposed = false;

    const resolveRenderSize = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(320, bounds.width);
      const height = Math.max(240, bounds.height);
      const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const budgetScale = Math.sqrt(POSTER_PIXEL_BUDGET / (width * height));
      const renderScale = Math.max(0.55, Math.min(devicePixelRatio, budgetScale));
      return {
        width: Math.round(width * renderScale),
        height: Math.round(height * renderScale),
      };
    };

    const stopAnimation = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
    };
    const renderFrame = (timestamp: number) => {
      if (!stencil || startedAt === null) return;
      elapsedMs = timestamp - startedAt;
      stencil.render(elapsedMs);
      animationFrame = window.requestAnimationFrame(renderFrame);
    };
    const startAnimation = () => {
      if (!stencil || animationFrame !== null || reducedMotion.matches || !animationsEnabled)
        return;
      startedAt = performance.now() - elapsedMs;
      animationFrame = window.requestAnimationFrame(renderFrame);
    };
    const resizeAndRender = () => {
      if (!stencil) return;
      const size = resolveRenderSize();
      stencil.resize(size.width, size.height);
      stencil.render(elapsedMs);
    };
    const scheduleResize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        resizeAndRender();
      });
    };
    const handleMotionChange = () => {
      if (reducedMotion.matches || !animationsEnabled) {
        stopAnimation();
        stencil?.render(elapsedMs);
      } else {
        startAnimation();
      }
    };

    const resizeObserver = new ResizeObserver(scheduleResize);
    resizeObserver.observe(host);
    reducedMotion.addEventListener("change", handleMotionChange);
    window.addEventListener("pagehide", stopAnimation, { once: true });

    const initializeFrame = window.requestAnimationFrame(() => {
      void (async () => {
        const posterModule = await loadPosterModule();
        if (disposed || !posterModule.enabled) {
          canvas.remove();
          return;
        }
        await posterModule.init();
        if (disposed) return;

        const nextStencil = await posterModule.createStencil(canvas, POSTER_HUE);
        if (disposed) {
          nextStencil.free();
          return;
        }
        stencil = nextStencil;
        resizeAndRender();
        startAnimation();
      })().catch((error: unknown) => {
        if (!disposed) {
          console.error("Failed to initialize the OMP poster renderer", error);
        }
      });
    });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(initializeFrame);
      stopAnimation();
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeObserver.disconnect();
      reducedMotion.removeEventListener("change", handleMotionChange);
      window.removeEventListener("pagehide", stopAnimation);
      stencil?.free();
      canvas.remove();
    };
  }, [animationsEnabled]);

  return (
    <>
      <View
        ref={hostRef}
        pointerEvents="none"
        style={styles.dotCloudCanvasHost}
        testID="omp-dot-cloud"
      />
      <View pointerEvents="none" style={[styles.dotCloudScanlines, webDotCloudScanlineStyle]} />
    </>
  );
}

export function OpenProjectScreen() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const router = useRouter();
  const openDesktopAgentList = usePanelStore((s) => s.openDesktopAgentList);
  const openProjectPicker = useOpenAddProject();
  const localServerId = useLocalDaemonServerId();
  const hosts = useHosts();
  const [importServerId, setImportServerId] = useState<string | null>(null);
  const importClient = useHostRuntimeClient(importServerId ?? "");
  const openImportedProject = useOpenProject(importServerId);
  const [isImportSheetOpen, setIsImportSheetOpen] = useState(false);
  const {
    settings: { homeAnimationsEnabled: storedHomeAnimationsEnabled },
    isLoading: areSettingsLoading,
    updateSettings,
  } = useAppSettings();
  const background = usePluginBackgroundState();
  const showHomeEffects = !areSettingsLoading && background.status !== "loading" && background.status !== "ready";
  const homeAnimationsEnabled = showHomeEffects && storedHomeAnimationsEnabled;
  // The poster, its scanlines and the brand glows are drawn for a dark canvas. Light schemes keep
  // Cursor Light's flat canvas and an ink mark instead.
  const isLight = theme.colorScheme === "light";

  const isCompactLayout = useIsCompactFormFactor();

  useEffect(() => {
    if (!isCompactLayout) {
      openDesktopAgentList();
    }
  }, [isCompactLayout, openDesktopAgentList]);

  const handleOpenPicker = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleOpenProviders = useCallback(() => {
    const serverId = resolveActiveHostServerId({
      selectedServerId: null,
      localServerId,
      hosts,
      orderedHosts: hosts,
    });
    router.push(
      serverId
        ? buildSettingsHostSectionRoute(serverId, "providers")
        : buildSettingsAddHostRoute(Date.now()),
    );
  }, [hosts, localServerId, router]);

  const handleOpenImportSession = useCallback(() => {
    if (!localServerId) return;
    setImportServerId(localServerId);
    setIsImportSheetOpen(true);
  }, [localServerId]);
  const handleCloseImportSession = useCallback(() => setIsImportSheetOpen(false), []);
  const handleAnimationsChange = useCallback(
    (enabled: boolean) => {
      void updateSettings({ homeAnimationsEnabled: enabled });
    },
    [updateSettings],
  );

  const handleImported = useCallback(
    (agent: { id: string; cwd: string }) => {
      if (!importServerId) return;
      void (async () => {
        const result = await openImportedProject(agent.cwd);
        if (result.ok) {
          router.push(buildHostAgentDetailRoute(importServerId, agent.id) as Href);
        }
      })();
    },
    [importServerId, openImportedProject, router],
  );

  const backgroundStyle = useMemo(
    () =>
      Platform.OS === "web" && !isLight && showHomeEffects
        ? inlineUnistylesStyle({
            backgroundColor: theme.colors.surface0,
            backgroundImage: [
              "radial-gradient(circle at 90% 108%, rgba(248, 79, 204, 0.08), transparent 38%)",
              "conic-gradient(rgba(255, 255, 255, 0.022) 90deg, transparent 90deg 180deg, rgba(255, 255, 255, 0.022) 180deg 270deg, transparent 270deg)",
            ].join(", "),
            backgroundSize: "auto, 2px 2px",
          })
        : null,
    [isLight, showHomeEffects, theme.colors.surface0],
  );

  return (
    <View style={[styles.container, backgroundStyle]}>
      {showHomeEffects && !isLight ? (
        <OmpDotCloud animationsEnabled={homeAnimationsEnabled} />
      ) : null}
      <MenuHeader borderless />
      <View style={styles.content}>
        <TitlebarDragRegion />
        <View style={styles.brand}>
          <View style={[styles.brandMark, isLight ? styles.brandMarkLight : webBrandMarkStyle]}>
            <OmpIcon
              size={58}
              color={theme.colors.foreground}
              gradientColors={isLight ? undefined : OMP_BRAND_GRADIENT}
            />
          </View>
          <View style={styles.brandCaption}>
            <Text style={styles.brandName}>OMP</Text>
            <View style={[styles.brandCaptionRule, isLight && styles.brandCaptionRuleLight]} />
            <Text style={styles.brandMeta}>DESKTOP</Text>
          </View>
        </View>
        {showHomeEffects ? (
          <View style={styles.motionPreference}>
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Sparkles size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            </View>
            <Switch
              value={homeAnimationsEnabled}
              onValueChange={handleAnimationsChange}
              accessibilityLabel={t("openProject.motion.accessibilityLabel")}
              testID="home-animations-switch"
            />
          </View>
        ) : null}
        <View style={styles.tiles}>
          <HomeTile
            index="01"
            accent="cyan"
            icon={Boxes}
            title={t("openProject.tiles.providers.title")}
            description={t("openProject.tiles.providers.description")}
            onPress={handleOpenProviders}
            testID="open-project-providers"
            animationsEnabled={homeAnimationsEnabled}
          />
          <HomeTile
            index="02"
            accent="magenta"
            icon={FolderOpen}
            title={t("openProject.tiles.addProject.title")}
            description={t("openProject.tiles.addProject.description")}
            onPress={handleOpenPicker}
            testID="open-project-submit"
            animationsEnabled={homeAnimationsEnabled}
          />
          <HomeTile
            index="03"
            accent="cyan"
            icon={Inbox}
            title={t("openProject.tiles.importSession.title")}
            description={t("openProject.tiles.importSession.description")}
            onPress={handleOpenImportSession}
            testID="open-project-import-session"
            animationsEnabled={homeAnimationsEnabled}
          />
        </View>
      </View>
      <ImportSessionSheet
        visible={isImportSheetOpen}
        client={importClient}
        serverId={importServerId}
        onClose={handleCloseImportSession}
        onImported={handleImported}
      />
    </View>
  );
}

interface HomeTileProps {
  index: string;
  accent: TileAccent;
  icon: ComponentType<{ size: number; color: string }>;
  title: string;
  description: string;
  onPress: () => void;
  testID?: string;
  animationsEnabled: boolean;
}

function HomeTile({
  index,
  accent,
  icon: Icon,
  title,
  description,
  onPress,
  testID,
  animationsEnabled,
}: HomeTileProps) {
  // useUnistyles is acceptable here: leaf component, off the hot path (home screen renders once).
  const { theme } = useUnistyles();
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const accentStyle = TILE_ACCENTS[accent];
  // Light tiles trade the neon accent for ink: the icon rests muted and darkens with the arrow.
  const isLight = theme.colorScheme === "light";
  const hoverColor = isLight ? theme.colors.foreground : accentStyle.color;
  const restingIconColor = isLight ? theme.colors.foregroundMuted : accentStyle.color;
  const hoverShadow = isLight ? LIGHT_TILE_HOVER_SHADOW : `0 18px 54px ${accentStyle.glow}`;

  const webTileStyle = useMemo(
    () =>
      Platform.OS === "web"
        ? inlineUnistylesStyle({
            boxShadow: hovered ? hoverShadow : "0 0 0 transparent",
            transition: animationsEnabled
              ? "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease"
              : "none",
          })
        : null,
    [animationsEnabled, hoverShadow, hovered],
  );

  const pressableStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.tile,
      hovered && animationsEnabled && styles.tileHovered,
      isLight && styles.tileLight,
      pressed && styles.tilePressed,
      webTileStyle,
    ],
    [animationsEnabled, hovered, isLight, webTileStyle],
  );

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      testID={testID}
      style={pressableStyle}
    >
      {isLight ? null : (
        <View
          style={[
            styles.tileSignal,
            { backgroundColor: accentStyle.color, width: hovered && animationsEnabled ? 76 : 32 },
          ]}
        />
      )}
      <View style={styles.tileHeader}>
        <View style={[styles.iconFrame, !isLight && { borderColor: accentStyle.color }]}>
          <Icon size={22} color={hovered ? hoverColor : restingIconColor} />
        </View>
        <View style={styles.tileMeta}>
          <Text style={styles.tileIndex}>{index}</Text>
          <ArrowRight size={16} color={hovered ? hoverColor : theme.colors.foregroundExtraMuted} />
        </View>
      </View>
      <View style={styles.tileText}>
        <Text style={styles.tileTitle}>{title}</Text>
        <Text style={styles.tileDescription}>{description}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    userSelect: "none",
  },
  dotCloudCanvasHost: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    transform: [{ scaleY: -1 }],
  },
  dotCloudScanlines: {
    position: "absolute",
    inset: 0,
    opacity: 0.35,
  },
  content: {
    position: "relative",
    flex: 1,
    justifyContent: { xs: "flex-start", md: "center" },
    alignItems: "center",
    padding: theme.spacing[6],
    paddingTop: { xs: theme.spacing[8] + theme.spacing[2], md: theme.spacing[6] },
    overflow: "hidden",
    paddingBottom: {
      xs: HEADER_INNER_HEIGHT_MOBILE + HEADER_TOP_PADDING_MOBILE + theme.spacing[6],
      md: HEADER_INNER_HEIGHT + theme.spacing[6],
    },
  },
  brand: {
    alignItems: "center",
    gap: theme.spacing[4],
  },
  brandMark: {
    width: 86,
    height: 86,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderTopColor: OMP_MAGENTA,
    borderBottomColor: OMP_CYAN,
    borderRadius: theme.borderRadius.lg,
  },
  // Light schemes trade the neon edges and glow for the canvas outline and Cursor's widget shadow.
  brandMarkLight: {
    backgroundColor: theme.colors.surface0,
    borderTopColor: theme.colors.border,
    borderBottomColor: theme.colors.border,
    ...theme.shadow.sm,
  },
  brandCaption: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  brandName: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 2.2,
  },
  brandCaptionRule: {
    width: 20,
    height: 1,
    backgroundColor: OMP_MAGENTA,
  },
  brandCaptionRuleLight: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  brandMeta: {
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: 9,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 1.8,
  },
  motionPreference: {
    marginTop: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  tiles: {
    marginTop: { xs: theme.spacing[8], md: theme.spacing[12] },
    width: "100%",
    maxWidth: { xs: 452, md: 732 },
    flexDirection: "row",
    flexWrap: { xs: "wrap", md: "nowrap" },
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  tile: {
    position: "relative",
    width: { xs: "100%", md: 236 },
    minHeight: { xs: 112, md: 156 },
    padding: { xs: theme.spacing[4], md: theme.spacing[4] + theme.spacing[1] },
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    gap: { xs: theme.spacing[3], md: theme.spacing[4] + theme.spacing[1] },
    overflow: "hidden",
  },
  tileHovered: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.borderAccent,
    transform: [{ translateY: -3 }],
  },
  // Light tiles stay on the canvas, hovered or not; the lift reads through the outline and shadow.
  tileLight: {
    backgroundColor: theme.colors.surface0,
  },
  tilePressed: {
    opacity: 0.82,
    transform: [{ translateY: 0 }],
  },
  tileSignal: {
    position: "absolute",
    top: -1,
    left: theme.spacing[4] + theme.spacing[1],
    height: 2,
  },
  tileHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  iconFrame: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
  },
  tileMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tileIndex: {
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 1.8,
  },
  tileText: {
    gap: theme.spacing[1],
  },
  tileTitle: {
    color: theme.colors.foreground,
    fontSize: 17,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: -0.2,
  },
  tileDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
}));

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";
import { Platform } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { useAppSettings } from "@/hooks/use-settings";
import { buildWallpaperMediaSrc } from "@/wallpaper/media-src";
import { setCssColorAlpha } from "@/wallpaper/color";
import { getEffectiveWallpaperSourceKey, parseRemoteWallpaperSource } from "@/wallpaper/source";
import { acquireWallpaperBackground, useWallpaperLibrary } from "./desktop-client";
import {
  beginWallpaperLoad,
  endWallpaperLoad,
  finishWallpaperLoad,
  useWallpaperLoadStatus,
  useWallpaperRetryRevision,
} from "./load-state";
import type { WallpaperMediaKind } from "@omp-desktop/protocol/desktop-wallpaper";

interface LoadAttempt {
  key: string;
  token: number;
}
interface ResolvedWallpaperSource extends LoadAttempt {
  src: string;
  kind: WallpaperMediaKind;
}

const LAYER_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 0,
  overflow: "hidden",
  pointerEvents: "none",
};
const MEDIA_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
};

function WallpaperMedia({
  source,
  style,
}: {
  source: ResolvedWallpaperSource;
  style: CSSProperties;
}) {
  const token = source.token;
  const markFailed = useCallback(() => finishWallpaperLoad(token, "error"), [token]);
  const markReady = useCallback(() => finishWallpaperLoad(token, "ready"), [token]);
  const handleVideoReady = useCallback(
    (event: SyntheticEvent<HTMLVideoElement>) => {
      const video = event.currentTarget;
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        finishWallpaperLoad(token, "ready");
      }
    },
    [token],
  );
  if (source.kind === "video") {
    return (
      <video
        src={source.src}
        style={style}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        onLoadedData={handleVideoReady}
        onError={markFailed}
      />
    );
  }
  return <img src={source.src} alt="" style={style} onLoad={markReady} onError={markFailed} />;
}

function WallpaperBackgroundBase({ canvasColor }: { canvasColor: string }) {
  const { settings, isLoading } = useAppSettings();
  const { library, error: libraryError } = useWallpaperLibrary();
  const configuredKey = isLoading
    ? null
    : getEffectiveWallpaperSourceKey(settings, libraryError ? null : library);
  const retryRevision = useWallpaperRetryRevision();
  const loadStatus = useWallpaperLoadStatus(configuredKey);
  const [attempt, setAttempt] = useState<LoadAttempt | null>(null);
  const [localSource, setLocalSource] = useState<ResolvedWallpaperSource | null>(null);
  const candidateId =
    settings.wallpaperSource === "file" && configuredKey ? settings.wallpaperCandidateId : null;
  const remoteSource = useMemo(
    () =>
      settings.wallpaperSource === "url" ? parseRemoteWallpaperSource(settings.wallpaperUrl) : null,
    [settings.wallpaperSource, settings.wallpaperUrl],
  );

  useLayoutEffect(() => {
    const token = beginWallpaperLoad(configuredKey);
    setAttempt(configuredKey ? { key: configuredKey, token } : null);
    return () => endWallpaperLoad(token);
  }, [configuredKey, retryRevision]);

  useEffect(() => {
    if (!attempt || attempt.key !== configuredKey || !candidateId) return;
    let cancelled = false;
    const lease = acquireWallpaperBackground(candidateId);
    void lease.result
      .then((media) => {
        if (cancelled) return;
        if (!media || media.candidateId !== candidateId) {
          return finishWallpaperLoad(attempt.token, "error");
        }
        return setLocalSource({
          ...attempt,
          src: buildWallpaperMediaSrc(media.id),
          kind: media.kind,
        });
      })
      .catch(() => {
        if (!cancelled) finishWallpaperLoad(attempt.token, "error");
      });
    return () => {
      cancelled = true;
      lease.release();
    };
  }, [attempt, candidateId, configuredKey]);

  const source = useMemo<ResolvedWallpaperSource | null>(() => {
    if (!attempt || attempt.key !== configuredKey) return null;
    if (remoteSource && settings.wallpaperSource === "url") {
      return { ...remoteSource, ...attempt };
    }
    return localSource?.token === attempt.token ? localSource : null;
  }, [attempt, configuredKey, remoteSource, settings.wallpaperSource, localSource]);
  const opacity = Math.max(0, Math.min(1, settings.wallpaperOpacity));
  const layerStyle = useMemo<CSSProperties>(
    () => ({ ...LAYER_STYLE, backgroundColor: canvasColor }),
    [canvasColor],
  );
  const mediaStyle = useMemo<CSSProperties>(() => ({ ...MEDIA_STYLE, opacity }), [opacity]);

  if (Platform.OS !== "web" || !configuredKey) return null;
  return (
    <div style={layerStyle} aria-hidden="true">
      {source && loadStatus !== "error" ? (
        <WallpaperMedia key={source.token} source={source} style={mediaStyle} />
      ) : null}
    </div>
  );
}

export const WallpaperBackground = withUnistyles(WallpaperBackgroundBase, (theme) => ({
  canvasColor: setCssColorAlpha(theme.colors.surface0, 1),
}));

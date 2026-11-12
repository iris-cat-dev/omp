import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { PluginSettingsPageProps } from "@omp-desktop/plugin";
import { useWallpaperController, useWallpaperSnapshot } from "./context.js";
import { WallpaperCandidateGrid, type WallpaperCandidateGridHandle } from "./wallpaper-candidate-grid.js";
import type { WallpaperGridAppearance } from "./wallpaper-candidate-cell.js";
import type { WallpaperConfiguration } from "./source.js";

const ROW_STYLE: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, padding: "16px 0" };
const INPUT_STYLE: CSSProperties = { color: "inherit", background: "var(--wallpaper-solid)", font: "inherit", border: "1px solid var(--colors-border, #666)", borderRadius: 6, padding: "8px 10px", minWidth: 160 };
const TOOLBAR_STYLE: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 0" };
const BUTTON_STYLE: CSSProperties = { ...INPUT_STYLE, minWidth: 0, cursor: "pointer" };
const HINT_STYLE: CSSProperties = { color: "var(--wallpaper-muted)", margin: "4px 0", overflowWrap: "anywhere" };

export function WallpaperSettings({ theme, layout, installation }: PluginSettingsPageProps) {
  const { t } = useTranslation();
  const controller = useWallpaperController();
  const state = useWallpaperSnapshot();
  const config = state.configuration;
  const [operationError, setOperationError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"adding" | "removing" | null>(null);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [rejections, setRejections] = useState<Array<{ path: string; message: string }>>([]);
  const [draftUrl, setDraftUrl] = useState(config.url ?? "");
  const [draftOpacity, setDraftOpacity] = useState<number | null>(null);
  const urlEditing = useRef(false);
  const latestOpacity = useRef<number | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const grid = useRef<WallpaperCandidateGridHandle>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.previewOpacity(null); };
  }, [controller]);
  useEffect(() => { if (!urlEditing.current) setDraftUrl(config.url ?? ""); }, [config.url]);
  useEffect(() => {
    const members = new Set(state.library?.items.map(item => item.candidateId));
    setSelected(previous => new Set([...previous].filter(id => members.has(id))));
    if (state.library?.items.length === 0) { setConfirming(false); setFocusRequest(0); }
  }, [state.library]);
  useLayoutEffect(() => {
    if (confirming && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [confirming]);
  useEffect(() => {
    if (focusRequest === null || confirming || busy) return;
    const frame = requestAnimationFrame(() => {
      if (state.library?.items.length) grid.current?.focusNearest(focusRequest);
      else addButton.current?.focus();
      setFocusRequest(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, confirming, busy, state.library]);
  const fail = useCallback((error: unknown) => {
    if (mounted.current) setOperationError(error instanceof Error ? error.message : String(error));
  }, []);
  const patch = useCallback(async (fields: Partial<WallpaperConfiguration>) => {
    setOperationError(null);
    try { await controller.patch(fields); return true; } catch (error) { fail(error); return false; }
  }, [controller, fail]);
  const handleApply = useCallback(async (candidateId: string) => {
    const retry = config.source === "file" && config.candidateId === candidateId;
    const applied = await patch({ source: "file", candidateId });
    if (applied && retry) controller.retry();
  }, [config.source, config.candidateId, patch, controller]);
  const handleActivate = useCallback((id: string) => {
    if (busyRef.current) return;
    if (!managing) { void handleApply(id); return; }
    setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, [managing, handleApply]);
  const handleAdd = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy("adding"); setOperationError(null); setResult(null); setRejections([]);
    try {
      const response = await controller.add({ title: t("settings.appearance.wallpaper.library.pickerTitle"),
        mediaLabel: t("settings.appearance.wallpaper.library.mediaFilter"), imageLabel: t("settings.appearance.wallpaper.library.imageFilter"),
        videoLabel: t("settings.appearance.wallpaper.library.videoFilter") });
      if (!mounted.current || response.cancelled) return;
      setResult(t("settings.appearance.wallpaper.library.addResult", { added: response.added.length, duplicates: response.duplicates.length, failed: response.rejected.length }));
      setRejections(response.rejected);
    } catch (error) { fail(error); }
    finally { busyRef.current = false; if (mounted.current) setBusy(null); }
  }, [controller, t, fail]);
  const handleRemove = useCallback(async () => {
    if (busyRef.current || !selected.size) return;
    const nearest = state.library?.items.findIndex(item => selected.has(item.candidateId)) ?? 0;
    busyRef.current = true; setBusy("removing"); setOperationError(null);
    try {
      const response = await controller.remove([...selected]);
      if (!mounted.current) return;
      setSelected(new Set()); setConfirming(false); setRejections([]);
      setResult(t("settings.appearance.wallpaper.library.removed", { count: response.removedCandidateIds.length }));
      setFocusRequest(Math.max(0, nearest));
    } catch (error) { fail(error); }
    finally { busyRef.current = false; if (mounted.current) setBusy(null); }
  }, [selected, state.library, controller, t, fail]);
  const commitOpacity = useCallback(() => {
    const value = latestOpacity.current;
    if (value === null) return;
    latestOpacity.current = null;
    void patch({ opacity: value }).finally(() => { if (mounted.current) setDraftOpacity(null); controller.previewOpacity(null); });
  }, [patch, controller]);
  const appearance = useMemo<WallpaperGridAppearance>(() => ({ gap: 12, nameGap: 4, fontSize: "inherit", fontFamily: "inherit",
    primary: theme.colors.accent, foreground: theme.colors.foreground, muted: theme.colors.foregroundMuted,
    border: "var(--colors-border, #666)", surface0: theme.colors.surface0, surface2: theme.colors.surface0, radius: 6, smallRadius: 3 }), [theme]);
  const rootStyle = useMemo<CSSProperties>(() => ({ color: theme.colors.foreground, font: "inherit", maxWidth: 860,
    "--wallpaper-solid": theme.colors.surface0, "--wallpaper-muted": theme.colors.foregroundMuted } as CSSProperties), [theme]);
  const current = config.source === "file" ? state.library?.items.find(item => item.candidateId === config.candidateId) : null;
  const error = operationError ?? state.error ?? state.migrationError ?? state.cleanupError;
  if (layout.platform !== "web") return <p role="alert">{t("settings.appearance.wallpaper.library.previewUnavailable")}</p>;
  return <section style={rootStyle} aria-label={t("settings.appearance.wallpaper.title")} data-testid="wallpaper-settings">
    {state.loading ? <p style={HINT_STYLE}>{t("settings.appearance.wallpaper.library.loading")}</p> : null}
    {state.migrationStatus?.pending ? <p style={HINT_STYLE}>{t("settings.appearance.wallpaper.library.loading")}</p> : null}
    {state.migrationStatus?.reason ? <p role="alert" style={HINT_STYLE}>{t("settings.appearance.wallpaper.library.operationError", { message: state.migrationStatus.reason })}</p> : null}
    <div style={ROW_STYLE}>
      <label htmlFor="wallpaper-source">{t("settings.appearance.wallpaper.source.label")}</label>
      <select id="wallpaper-source" value={config.source} style={INPUT_STYLE} disabled={state.loading} onChange={event => void patch({ source: event.currentTarget.value as WallpaperConfiguration["source"] })}>
        {(["none", "file", "url"] as const).map(source => <option key={source} value={source}>{t(`settings.appearance.wallpaper.source.${source}`)}</option>)}
      </select>
    </div>
    {config.source === "url" ? <div style={ROW_STYLE}>
      <div><label htmlFor="wallpaper-url">{t("settings.appearance.wallpaper.url.label")}</label><p style={HINT_STYLE}>{t("settings.appearance.wallpaper.url.hint")}</p></div>
      <input id="wallpaper-url" type="url" value={draftUrl} style={INPUT_STYLE} data-testid="wallpaper-url-input"
        onFocus={() => { urlEditing.current = true; }} onChange={event => setDraftUrl(event.currentTarget.value)}
        onBlur={() => { urlEditing.current = false; void patch({ url: draftUrl || null }); }} />
    </div> : null}
    <div style={ROW_STYLE}>
      <div><label htmlFor="wallpaper-opacity">{t("settings.appearance.wallpaper.opacity.label")}</label><p style={HINT_STYLE}>{t("settings.appearance.wallpaper.opacity.hint")}</p></div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, width: 240 }}>
        <input id="wallpaper-opacity" type="range" min={0} max={100} step={1} disabled={state.loading} value={Math.round((draftOpacity ?? config.opacity) * 100)} style={{ flex: 1, accentColor: theme.colors.accent }}
          onChange={event => { const opacity = event.currentTarget.valueAsNumber / 100; latestOpacity.current = opacity; setDraftOpacity(opacity); controller.previewOpacity(opacity); }}
          onPointerUp={commitOpacity} onKeyUp={commitOpacity} onBlur={commitOpacity} />
        <span>{Math.round((draftOpacity ?? config.opacity) * 100)}%</span>
      </div>
    </div>
    {installation.enabled && state.loadStatus === "error" ? <div role="alert"><p style={HINT_STYLE}>{t("settings.appearance.wallpaper.loadError")} {state.loadError}</p><button style={BUTTON_STYLE} onClick={controller.retry}>{t("settings.appearance.wallpaper.library.retry")}</button></div> : null}
    {error && !confirming ? <div role="alert"><p style={HINT_STYLE}>{t("settings.appearance.wallpaper.library.operationError", { message: error })}</p>
      {state.error || state.migrationError ? <button style={BUTTON_STYLE} onClick={() => { setOperationError(null); void controller.reloadConfiguration(); void controller.reloadMigrationStatus(); }}>{t("settings.appearance.wallpaper.library.retry")}</button> : null}
    </div> : null}
    <div data-testid="wallpaper-library">
      <h3>{t("settings.appearance.wallpaper.library.title")}</h3>
      <p style={HINT_STYLE} data-testid="wallpaper-current-summary">{t("settings.appearance.wallpaper.library.current", { name: current ? `${current.name} — ${current.path}` : t("settings.appearance.wallpaper.library.theme") })}</p>
      <div style={TOOLBAR_STYLE}>
        <button ref={addButton} style={BUTTON_STYLE} data-testid="wallpaper-add-files" disabled={!!busy || state.loading || !!state.libraryError} onClick={() => void handleAdd()}>{t(`settings.appearance.wallpaper.library.${busy === "adding" ? "adding" : "add"}`)}</button>
        <button style={BUTTON_STYLE} data-testid="wallpaper-manage" disabled={!!busy || (!managing && !state.library?.items.length)} onClick={() => { setManaging(value => !value); setSelected(new Set()); }}>{t(`settings.appearance.wallpaper.library.${managing ? "done" : "manage"}`)}</button>
        {managing ? <button style={{ ...BUTTON_STYLE, color: theme.colors.statusDanger }} data-testid="wallpaper-remove-selected" disabled={!!busy || !selected.size} onClick={() => { setOperationError(null); setConfirming(true); }}>{t("settings.appearance.wallpaper.library.remove", { count: selected.size })}</button> : null}
      </div>
      {state.libraryError ? <div role="alert"><p style={HINT_STYLE}>{t("settings.appearance.wallpaper.library.loadError")} {state.libraryError}</p><button style={BUTTON_STYLE} onClick={() => void controller.reloadLibrary()}>{t("settings.appearance.wallpaper.library.retry")}</button></div> : null}
      {result ? <p style={HINT_STYLE} aria-live="polite" data-testid="wallpaper-batch-result">{result}</p> : null}
      {rejections.length ? <div style={{ maxHeight: 160, overflowY: "auto" }}>{rejections.map((failure, index) => <p key={`${failure.path}:${index}`} style={HINT_STYLE}>{failure.path}: {failure.message}</p>)}</div> : null}
      {!state.libraryError && state.library?.items.length === 0 ? <p style={HINT_STYLE} data-testid="wallpaper-library-empty">{t("settings.appearance.wallpaper.library.empty")}</p> : null}
      {state.library?.items.length ? <WallpaperCandidateGrid ref={grid} items={state.library.items} currentId={config.source === "file" ? config.candidateId : null} managing={managing} selectedIds={selected} disabled={!!busy} onActivate={handleActivate} onEmptyFocus={() => addButton.current?.focus()} appearance={appearance} /> : null}
    </div>
    {confirming ? <dialog ref={dialog} aria-label={t("settings.appearance.wallpaper.library.removeTitle", { count: selected.size })}
      onCancel={event => { if (busy) event.preventDefault(); else { setConfirming(false); setFocusRequest(0); } }}
      style={{ color: theme.colors.foreground, background: theme.colors.surface0, border: "1px solid var(--colors-border, #666)", borderRadius: 12, padding: 24, maxWidth: 440 }}>
      <h3>{t("settings.appearance.wallpaper.library.removeTitle", { count: selected.size })}</h3>
      <p>{t("settings.appearance.wallpaper.library.removeMessage")}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div style={TOOLBAR_STYLE}><button style={BUTTON_STYLE} disabled={!!busy} onClick={() => { setConfirming(false); setFocusRequest(0); }}>{t("settings.appearance.wallpaper.library.cancel")}</button>
        <button style={{ ...BUTTON_STYLE, color: theme.colors.statusDanger }} data-testid="wallpaper-confirm-remove" disabled={!!busy} onClick={() => void handleRemove()}>{t("settings.appearance.wallpaper.library.confirmRemove")}</button></div>
    </dialog> : null}
  </section>;
}

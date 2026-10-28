import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type SyntheticEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { UnistylesRuntime, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import {
  VisualFeedbackSubmissionSchema,
  type VisualFeedbackAnnotation,
  type VisualFeedbackImage,
} from "@omp-desktop/protocol/visual-feedback";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import {
  annotationAnchor,
  arrowHead,
  commitAnnotations,
  createAnnotation,
  EMPTY_HISTORY,
  imagePoint,
  isFeedbackCancellation,
  MAX_ANNOTATIONS,
  MAX_PEN_POINTS,
  moveAnnotation,
  redoAnnotations,
  resizeRectangle,
  undoAnnotations,
  type EditorTool,
  type Point,
} from "./model";
import { exportPreview, imageDataUrl, importImage, loadImage } from "./image.web";
import type { VisualFeedbackEditorProps } from "./types";
export type { VisualFeedbackEditorProps } from "./types";

interface Gesture {
  pointerId: number;
  start: Point;
  id: string;
  original?: VisualFeedbackAnnotation;
  resize: boolean;
  points: Point[];
  draft: VisualFeedbackAnnotation;
}
const TOOLS: EditorTool[] = ["select", "point", "rectangle", "arrow", "pen"];
const TOOL_ICONS = { select: "↖", point: "⊙", rectangle: "▭", arrow: "↗", pen: "〰" };
const DRAW_STYLE: CSSProperties = { cursor: "crosshair", touchAction: "none" };
const SELECT_STYLE: CSSProperties = { cursor: "default", touchAction: "none" };
const NUMBER_STYLE: CSSProperties = { userSelect: "none" };
const RESIZE_STYLE: CSSProperties = { cursor: "nwse-resize" };

function stopPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}
function preventDrop(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
}

interface EditorSessionProps extends VisualFeedbackEditorProps {
  theme?: Theme;
}
const ThemedEditorSession = withUnistyles(EditorSession, (theme) => ({ theme }));
export function VisualFeedbackEditor(props: VisualFeedbackEditorProps) {
  return <ThemedEditorSession key={props.request.id} {...props} />;
}
function EditorSession({
  request,
  onSubmit,
  onCancel,
  captureScreenshot,
  theme = UnistylesRuntime.getTheme(),
}: EditorSessionProps) {
  const { t } = useTranslation();
  const label = useCallback((key: string) => t(`visualFeedback.${key}`), [t]);
  const [image, setImage] = useState<VisualFeedbackImage | undefined>(request.image);
  const [imageReady, setImageReady] = useState(false);
  const [history, setHistory] = useState(EMPTY_HISTORY);
  const [text, setText] = useState(request.text);
  const [feedback, setFeedback] = useState("");
  const [tool, setTool] = useState<EditorTool>("point");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<VisualFeedbackAnnotation | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [error, setError] = useState<string | null>(null);
  const [captureErrorDetail, setCaptureErrorDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [loadingImage, setLoadingImage] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const mounted = useRef(true);
  const submitting = useRef(false);
  const importing = useRef(false);
  const layer = useGlobalWebOverlayLayer("modal", true);
  const busy = pending || capturing || loadingImage;
  const annotations = history.present;
  const sourceUrl = useMemo(() => (image ? imageDataUrl(image) : undefined), [image]);
  const visibleAnnotations = useMemo(() => {
    if (!draft) return annotations;
    if (annotations.some((annotation) => annotation.id === draft.id)) {
      return annotations.map((annotation) => (annotation.id === draft.id ? draft : annotation));
    }
    return [...annotations, draft];
  }, [annotations, draft]);
  const fit = image
    ? Math.min(
        1,
        Math.max(1, viewport.width - 48) / image.width,
        Math.max(1, viewport.height - 48) / image.height,
      )
    : 1;
  const scale = fit * zoom;
  const cancel = useCallback(() => {
    if (submitting.current) return;
    onCancel();
  }, [onCancel]);
  const deleteSelected = useCallback(() => {
    if (busy || !selected) return;
    setHistory((current) =>
      commitAnnotations(
        current,
        current.present.filter((annotation) => annotation.id !== selected),
      ),
    );
    setSelected(null);
  }, [busy, selected]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        gesture.current = null;
        setDraft(null);
        cancel();
        return true;
      }
      const target = event.target;
      const editing =
        target instanceof HTMLElement &&
        (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable);
      if (
        !editing &&
        !busy &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        setHistory(event.shiftKey ? redoAnnotations : undoAnnotations);
        setDraft(null);
        gesture.current = null;
      } else if (!editing && !busy && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteSelected();
      }
      // Claim every key before global composer shortcuts; preserve native input/Tab defaults.
      return true;
    },
    [busy, cancel, deleteSelected],
  );
  const setScope = useWebOverlayRegistration({ active: true, layer, onKeyDown: handleKeyDown });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setImageReady(false);
    if (!image) return;
    void loadImage(image).then(
      () => {
        if (active) setImageReady(true);
        return undefined;
      },
      (cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error && cause.message === "invalidImage"
              ? "invalidImage"
              : "imageLoadError",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [image]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    setViewport({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (selected)
      document
        .getElementById(`visual-feedback-note-${selected}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const resetImage = useCallback(
    (next?: VisualFeedbackImage) => {
      setImage(next);
      setHistory(EMPTY_HISTORY);
      setDraft(null);
      gesture.current = null;
      setSelected(null);
      setZoom(1);
      setError(null);
      setNotice(image ? "replaced" : null);
      if (scrollRef.current) scrollRef.current.scrollTo(0, 0);
    },
    [image],
  );
  const allowReplacement = useCallback(() => {
    return (
      (annotations.length === 0 && history.past.length === 0 && history.future.length === 0) ||
      window.confirm(label("replaceConfirm"))
    );
  }, [annotations.length, history.past.length, history.future.length, label]);
  const receiveFile = useCallback(
    async (file: File) => {
      if (submitting.current || importing.current || !mounted.current) return;
      importing.current = true;
      setLoadingImage(true);
      setError(null);
      try {
        const next = await importImage(file);
        if (mounted.current && allowReplacement()) resetImage(next);
      } catch (cause) {
        if (mounted.current && !isFeedbackCancellation(cause))
          setError(
            cause instanceof Error && cause.message === "invalidImage"
              ? "invalidImage"
              : "imageLoadError",
          );
      } finally {
        importing.current = false;
        if (mounted.current) setLoadingImage(false);
      }
    },
    [allowReplacement, resetImage],
  );
  const capture = useCallback(async () => {
    if (!captureScreenshot || submitting.current || importing.current || !mounted.current) return;
    if (!allowReplacement()) return;
    importing.current = true;
    setCapturing(true);
    setError(null);
    setCaptureErrorDetail(null);
    try {
      // Invoke directly in the click path to retain browser screen-picker activation.
      const next = await captureScreenshot();
      await loadImage(next);
      if (mounted.current) resetImage(next);
    } catch (cause) {
      if (mounted.current && !isFeedbackCancellation(cause)) {
        setError("captureError");
        setCaptureErrorDetail(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      importing.current = false;
      if (mounted.current) setCapturing(false);
    }
  }, [allowReplacement, captureScreenshot, resetImage]);
  const submit = useCallback(async () => {
    if (
      submitting.current ||
      importing.current ||
      !mounted.current ||
      (image && !imageReady) ||
      gesture.current
    )
      return;
    submitting.current = true;
    setPending(true);
    setError(null);
    let submitted = false;
    try {
      const preview = image ? await exportPreview(image, annotations) : undefined;
      const submission = VisualFeedbackSubmissionSchema.parse({
        text,
        feedback,
        annotations,
        ...(image ? { image, preview } : {}),
      });
      if (!mounted.current) return;
      await onSubmit(submission);
      submitted = true;
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error &&
            ["previewError", "imageLoadError", "invalidImage"].includes(cause.message)
            ? cause.message
            : "submitError",
        );
    } finally {
      if (!submitted) {
        submitting.current = false;
        if (mounted.current) setPending(false);
      }
    }
  }, [annotations, feedback, image, imageReady, onSubmit, text]);
  const pointerPoint = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>): Point => {
      return imagePoint(
        { x: event.clientX, y: event.clientY },
        svgRef.current!.getBoundingClientRect(),
        image!,
      );
    },
    [image],
  );
  const pointerDown = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!image || !imageReady || busy || event.button !== 0 || gesture.current) return;
      event.preventDefault();
      const start = pointerPoint(event);
      const target =
        event.target instanceof Element ? event.target.closest("[data-annotation]") : null;
      const id = target?.getAttribute("data-annotation");
      if (tool === "select") {
        const original = annotations.find((annotation) => annotation.id === id);
        setSelected(original?.id ?? null);
        if (!original) return;
        gesture.current = {
          pointerId: event.pointerId,
          start,
          id: original.id,
          original,
          resize: target?.getAttribute("data-resize") === "true",
          points: [],
          draft: original,
        };
      } else {
        if (annotations.length >= MAX_ANNOTATIONS) {
          setError("maxAnnotations");
          return;
        }
        const newId = crypto.randomUUID();
        const annotation = createAnnotation(tool, start, start, newId, [start, start]);
        gesture.current = {
          pointerId: event.pointerId,
          start,
          id: newId,
          resize: false,
          points: [start],
          draft: annotation,
        };
        setSelected(newId);
        setDraft(annotation);
        setError(null);
      }
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [annotations, busy, image, imageReady, pointerPoint, tool],
  );
  const pointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId || !image) return;
      const end = pointerPoint(event);
      if (current.original) {
        current.draft =
          current.resize && current.original.kind === "rectangle"
            ? resizeRectangle(current.original, end, image)
            : moveAnnotation(
                current.original,
                { x: end.x - current.start.x, y: end.y - current.start.y },
                image,
              );
      } else {
        const kind = current.draft.kind;
        if (kind === "pen" && current.points.length < MAX_PEN_POINTS) {
          const previous = current.points.at(-1)!;
          if (Math.hypot(end.x - previous.x, end.y - previous.y) * scale >= 1)
            current.points.push(end);
        }
        current.draft = createAnnotation(
          kind,
          current.start,
          end,
          current.id,
          current.points.length > 1 ? current.points : [current.start, end],
        );
      }
      setDraft(current.draft);
    },
    [image, pointerPoint, scale],
  );
  const pointerUp = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      pointerMove(event);
      gesture.current = null;
      setDraft(null);
      const next = current.draft;
      if (!current.original) {
        let tooSmall = false;
        if (next.kind === "rectangle") tooSmall = Math.min(next.width, next.height) * scale < 3;
        else if (next.kind === "arrow")
          tooSmall = Math.hypot(next.x2 - next.x, next.y2 - next.y) * scale < 3;
        else if (next.kind === "pen")
          tooSmall = !next.points.some(
            (point) =>
              Math.hypot(point.x - current.start.x, point.y - current.start.y) * scale >= 3,
          );
        if (tooSmall) {
          setSelected(null);
          return;
        }
      }
      if (current.original && JSON.stringify(next) === JSON.stringify(current.original)) return;
      setHistory((previous) =>
        commitAnnotations(
          previous,
          current.original
            ? previous.present.map((annotation) => (annotation.id === next.id ? next : annotation))
            : [...previous.present, next],
        ),
      );
    },
    [pointerMove, scale],
  );
  const variables = useMemo<CSSProperties>(
    () => ({
      "--vf-bg": theme.colors.surface0,
      "--vf-panel": theme.colors.surface1,
      "--vf-border": theme.colors.border,
      "--vf-fg": theme.colors.foreground,
      "--vf-muted": theme.colors.foregroundMuted,
      "--vf-primary": theme.colors.primary,
      "--vf-primary-fg": theme.colors.primaryForeground,
      zIndex: layer,
      visibility: capturing ? "hidden" : "visible",
    }),
    [capturing, layer, theme],
  );
  const imageStyle = useMemo(
    () => (image ? { width: image.width * scale, height: image.height * scale } : undefined),
    [image, scale],
  );
  const openImagePicker = useCallback(() => fileRef.current?.click(), []);
  const selectTool = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    setTool(event.currentTarget.dataset.tool as EditorTool);
  }, []);
  const undo = useCallback(() => setHistory(undoAnnotations), []);
  const redo = useCallback(() => setHistory(redoAnnotations), []);
  const resetGesture = useCallback(() => {
    gesture.current = null;
    setDraft(null);
  }, []);
  const removeImage = useCallback(() => {
    if (allowReplacement()) resetImage();
  }, [allowReplacement, resetImage]);
  const zoomOut = useCallback(() => setZoom((value) => Math.max(0.25, value / 1.25)), []);
  const zoomIn = useCallback(() => setZoom((value) => Math.min(8, value * 1.25)), []);
  const fitImage = useCallback(() => {
    setZoom(1);
    scrollRef.current?.scrollTo(0, 0);
  }, []);
  const changeText = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value),
    [],
  );
  const changeFeedback = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => setFeedback(event.target.value),
    [],
  );
  const selectNote = useCallback((event: SyntheticEvent<HTMLElement>) => {
    setSelected(event.currentTarget.dataset.noteId ?? null);
    setTool("select");
  }, []);
  const deleteNote = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const id = event.currentTarget.dataset.noteId;
      setHistory((current) =>
        commitAnnotations(
          current,
          current.present.filter((entry) => entry.id !== id),
        ),
      );
      if (selected === id) setSelected(null);
    },
    [selected],
  );
  const changeNote = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const id = event.currentTarget.dataset.noteId;
    const value = event.target.value;
    setHistory((current) =>
      commitAnnotations(
        current,
        current.present.map((entry) => (entry.id === id ? { ...entry, text: value } : entry)),
      ),
    );
  }, []);
  const pasteImage = useCallback(
    (event: ClipboardEvent<HTMLElement>) => {
      event.stopPropagation();
      const item = Array.from(event.clipboardData.items).find(
        (entry) => entry.kind === "file" && entry.type.startsWith("image/"),
      );
      const file = item?.getAsFile();
      if (file) {
        event.preventDefault();
        void receiveFile(file);
      }
    },
    [receiveFile],
  );
  const dropImage = useCallback(
    (event: DragEvent<HTMLElement>) => {
      preventDrop(event);
      const file = event.dataTransfer.files[0];
      if (file) void receiveFile(file);
    },
    [receiveFile],
  );
  const chooseImage = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void receiveFile(file);
    },
    [receiveFile],
  );
  const imageControls = (
    <>
      <button type="button" disabled={busy} onClick={openImagePicker}>
        {label("import")}
      </button>
      {captureScreenshot && (
        <button type="button" disabled={busy} onClick={capture}>
          {label(capturing ? "capturing" : "screenshot")}
        </button>
      )}
    </>
  );
  function renderImagePanel() {
    return (
      <main className="vf-main">
        <div className="vf-toolbar" role="toolbar" aria-label={label("notes")}>
          <div className="vf-tool-group">
            {TOOLS.map((value) => (
              <button
                type="button"
                key={value}
                data-tool={value}
                title={label(value)}
                aria-label={label(value)}
                aria-pressed={tool === value}
                disabled={busy || !imageReady}
                onClick={selectTool}
              >
                <span aria-hidden="true">{TOOL_ICONS[value]}</span>
                <span className="vf-tool-label">{label(value)}</span>
              </button>
            ))}
          </div>
          <div className="vf-tool-group">
            <button
              type="button"
              title={label("undo")}
              aria-label={label("undo")}
              disabled={busy || history.past.length === 0}
              onClick={undo}
            >
              ↶
            </button>
            <button
              type="button"
              title={label("redo")}
              aria-label={label("redo")}
              disabled={busy || history.future.length === 0}
              onClick={redo}
            >
              ↷
            </button>
          </div>
        </div>
        <div className="vf-canvas-scroll" ref={scrollRef}>
          {image ? (
            <div className="vf-canvas-pad">
              <div className="vf-image" style={imageStyle}>
                {imageReady && <img src={sourceUrl} alt="" draggable={false} />}
                {imageReady && (
                  <svg
                    ref={svgRef}
                    viewBox={`0 0 ${image.width} ${image.height}`}
                    width="100%"
                    height="100%"
                    style={tool === "select" ? SELECT_STYLE : DRAW_STYLE}
                    onPointerDown={pointerDown}
                    onPointerMove={pointerMove}
                    onPointerUp={pointerUp}
                    onPointerCancel={resetGesture}
                    onLostPointerCapture={resetGesture}
                  >
                    {visibleAnnotations.map((annotation, index) => (
                      <AnnotationMark
                        key={annotation.id}
                        annotation={annotation}
                        number={index + 1}
                        scale={scale}
                        selected={selected === annotation.id}
                        image={image}
                      />
                    ))}
                  </svg>
                )}
              </div>
            </div>
          ) : (
            <div className="vf-empty">
              <div className="vf-empty-icon" aria-hidden="true">
                ▧
              </div>
              <h3>{label("emptyTitle")}</h3>
              <p>{label("emptyDescription")}</p>
              <div className="vf-image-actions">{imageControls}</div>
            </div>
          )}
        </div>
        <div className="vf-image-footer">
          <div className="vf-image-actions">
            {image && imageControls}
            {image && (
              <button type="button" disabled={busy} onClick={removeImage}>
                {label("removeImage")}
              </button>
            )}
          </div>
          {image && (
            <div className="vf-tool-group">
              <button
                type="button"
                aria-label={label("zoomOut")}
                disabled={busy || zoom <= 0.25}
                onClick={zoomOut}
              >
                −
              </button>
              <button type="button" disabled={busy} onClick={fitImage}>
                {label("fit")}
              </button>
              <span className="vf-zoom">{Math.round(scale * 100)}%</span>
              <button
                type="button"
                aria-label={label("zoomIn")}
                disabled={busy || zoom >= 8}
                onClick={zoomIn}
              >
                +
              </button>
            </div>
          )}
        </div>
        {image && (
          <p className="vf-hint">
            {label("imageHint")} · {image.width} × {image.height}
          </p>
        )}
      </main>
    );
  }
  function renderSidebar() {
    return (
      <aside className="vf-sidebar">
        {request.text.trim().length > 0 && (
          <label className="vf-field">
            <span>{label("text")}</span>
            <textarea
              value={text}
              maxLength={200000}
              disabled={pending}
              rows={6}
              onChange={changeText}
            />
          </label>
        )}
        <label className="vf-field">
          <span>{label("feedback")}</span>
          <textarea
            value={feedback}
            maxLength={100000}
            disabled={pending}
            rows={4}
            placeholder={label("feedbackPlaceholder")}
            onChange={changeFeedback}
          />
        </label>
        <div className="vf-notes-header">
          <h3>{label("notes")}</h3>
          <span className="vf-muted">
            {annotations.length} / {MAX_ANNOTATIONS}
          </span>
        </div>
        {annotations.length === 0 && <p className="vf-muted vf-note-help">{label("noNotes")}</p>}
        {annotations.map((annotation, index) => (
          <div
            key={annotation.id}
            data-note-id={annotation.id}
            id={`visual-feedback-note-${annotation.id}`}
            className={`vf-note ${selected === annotation.id ? "vf-note-selected" : ""}`}
            onClick={selectNote}
          >
            <div className="vf-note-heading">
              <button
                type="button"
                data-note-id={annotation.id}
                className="vf-note-number"
                aria-label={`${label(annotation.kind)} ${index + 1}`}
                onClick={selectNote}
              >
                {index + 1}
              </button>
              <span>{label(annotation.kind)}</span>
              <button
                type="button"
                data-note-id={annotation.id}
                className="vf-delete"
                disabled={busy}
                aria-label={`${label("delete")} ${index + 1}`}
                onClick={deleteNote}
              >
                ×
              </button>
            </div>
            <textarea
              data-note-id={annotation.id}
              aria-label={`${label("notes")} ${index + 1}`}
              value={annotation.text}
              maxLength={10000}
              rows={2}
              disabled={pending}
              placeholder={label("notePlaceholder")}
              onFocus={selectNote}
              onChange={changeNote}
            />
          </div>
        ))}
      </aside>
    );
  }
  let status = null;
  if (error) {
    status = (
      <p role="alert" className="vf-error">
        {label(error)}
        {error === "captureError" && captureErrorDetail ? ` ${captureErrorDetail}` : ""}
      </p>
    );
  } else if (notice) {
    status = <p>{label(notice)}</p>;
  }
  return createPortal(
    <OverlayLayerProvider layer={layer}>
      <div
        className="vf-overlay"
        style={variables}
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
      >
        <style>{EDITOR_CSS}</style>
        <section
          className="vf-dialog"
          ref={setScope}
          role="dialog"
          aria-modal="true"
          aria-labelledby="visual-feedback-title"
          tabIndex={-1}
          onKeyDown={stopPropagation}
          onPaste={pasteImage}
          onDragOver={preventDrop}
          onDrop={dropImage}
        >
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={chooseImage}
          />
          <header className="vf-header">
            <div>
              <h2 id="visual-feedback-title">{request.title || label("title")}</h2>
              <span className="vf-muted">{label("title")}</span>
            </div>
            <button
              type="button"
              className="vf-close"
              aria-label={label("close")}
              disabled={pending}
              onClick={cancel}
            >
              ×
            </button>
          </header>
          {request.instructions && (
            <div className="vf-instructions">
              <strong>{label("instructions")}</strong>
              <p>{request.instructions}</p>
            </div>
          )}
          <div className="vf-content">
            {renderImagePanel()}
            {renderSidebar()}
          </div>
          <footer className="vf-footer">
            <div className="vf-status" aria-live="polite">
              {status}
            </div>
            <button type="button" disabled={pending} onClick={cancel}>
              {label("cancel")}
            </button>
            <button
              type="button"
              className="vf-submit"
              disabled={busy || (!!image && !imageReady)}
              onClick={submit}
            >
              {label(pending ? "submitting" : "submit")}
            </button>
          </footer>
        </section>
      </div>
    </OverlayLayerProvider>,
    getOverlayRoot(),
  );
}

const AnnotationMark = memo(function AnnotationMark({
  annotation,
  number,
  scale,
  selected,
  image,
}: {
  annotation: VisualFeedbackAnnotation;
  number: number;
  scale: number;
  selected: boolean;
  image: VisualFeedbackImage;
}) {
  const unit = 1 / Math.max(0.001, scale);
  const anchor = annotationAnchor(annotation);
  const radius = Math.min(11 * unit, image.width / 2, image.height / 2);
  const x = Math.max(radius, Math.min(image.width - radius, anchor.x));
  const y = Math.max(radius, Math.min(image.height - radius, anchor.y));
  const color = selected ? "#47a8ff" : "#e5484d";
  const stroke = {
    stroke: color,
    strokeWidth: 2.5 * unit,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  let shape;
  if (annotation.kind === "rectangle")
    shape = (
      <rect
        x={annotation.x}
        y={annotation.y}
        width={annotation.width}
        height={annotation.height}
        fill="transparent"
        {...stroke}
      />
    );
  if (annotation.kind === "arrow") {
    const end = { x: annotation.x2, y: annotation.y2 };
    const [a, b] = arrowHead(annotation, end, 13 * unit);
    const d = `M${annotation.x},${annotation.y} L${end.x},${end.y} M${a.x},${a.y} L${end.x},${end.y} L${b.x},${b.y}`;
    shape = (
      <>
        <path d={d} fill="none" stroke="transparent" strokeWidth={14 * unit} />
        <path d={d} fill="none" {...stroke} />
      </>
    );
  }
  if (annotation.kind === "pen") {
    const points = annotation.points.map((point) => `${point.x},${point.y}`).join(" ");
    shape = (
      <>
        <polyline points={points} fill="none" stroke="transparent" strokeWidth={14 * unit} />
        <polyline points={points} fill="none" {...stroke} />
      </>
    );
  }
  return (
    <g data-annotation={annotation.id}>
      {shape}
      <circle cx={x} cy={y} r={radius} fill={color} stroke="white" strokeWidth={1.5 * unit} />
      <text
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontFamily="sans-serif"
        fontWeight="700"
        fontSize={12 * unit}
        style={NUMBER_STYLE}
      >
        {number}
      </text>
      {selected && annotation.kind === "rectangle" && (
        <rect
          data-annotation={annotation.id}
          data-resize="true"
          x={annotation.x + annotation.width - 5 * unit}
          y={annotation.y + annotation.height - 5 * unit}
          width={10 * unit}
          height={10 * unit}
          fill="white"
          stroke={color}
          strokeWidth={2 * unit}
          style={RESIZE_STYLE}
        />
      )}
    </g>
  );
});

const EDITOR_CSS = `
.vf-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.55);pointer-events:auto;color:var(--vf-fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.vf-dialog{width:min(1360px,100%);height:min(900px,94dvh);display:flex;flex-direction:column;min-height:0;overflow:hidden;background:var(--vf-bg);border:1px solid var(--vf-border);border-radius:16px;box-shadow:0 24px 80px #0005;outline:none}
.vf-dialog *{box-sizing:border-box}.vf-dialog button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--vf-border);border-radius:7px;background:var(--vf-panel);padding:6px 10px;white-space:nowrap}.vf-dialog button:hover:not(:disabled){filter:brightness(1.15)}.vf-dialog button:disabled{opacity:.4;cursor:default}.vf-dialog button:focus-visible,.vf-dialog textarea:focus-visible{outline:2px solid #47a8ff;outline-offset:2px}.vf-dialog button[aria-pressed=true]{color:var(--vf-primary-fg);background:var(--vf-primary);border-color:var(--vf-primary)}
.vf-header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--vf-border);flex-shrink:0;gap:16px}.vf-header h2{font-size:16px;font-weight:600;margin:0;overflow-wrap:anywhere}.vf-header .vf-close{font-size:24px;line-height:1;background:transparent;border:0;padding:6px 10px}.vf-muted{color:var(--vf-muted);font-size:12px}.vf-instructions{padding:10px 22px;border-bottom:1px solid var(--vf-border);max-height:110px;overflow:auto;flex-shrink:0}.vf-instructions strong{font-size:11px;color:var(--vf-muted);text-transform:uppercase;letter-spacing:.06em}.vf-instructions p{margin:3px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.vf-content{display:flex;flex:1;min-height:0;overflow:hidden}.vf-main{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--vf-panel)}.vf-toolbar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--vf-border)}.vf-tool-group,.vf-image-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.vf-tool-group button{padding:5px 8px}.vf-tool-label{margin-left:5px;font-size:11px}.vf-canvas-scroll{flex:1;min-height:180px;overflow:auto;overscroll-behavior:contain;background-color:var(--vf-bg);background-image:linear-gradient(45deg,#8080800a 25%,transparent 25%,transparent 75%,#8080800a 75%),linear-gradient(45deg,#8080800a 25%,transparent 25%,transparent 75%,#8080800a 75%);background-size:20px 20px;background-position:0 0,10px 10px}.vf-canvas-pad{padding:24px;min-width:100%;min-height:100%;width:max-content;display:flex;align-items:center;justify-content:center}.vf-image{position:relative;flex-shrink:0;box-shadow:0 3px 18px #0003;background:white}.vf-image img,.vf-image svg{display:block;position:absolute;inset:0;width:100%;height:100%}.vf-image img{pointer-events:none;user-select:none}.vf-empty{height:100%;min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;text-align:center}.vf-empty-icon{font-size:42px;color:var(--vf-muted)}.vf-empty h3{margin:8px 0;font-size:17px;font-weight:600}.vf-empty p{max-width:380px;color:var(--vf-muted);margin:0 0 20px}.vf-image-footer{padding:10px 14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;border-top:1px solid var(--vf-border)}.vf-image-footer button{font-size:11px}.vf-zoom{font-variant-numeric:tabular-nums;font-size:11px;min-width:40px;text-align:center}.vf-hint{font-size:11px;color:var(--vf-muted);margin:0;padding:0 14px 10px}
.vf-sidebar{width:330px;max-width:40%;flex-shrink:0;overflow:auto;overscroll-behavior:contain;border-left:1px solid var(--vf-border);padding:18px;display:flex;flex-direction:column;gap:16px}
.vf-field{display:flex;flex-direction:column;gap:7px;font-weight:600;font-size:12px}
.vf-dialog textarea{width:100%;resize:vertical;min-height:56px;border:1px solid var(--vf-border);border-radius:8px;background:var(--vf-bg);color:var(--vf-fg);padding:10px;font-size:13px;line-height:1.5;font-family:inherit;font-weight:400}
.vf-dialog textarea::placeholder{color:var(--vf-muted)}
.vf-notes-header{display:flex;align-items:center;justify-content:space-between;gap:10px}
.vf-notes-header h3{margin:0;font-size:12px;font-weight:600}
.vf-note-help{margin:0;line-height:1.7}
.vf-note{border:1px solid var(--vf-border);border-radius:10px;padding:10px;background:var(--vf-panel);flex-shrink:0}
.vf-note-selected{border-color:#47a8ff;box-shadow:0 0 0 1px #47a8ff}
.vf-note-heading{display:flex;gap:8px;align-items:center;margin-bottom:8px;font-size:11px;color:var(--vf-muted)}
.vf-note-heading .vf-note-number{border:0;border-radius:50%;background:#e5484d;color:white;padding:0;width:22px;height:22px;font-weight:700}
.vf-note-heading .vf-delete{margin-left:auto;border:0;background:transparent;padding:0 5px;font-size:20px}
.vf-note textarea{font-size:12px;min-height:60px}
.vf-footer{border-top:1px solid var(--vf-border);padding:14px 22px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.vf-footer .vf-submit{background:var(--vf-primary);color:var(--vf-primary-fg);border-color:var(--vf-primary);font-weight:600}
.vf-status{flex:1;min-width:0;color:var(--vf-muted);font-size:12px}
.vf-status p{margin:0;white-space:pre-wrap}
.vf-error{color:#e5484d}
@media(max-width:1000px){.vf-tool-label{display:none}.vf-sidebar{width:290px}.vf-toolbar{gap:6px}}
@media(max-width:680px){.vf-overlay{padding:0}.vf-dialog{height:100dvh;width:100%;border-radius:0}.vf-header{padding:12px 16px}.vf-content{overflow:auto;display:block;overscroll-behavior:contain}.vf-main{height:52dvh;min-height:300px}.vf-sidebar{width:100%;max-width:none;border-left:0;border-top:1px solid var(--vf-border);overflow:visible}.vf-footer{padding:10px 14px;flex-wrap:wrap}.vf-status:not(:empty){flex-basis:100%}.vf-instructions{max-height:85px}.vf-dialog button{min-height:32px}.vf-toolbar{padding:8px 10px}}
`;

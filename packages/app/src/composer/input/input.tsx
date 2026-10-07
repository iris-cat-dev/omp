import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  View,
  Text,
  useWindowDimensions,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  TextInputSelectionChangeEventData,
  type LayoutChangeEvent,
} from "react-native";
import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  forwardRef,
} from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { ArrowUp, CornerDownLeft, Plus } from "lucide-react-native";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { useToast } from "@/contexts/toast-context";
import {
  collectClipboardAttachmentFiles,
  filesToImageAttachments,
} from "@/utils/image-attachments-from-files";
import type { ComposerAttachment } from "@/attachments/types";
import type { ImageAttachment, MessagePayload } from "@/composer/types";
import { focusWithRetries } from "@/utils/web-focus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useIosHardwareKeyboardSubmit } from "@/hooks/use-ios-hardware-keyboard-submit";
import { formatShortcut, type ShortcutKey } from "@/utils/format-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { MessageInputKeyboardActionKind } from "@/keyboard/actions";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { RenderProfile } from "@/utils/render-profiler";
import { useComposerHeight } from "./height";
import { resolveComposerInputMode, type ComposerInputMode } from "@/composer/input-mode";
import type { NativePastedFile } from "@/composer/native-pasted-image";
import {
  EditingTextInput,
  type EditingTextInputHandle as ComposerTextInputHandle,
  type EditingTextInputProps,
} from "@/components/ui/text-input";

const ComposerTextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.surface4,
}));
import { resolveSendTooltipLabel, resolveSubmitAccessibilityLabel } from "./labels";
import {
  runAlternateSendAction,
  runDefaultSendAction,
  runMessageInputKeyboardAction,
} from "./state";

const DEFAULT_SEND_KEYS: ShortcutKey[][] = [["Enter"]];
const COMPOSER_INPUT_DATASET = { composerInput: "" } as const;

export interface AttachmentMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  icon?: React.ReactElement | null;
}

export interface ComposerInputSnapshot {
  text: string;
  selection: { start: number; end: number };
}

export interface ComposerKeyPressEvent {
  key: string;
  preventDefault: () => void;
  input: ComposerInputSnapshot;
}

export interface MessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (payload: MessagePayload) => void;
  /** When true, the submit button is enabled even without text or images (e.g. external attachment selected). */
  hasExternalContent?: boolean;
  /** When true, the submit button stays visible and can submit even with no content. */
  allowEmptySubmit?: boolean;
  /** Optional accessibility label for the primary submit button. */
  submitButtonAccessibilityLabel?: string;
  /** Optional testID for the primary submit button. */
  submitButtonTestID?: string;
  submitIcon?: "arrow" | "return";
  isSubmitDisabled?: boolean;
  isSubmitLoading?: boolean;
  /** When true, keep the grown input height after submit (text is preserved, not cleared). */
  preserveHeightOnSubmit?: boolean;
  attachments: ComposerAttachment[];
  cwd: string;
  attachmentMenuItems: AttachmentMenuItem[];
  onAttachButtonRef?: (node: View | null) => void;
  onAddImages?: (images: ImageAttachment[]) => void;
  onPasteFiles?: (files: readonly File[]) => void;
  isAttachmentPasteDisabled?: boolean;
  onPasteImages?: (files: readonly NativePastedFile[]) => void;
  client: DaemonClient | null;
  placeholder?: string;
  autoFocus?: boolean;
  autoFocusKey?: string;
  disabled?: boolean;
  /** Content to render on the left side of the composer toolbar (e.g., AgentControls) */
  leftContent?: React.ReactNode;
  /** Content to render at the start of the right-side controls. */
  rightLeadingContent?: React.ReactNode;
  /** Auxiliary content to render before the primary action. */
  rightContent?: React.ReactNode;
  /** Primary action to render when the agent is active and the composer has no sendable content. */
  activeActionContent?: React.ReactNode;
  /** When true and there's sendable content, calls onQueue instead of onSubmit */
  isAgentRunning?: boolean;
  /** Controls what the default send action does when the agent is running. */
  defaultSendBehavior: "interrupt" | "steer" | "queue";
  /** Callback for queue button when agent is running */
  onQueue?: (payload: MessagePayload) => void;
  /** Optional handler used when submit button is in loading state. */
  onSubmitLoadingPress?: () => void;
  /** Intercept key press events before default handling. Return true to prevent default. */
  onKeyPress?: (event: ComposerKeyPressEvent) => boolean;
  /** Reports cursor selection updates from the underlying input. */
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  onFocusChange?: (focused: boolean) => void;
  onHeightChange?: (height: number) => void;
  /** Extra styles merged onto the input wrapper (e.g. elevated background). */
  inputWrapperStyle?: import("react-native").ViewStyle;
  /** Content rendered inside the bordered input surface, above the text input (e.g. attachment pills). */
  attachmentSlot?: React.ReactNode;
  /** What this composer is for. See `@/composer/input-mode` for what each mode implies. */
  inputMode?: ComposerInputMode;
  /** Renders `value` as static text on the same surface, for content there is nothing to type into. */
  readOnly?: boolean;
  /** Changes only when application state must replace native-owned text. */
  textReplacementKey: string;
  /** Replaces the submit icon with this label, still inside the composer's own toolbar row. */
  submitLabel?: string;
}

export interface MessageInputRef {
  focus: () => void;
  blur: () => void;
  getText: () => string;
  getInputSnapshot: () => ComposerInputSnapshot;
  replaceText: (text: string, selection?: { start: number; end: number }) => void;
  runKeyboardAction: (action: MessageInputKeyboardActionKind) => boolean;
  /**
   * Web-only: return the underlying DOM element for focus assertions/retries.
   * May return null if not mounted or on native.
   */
  getNativeElement?: () => HTMLElement | null;
}

const MIN_INPUT_HEIGHT_MOBILE = 30;
const MIN_INPUT_HEIGHT_DESKTOP = 46;
const DEFAULT_MAX_INPUT_HEIGHT = 160;
const MAX_INPUT_VIEWPORT_RATIO = 0.5;
const MIN_INPUT_HEIGHT = isWeb ? MIN_INPUT_HEIGHT_DESKTOP : MIN_INPUT_HEIGHT_MOBILE;
type WebTextInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    // Web-only: present on DOM KeyboardEvent during IME composition (CJK input).
    isComposing?: boolean;
    keyCode?: number;
  }
>;

interface TextAreaHandle {
  scrollHeight?: number;
  clientHeight?: number;
  offsetHeight?: number;
  scrollTop?: number;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  style?: {
    height?: string;
    overflowY?: string;
  } & Record<string, unknown>;
}

function AttachButtonIcon({
  hovered,
  onAttachButtonRef,
  buttonIconSize,
}: {
  hovered: boolean;
  onAttachButtonRef: ((node: View | null) => void) | undefined;
  buttonIconSize: number;
}) {
  const colorMapping = hovered ? iconForegroundMapping : iconForegroundMutedMapping;
  return (
    <View ref={onAttachButtonRef} collapsable={false} style={styles.attachButtonAnchor}>
      <ThemedPlus size={buttonIconSize} uniProps={colorMapping} />
    </View>
  );
}

function AttachmentMenuList({ items }: { items: AttachmentMenuItem[] }) {
  return (
    <>
      {items.map((item) => (
        <DropdownMenuItem
          key={item.id}
          testID={`message-input-attachment-menu-item-${item.id}`}
          disabled={item.disabled}
          onSelect={item.onSelect}
          leading={item.icon ?? null}
        >
          {item.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function AttachmentDropdown({
  visible,
  isConnected,
  disabled,
  attachButtonStyle,
  renderAttachButtonIcon,
  attachmentMenuItems,
  addAttachmentLabel,
}: {
  visible: boolean;
  isConnected: boolean;
  disabled: boolean;
  attachButtonStyle: React.ComponentProps<typeof DropdownMenuTrigger>["style"];
  renderAttachButtonIcon: (input: { hovered?: boolean }) => React.ReactElement;
  attachmentMenuItems: AttachmentMenuItem[];
  addAttachmentLabel: string;
}) {
  const isButtonDisabled = !isConnected || disabled;
  if (!visible) return null;
  return (
    <DropdownMenu compactMode="sheet">
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            disabled={isButtonDisabled}
            accessibilityLabel={addAttachmentLabel}
            accessibilityRole="button"
            testID="message-input-attach-button"
            style={attachButtonStyle}
          >
            {renderAttachButtonIcon}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{addAttachmentLabel}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        offset={8}
        minWidth={220}
        testID="message-input-attachment-menu"
        sheetTitle={addAttachmentLabel}
      >
        <AttachmentMenuList items={attachmentMenuItems} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}


type ShortcutChord = NonNullable<React.ComponentProps<typeof Shortcut>["chord"]>;

function SendTooltipBody({
  label,
  sendKeys,
}: {
  label: string;
  sendKeys: ShortcutChord | null | undefined;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {sendKeys ? <Shortcut chord={sendKeys} /> : null}
    </View>
  );
}

function SendButtonContent({
  isSubmitLoading,
  submitIcon,
  submitLabel,
  buttonIconSize,
}: {
  isSubmitLoading: boolean;
  submitIcon: "arrow" | "return";
  submitLabel: string | undefined;
  buttonIconSize: number;
}) {
  if (isSubmitLoading) {
    return <ThemedLoadingSpinner size="small" uniProps={iconForegroundMapping} />;
  }
  if (submitLabel) {
    return <Text style={styles.sendButtonLabel}>{submitLabel}</Text>;
  }
  if (submitIcon === "return") {
    return <ThemedCornerDownLeft size={buttonIconSize} uniProps={iconForegroundMapping} />;
  }
  return <ThemedArrowUp size={buttonIconSize} uniProps={iconForegroundMapping} />;
}

interface DesktopKeyPressContext {
  onKeyPressCallback: ((event: ComposerKeyPressEvent) => boolean) | undefined;
  input: ComposerKeyPressEvent["input"];
  submitOnEnter: boolean;
  isAgentRunning: boolean;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  disabled: boolean;
  handleAlternateSendAction: () => void;
  handleDefaultSendAction: () => void;
}

function handleDesktopKeyPressImpl(
  event: WebTextInputKeyPressEvent,
  ctx: DesktopKeyPressContext,
): void {
  if (isImeComposingKeyboardEvent(event.nativeEvent)) return;

  if (ctx.onKeyPressCallback) {
    const handled = ctx.onKeyPressCallback({
      key: event.nativeEvent.key,
      preventDefault: () => event.preventDefault(),
      input: ctx.input,
    });
    if (handled) return;
  }

  const { shiftKey, metaKey, ctrlKey } = event.nativeEvent;

  if (event.nativeEvent.key !== "Enter") return;
  if (!ctx.submitOnEnter) return;
  if (shiftKey) return;

  if ((metaKey || ctrlKey) && ctx.isAgentRunning && ctx.onQueue) {
    if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) return;
    event.preventDefault();
    ctx.handleAlternateSendAction();
    return;
  }

  if (ctx.isSubmitDisabled || ctx.isSubmitLoading || ctx.disabled) return;
  event.preventDefault();
  ctx.handleDefaultSendAction();
}

function getTextInputNativeElement(current: ComposerTextInputHandle | null): HTMLElement | null {
  if (!current) return null;
  const native = typeof current.getNativeRef === "function" ? current.getNativeRef() : current;
  return native instanceof HTMLElement ? native : null;
}

interface PasteAttachmentsEffectArgs {
  getWebTextArea: () => TextAreaHandle | null;
  isConnected: boolean;
  disabled: boolean;
  onAddImages: ((images: ImageAttachment[]) => void) | undefined;
  onPasteFiles: ((files: readonly File[]) => void) | undefined;
}

function usePasteAttachmentsEffect(args: PasteAttachmentsEffectArgs): void {
  const argsRef = useRef(args);
  argsRef.current = args;
  const { getWebTextArea } = args;

  useEffect(() => {
    if (!isWeb) return;

    const textarea = getWebTextArea() as
      | (TextAreaHandle & {
          addEventListener?: (type: string, listener: (e: ClipboardEvent) => void) => void;
          removeEventListener?: (type: string, listener: (e: ClipboardEvent) => void) => void;
        })
      | null;
    if (
      !textarea ||
      typeof textarea.addEventListener !== "function" ||
      typeof textarea.removeEventListener !== "function"
    ) {
      return;
    }

    const handlePaste = (event: ClipboardEvent) => {
      const { isConnected, disabled, onAddImages, onPasteFiles } = argsRef.current;
      if (!onAddImages && !onPasteFiles) return;

      const { imageFiles, genericFiles } = collectClipboardAttachmentFiles(event.clipboardData);
      if (imageFiles.length === 0 && genericFiles.length === 0) return;

      // A file paste must never fall through to inserting a local path as text, even while busy.
      event.preventDefault();
      if (!isConnected || disabled) return;

      if (genericFiles.length > 0) {
        onPasteFiles?.(genericFiles);
      }
      if (imageFiles.length === 0 || !onAddImages) return;

      // Generic upload state can remount this input; the image half of the same paste must survive.
      void filesToImageAttachments(imageFiles)
        .then((pastedAttachments) => {
          if (pastedAttachments.length === 0) return;
          onAddImages(pastedAttachments);
          return;
        })
        .catch((error) => {
          console.error("[MessageInput] Failed to process pasted images:", error);
        });
    };

    textarea.addEventListener("paste", handlePaste);
    return () => {
      textarea.removeEventListener?.("paste", handlePaste);
    };
  }, [getWebTextArea]);
}

function useAutoFocusOnWebEffect(
  textInputRef: React.MutableRefObject<ComposerTextInputHandle | null>,
  autoFocus: boolean,
  autoFocusKey: string | undefined,
): void {
  useEffect(() => {
    if (!isWeb || !autoFocus) return;
    return focusWithRetries({
      focus: () => textInputRef.current?.focus(),
      isFocused: () => {
        const element = getTextInputNativeElement(textInputRef.current);
        const active = typeof document !== "undefined" ? document.activeElement : null;
        return Boolean(element) && active === element;
      },
      deferInitialAttempt: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, autoFocusKey]);
}

function MessageInputAutoFocus({
  enabled,
  autoFocusKey,
  textInputRef,
}: {
  enabled: boolean;
  autoFocusKey: string | undefined;
  textInputRef: React.MutableRefObject<ComposerTextInputHandle | null>;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  useAutoFocusOnWebEffect(textInputRef, enabled && isActiveComposer, autoFocusKey);
  return null;
}


function FocusHint({
  visible,
  focusInputKeys,
  label,
}: {
  visible: boolean;
  focusInputKeys: ShortcutChord | null | undefined;
  label: string;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  if (!isActiveComposer || !visible || !focusInputKeys || !label.trim()) return null;
  return (
    <Text style={styles.focusHintText} pointerEvents="none">
      {label}
    </Text>
  );
}

interface ComposerTextSurfaceProps {
  readOnly: boolean;
  value: string;
  textInputRef: React.Ref<ComposerTextInputHandle>;
  textInputStyle: EditingTextInputProps["style"];
  readOnlyTextStyle: React.ComponentProps<typeof Text>["style"];
  placeholder: string;
  accessibilityLabel: string;
  onChangeText: (text: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  editable: boolean;
  scrollEnabled: boolean;
  autoFocus: boolean;
  onKeyPress: ((event: WebTextInputKeyPressEvent) => void) | undefined;
  onSelectionChange: (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  onPasteImages: ((files: readonly NativePastedFile[]) => void) | undefined;
  onPasteError: (message: string) => void;
  focusHintVisible: boolean;
  focusInputKeys: ShortcutChord | null | undefined;
  focusHintLabel: string;
}

/**
 * The composer's content: an editable input, or static text when there is
 * nothing to type. Both sit in the same bordered surface, so read-only is a
 * state of this composer rather than a second one.
 */
function ComposerTextSurface(props: ComposerTextSurfaceProps): React.ReactElement {
  if (props.readOnly) {
    return (
      <View style={styles.textInputScrollWrapper}>
        <Text style={props.readOnlyTextStyle} testID="composer-readonly-content">
          {props.value}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.textInputScrollWrapper}>
      <ComposerTextInput
        ref={props.textInputRef}
        dataSet={COMPOSER_INPUT_DATASET}
        initialValue={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        accessibilityLabel={props.accessibilityLabel}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
        style={props.textInputStyle}
        multiline
        scrollEnabled={props.scrollEnabled}
        editable={props.editable}
        onKeyPress={props.onKeyPress}
        onSelectionChange={props.onSelectionChange}
        onPasteImages={props.onPasteImages}
        onPasteError={props.onPasteError}
        autoFocus={props.autoFocus}
      />
      <FocusHint
        visible={props.focusHintVisible}
        focusInputKeys={props.focusInputKeys}
        label={props.focusHintLabel}
      />
    </View>
  );
}


function SendButtonTooltip({
  shouldShow,
  canPressLoadingButton,
  onSubmitLoadingPress,
  onDefaultSendAction,
  isSendButtonDisabled,
  submitAccessibilityLabel,
  sendButtonCombinedStyle,
  isSubmitLoading,
  submitIcon,
  submitLabel,
  submitButtonTestID,
  buttonIconSize,
  sendKeys,
  sendTooltipLabel,
}: {
  shouldShow: boolean;
  canPressLoadingButton: boolean;
  onSubmitLoadingPress: (() => void) | undefined;
  onDefaultSendAction: () => void;
  isSendButtonDisabled: boolean;
  submitAccessibilityLabel: string;
  sendButtonCombinedStyle: React.ComponentProps<typeof TooltipTrigger>["style"];
  isSubmitLoading: boolean;
  submitIcon: "arrow" | "return";
  submitLabel: string | undefined;
  submitButtonTestID: string | undefined;
  buttonIconSize: number;
  sendKeys: ShortcutChord | null | undefined;
  sendTooltipLabel: string;
}) {
  if (!shouldShow) return null;
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={canPressLoadingButton ? onSubmitLoadingPress : onDefaultSendAction}
        disabled={isSendButtonDisabled}
        accessibilityLabel={submitAccessibilityLabel}
        accessibilityRole="button"
        testID={submitButtonTestID}
        style={sendButtonCombinedStyle}
      >
        <SendButtonContent
          isSubmitLoading={isSubmitLoading}
          submitIcon={submitIcon}
          submitLabel={submitLabel}
          buttonIconSize={buttonIconSize}
        />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <SendTooltipBody label={sendTooltipLabel} sendKeys={sendKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

type PrimaryActionKind = "send" | "active";

function hasSendableComposerContent(input: {
  hasText: boolean;
  attachments: readonly ComposerAttachment[];
  hasExternalContent: boolean;
}): boolean {
  return input.hasText || input.attachments.length > 0 || input.hasExternalContent;
}

function resolvePrimaryActionKind(input: {
  hasSendableContent: boolean;
  allowEmptySubmit: boolean;
  isAgentRunning: boolean;
  isSubmitLoading: boolean;
}): PrimaryActionKind {
  if (!input.hasSendableContent && input.isAgentRunning && !input.isSubmitLoading) return "active";
  return "send";
}

function PrimaryAction({
  kind,
  activeActionContent,
  ...sendButtonProps
}: {
  kind: PrimaryActionKind;
  activeActionContent: React.ReactNode;
} & React.ComponentProps<typeof SendButtonTooltip>) {
  if (kind === "active") return activeActionContent;
  if (kind === "send") return <SendButtonTooltip {...sendButtonProps} />;
  return null;
}
interface SendMessageContext {
  value: string;
  attachments: ComposerAttachment[];
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  cwd: string;
  isAgentRunning: boolean;
  onSubmit: (payload: MessagePayload) => void;
  onMinimizeHeight: () => void;
  preserveHeightOnSubmit: boolean;
}

function sendMessageImpl(ctx: SendMessageContext): void {
  const trimmed = ctx.value.trim();
  if (
    !trimmed &&
    ctx.attachments.length === 0 &&
    !ctx.hasExternalContent &&
    !ctx.allowEmptySubmit
  ) {
    return;
  }
  ctx.onSubmit({
    text: trimmed,
    attachments: ctx.attachments,
    cwd: ctx.cwd,
    forceSend: ctx.isAgentRunning || undefined,
  });
  // When the host preserves and locks the composer (e.g. new-workspace creation),
  // the text stays put — collapsing the height would clip it. Keep it grown.
  if (!ctx.preserveHeightOnSubmit) {
    ctx.onMinimizeHeight();
  }
}

interface QueueMessageContext {
  value: string;
  attachments: ComposerAttachment[];
  cwd: string;
  onQueue: ((payload: MessagePayload) => void) | undefined;
  replaceText: (text: string) => void;
  onMinimizeHeight: () => void;
}

function queueMessageImpl(ctx: QueueMessageContext): void {
  if (!ctx.onQueue) return;
  const trimmed = ctx.value.trim();
  if (!trimmed && ctx.attachments.length === 0) return;
  ctx.onQueue({ text: trimmed, attachments: ctx.attachments, cwd: ctx.cwd });
  ctx.replaceText("");
  ctx.onMinimizeHeight();
}


function resolveMaxInputHeight(windowHeight: number): number {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return DEFAULT_MAX_INPUT_HEIGHT;
  return Math.max(DEFAULT_MAX_INPUT_HEIGHT, Math.floor(windowHeight * MAX_INPUT_VIEWPORT_RATIO));
}

function isTextAreaLike(v: unknown): v is TextAreaHandle {
  return typeof v === "object" && v !== null && "scrollHeight" in v;
}

function getWebTextAreaImpl(current: ComposerTextInputHandle | null): TextAreaHandle | null {
  if (!current) return null;
  const candidate = current as { getNativeRef?: () => unknown };
  if (typeof candidate.getNativeRef === "function") {
    const native = candidate.getNativeRef();
    if (isTextAreaLike(native)) return native;
  }
  if (isTextAreaLike(current)) return current;
  return null;
}

function getComposerInputSnapshot(
  current: ComposerTextInputHandle | null,
  fallbackText: string,
  fallbackSelection: ComposerInputSnapshot["selection"],
): ComposerInputSnapshot {
  const text = current?.getText() ?? fallbackText;
  const textArea = getWebTextAreaImpl(current);
  const start = textArea?.selectionStart ?? fallbackSelection.start;
  const end = textArea?.selectionEnd ?? fallbackSelection.end;
  return { text, selection: { start, end } };
}

interface SendButtonStateInput {
  disabled: boolean;
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  onSubmitLoadingPress: (() => void) | undefined;
  defaultSendBehavior: "interrupt" | "steer" | "queue";
  isAgentRunning: boolean;
}

interface SendButtonStateOutput {
  canPressLoadingButton: boolean;
  isSendButtonDisabled: boolean;
  defaultActionQueues: boolean;
}

function computeSendButtonState(input: SendButtonStateInput): SendButtonStateOutput {
  const canPressLoadingButton =
    input.isSubmitLoading && typeof input.onSubmitLoadingPress === "function";
  const isSendButtonDisabled =
    input.disabled || (!canPressLoadingButton && (input.isSubmitDisabled || input.isSubmitLoading));
  const defaultActionQueues = input.defaultSendBehavior === "queue" && input.isAgentRunning;
  return { canPressLoadingButton, isSendButtonDisabled, defaultActionQueues };
}

interface ResolvedMessageInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (payload: MessagePayload) => void;
  hasExternalContent: boolean;
  allowEmptySubmit: boolean;
  submitButtonAccessibilityLabel: string | undefined;
  submitButtonTestID: string | undefined;
  submitIcon: "arrow" | "return";
  isSubmitDisabled: boolean;
  isSubmitLoading: boolean;
  preserveHeightOnSubmit: boolean;
  attachments: ComposerAttachment[];
  cwd: string;
  attachmentMenuItems: AttachmentMenuItem[];
  onAttachButtonRef: ((node: View | null) => void) | undefined;
  onAddImages: ((images: ImageAttachment[]) => void) | undefined;
  onPasteFiles: ((files: readonly File[]) => void) | undefined;
  isAttachmentPasteDisabled: boolean;
  onPasteImages: ((files: readonly NativePastedFile[]) => void) | undefined;
  client: DaemonClient | null;
  placeholder: string | undefined;
  autoFocus: boolean;
  autoFocusKey: string | undefined;
  disabled: boolean;
  leftContent: React.ReactNode;
  rightLeadingContent: React.ReactNode;
  rightContent: React.ReactNode;
  activeActionContent: React.ReactNode;
  isAgentRunning: boolean;
  defaultSendBehavior: "interrupt" | "steer" | "queue";
  onQueue: ((payload: MessagePayload) => void) | undefined;
  onSubmitLoadingPress: (() => void) | undefined;
  onKeyPressCallback: ((event: ComposerKeyPressEvent) => boolean) | undefined;
  onSelectionChangeCallback: ((selection: { start: number; end: number }) => void) | undefined;
  onFocusChange: ((focused: boolean) => void) | undefined;
  onHeightChange: ((height: number) => void) | undefined;
  inputWrapperStyle: import("react-native").ViewStyle | undefined;
  attachmentSlot: React.ReactNode;
  inputMode: ComposerInputMode;
  readOnly: boolean;
  textReplacementKey: string;
  submitLabel: string | undefined;
}

function resolveMessageInputProps(props: MessageInputProps): ResolvedMessageInputProps {
  return {
    value: props.value,
    onChangeText: props.onChangeText,
    onSubmit: props.onSubmit,
    hasExternalContent: props.hasExternalContent ?? false,
    allowEmptySubmit: props.allowEmptySubmit ?? false,
    submitButtonAccessibilityLabel: props.submitButtonAccessibilityLabel,
    submitButtonTestID: props.submitButtonTestID,
    submitIcon: props.submitIcon ?? "arrow",
    isSubmitDisabled: props.isSubmitDisabled ?? false,
    isSubmitLoading: props.isSubmitLoading ?? false,
    preserveHeightOnSubmit: props.preserveHeightOnSubmit ?? false,
    attachments: props.attachments,
    cwd: props.cwd,
    attachmentMenuItems: props.attachmentMenuItems,
    onAttachButtonRef: props.onAttachButtonRef,
    onAddImages: props.onAddImages,
    onPasteFiles: props.onPasteFiles,
    isAttachmentPasteDisabled: props.isAttachmentPasteDisabled ?? false,
    onPasteImages: props.onPasteImages,
    client: props.client,
    placeholder: props.placeholder,
    autoFocus: props.autoFocus ?? false,
    autoFocusKey: props.autoFocusKey,
    disabled: props.disabled ?? false,
    leftContent: props.leftContent,
    rightLeadingContent: props.rightLeadingContent,
    rightContent: props.rightContent,
    activeActionContent: props.activeActionContent,
    isAgentRunning: props.isAgentRunning ?? false,
    defaultSendBehavior: props.defaultSendBehavior,
    onQueue: props.onQueue,
    onSubmitLoadingPress: props.onSubmitLoadingPress,
    onKeyPressCallback: props.onKeyPress,
    onSelectionChangeCallback: props.onSelectionChange,
    onFocusChange: props.onFocusChange,
    onHeightChange: props.onHeightChange,
    inputWrapperStyle: props.inputWrapperStyle,
    attachmentSlot: props.attachmentSlot,
    inputMode: props.inputMode ?? "chat",
    readOnly: props.readOnly ?? false,
    textReplacementKey: props.textReplacementKey,
    submitLabel: props.submitLabel,
  };
}

function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}

export const MessageInput = forwardRef<MessageInputRef, MessageInputProps>(
  function MessageInput(props, ref) {
    const {
      value,
      onChangeText,
      onSubmit,
      hasExternalContent,
      allowEmptySubmit,
      submitButtonAccessibilityLabel,
      submitButtonTestID,
      submitIcon,
      isSubmitDisabled,
      isSubmitLoading,
      preserveHeightOnSubmit,
      attachments,
      cwd,
      attachmentMenuItems,
      onAttachButtonRef,
      onAddImages,
      onPasteFiles,
      isAttachmentPasteDisabled,
      onPasteImages,
      client,
      placeholder,
      autoFocus,
      autoFocusKey,
      disabled,
      leftContent,
      rightLeadingContent,
      rightContent,
      activeActionContent,
      isAgentRunning,
      defaultSendBehavior,
      onQueue,
      onSubmitLoadingPress,
      onKeyPressCallback,
      onSelectionChangeCallback,
      onFocusChange,
      onHeightChange,
      inputWrapperStyle,
      attachmentSlot,
      inputMode,
      readOnly,
      textReplacementKey,
      submitLabel,
    } = resolveMessageInputProps(props);
    const mode = resolveComposerInputMode(inputMode);
    const { t } = useTranslation();
    const isCompact = useIsCompactFormFactor();
    const { height: windowHeight } = useWindowDimensions();
    const maxInputHeight = resolveMaxInputHeight(windowHeight);
    const buttonIconSize = isWeb ? ICON_SIZE.md : ICON_SIZE.lg;
    const toast = useToast();
    const isConnected = client?.isConnected ?? false;
    const focusInputKeys = useShortcutKeys("focus-message-input");
    const [isInputFocused, setIsInputFocused] = useState(false);
    // Web text is DOM-owned between deferred draft publications. The action button only needs
    // this boundary, so publish empty/non-empty transitions without rerendering for every key.
    const initialHasLiveText = value.trim().length > 0;
    const [hasLiveText, setHasLiveText] = useState(initialHasLiveText);
    const hasLiveTextRef = useRef(initialHasLiveText);
    const rootRef = useRef<View | null>(null);
    const inputWrapperRef = useRef<View | null>(null);
    const textInputRef = useRef<ComposerTextInputHandle | null>(null);
    const isInputFocusedRef = useRef(false);
    const valueRef = useRef(value);
    const selectionRef = useRef({ start: value.length, end: value.length });
    const appliedTextReplacementKeyRef = useRef(textReplacementKey);
    const webTextareaRef = useRef<HTMLElement | null>(null);
    const composerHeight = useComposerHeight({
      value,
      textareaRef: webTextareaRef,
      minHeight: MIN_INPUT_HEIGHT,
      maxHeight: maxInputHeight,
    });
    const { style: composerHeightStyle, scrollEnabled: isComposerScrollEnabled } = composerHeight;
    const measuredComposerHeight = composerHeight.mode === "measured" ? composerHeight : undefined;
    const updateComposerHeightForText = measuredComposerHeight?.onTextChange;
    const resetComposerHeight = measuredComposerHeight?.reset;

    const handleComposerLayout = useCallback(
      (event: LayoutChangeEvent) => onHeightChange?.(event.nativeEvent.layout.height),
      [onHeightChange],
    );

    const updateLiveTextPresence = useCallback((text: string) => {
      const nextHasLiveText = text.trim().length > 0;
      if (hasLiveTextRef.current === nextHasLiveText) return;
      hasLiveTextRef.current = nextHasLiveText;
      setHasLiveText(nextHasLiveText);
    }, []);

    const replaceText = useCallback(
      (nextText: string, selection?: { start: number; end: number }) => {
        updateComposerHeightForText?.(valueRef.current, nextText);
        valueRef.current = nextText;
        updateLiveTextPresence(nextText);
        selectionRef.current = selection ?? { start: nextText.length, end: nextText.length };
        textInputRef.current?.replaceText(nextText, selection);
        onChangeText(nextText);
      },
      [onChangeText, updateComposerHeightForText, updateLiveTextPresence],
    );

    useImperativeHandle(ref, () => ({
      focus: () => {
        textInputRef.current?.focus();
      },
      blur: () => {
        textInputRef.current?.blur();
      },
      getText: () => textInputRef.current?.getText() ?? valueRef.current,
      getInputSnapshot: () =>
        getComposerInputSnapshot(textInputRef.current, valueRef.current, selectionRef.current),
      replaceText,
      runKeyboardAction: (action) =>
        runMessageInputKeyboardAction(action, {
          focusInput: () => textInputRef.current?.focus(),
        }),
      getNativeElement: () => (isWeb ? getTextInputNativeElement(textInputRef.current) : null),
    }));

    useEffect(() => {
      if (appliedTextReplacementKeyRef.current === textReplacementKey) return;
      appliedTextReplacementKeyRef.current = textReplacementKey;
      updateComposerHeightForText?.(valueRef.current, value);
      valueRef.current = value;
      updateLiveTextPresence(value);
      textInputRef.current?.replaceText(value);
    }, [textReplacementKey, updateComposerHeightForText, updateLiveTextPresence, value]);

    useEffect(() => {
      return () => {
        onFocusChange?.(false);
      };
    }, [onFocusChange]);


    const minimizeInputHeight = useCallback(() => {
      resetComposerHeight?.();
    }, [resetComposerHeight]);

    const handleSendMessage = useCallback(() => {
      const liveValue = textInputRef.current?.getText() ?? valueRef.current;
      if (!preserveHeightOnSubmit) {
        updateLiveTextPresence("");
      }
      sendMessageImpl({
        value: liveValue,
        attachments,
        hasExternalContent,
        allowEmptySubmit,
        cwd,
        isAgentRunning,
        onSubmit,
        onMinimizeHeight: minimizeInputHeight,
        preserveHeightOnSubmit,
      });
    }, [
      allowEmptySubmit,
      attachments,
      cwd,
      onSubmit,
      isAgentRunning,
      hasExternalContent,
      minimizeInputHeight,
      preserveHeightOnSubmit,
      updateLiveTextPresence,
    ]);

    const handleQueueMessage = useCallback(
      () =>
        queueMessageImpl({
          value: textInputRef.current?.getText() ?? valueRef.current,
          attachments,
          cwd,
          onQueue,
          replaceText,
          onMinimizeHeight: minimizeInputHeight,
        }),
      [attachments, cwd, onQueue, replaceText, minimizeInputHeight],
    );

    const handleDefaultSendAction = useCallback(() => {
      runDefaultSendAction({
        defaultSendBehavior,
        isAgentRunning,
        onQueue,
        handleSendMessage,
        handleQueueMessage,
      });
    }, [defaultSendBehavior, isAgentRunning, onQueue, handleQueueMessage, handleSendMessage]);

    const handleAlternateSendAction = useCallback(() => {
      runAlternateSendAction({
        defaultSendBehavior,
        isAgentRunning,
        onQueue,
        handleSendMessage,
        handleQueueMessage,
      });
    }, [defaultSendBehavior, isAgentRunning, handleSendMessage, handleQueueMessage, onQueue]);

    const getWebTextArea = useCallback(
      (): TextAreaHandle | null => getWebTextAreaImpl(textInputRef.current),
      [],
    );

    useLayoutEffect(() => {
      if (isWeb) {
        webTextareaRef.current = getWebTextArea() as HTMLElement | null;
      }
    }, [getWebTextArea]);

    usePasteAttachmentsEffect({
      getWebTextArea,
      isConnected,
      disabled: disabled || isAttachmentPasteDisabled,
      onAddImages,
      onPasteFiles,
    });

    const handleSelectionChange = useCallback(
      (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const start = event.nativeEvent.selection?.start ?? 0;
        const end = event.nativeEvent.selection?.end ?? start;
        selectionRef.current = { start, end };
        onSelectionChangeCallback?.({ start, end });
      },
      [onSelectionChangeCallback],
    );

    const shouldHandleWebKeyPress = isWeb;
    const shouldSubmitOnEnter = isWeb && !isCompact;

    function handleDesktopKeyPress(event: WebTextInputKeyPressEvent) {
      if (!shouldHandleWebKeyPress) return;
      handleDesktopKeyPressImpl(event, {
        onKeyPressCallback,
        input: getComposerInputSnapshot(
          textInputRef.current,
          valueRef.current,
          selectionRef.current,
        ),
        submitOnEnter: shouldSubmitOnEnter,
        isAgentRunning,
        onQueue,
        isSubmitDisabled,
        isSubmitLoading,
        disabled,
        handleAlternateSendAction,
        handleDefaultSendAction,
      });
    }

    const hasSendableContent = hasSendableComposerContent({
      hasText: hasLiveText,
      attachments,
      hasExternalContent,
    });
    const primaryActionKind = resolvePrimaryActionKind({
      hasSendableContent,
      allowEmptySubmit,
      isAgentRunning,
      isSubmitLoading,
    });
    const { canPressLoadingButton, isSendButtonDisabled, defaultActionQueues } =
      computeSendButtonState({
        disabled,
        isSubmitDisabled,
        isSubmitLoading,
        onSubmitLoadingPress,
        defaultSendBehavior,
        isAgentRunning,
      });
    const isPrimarySendButtonDisabled =
      isSendButtonDisabled || (!canPressLoadingButton && !hasSendableContent && !allowEmptySubmit);
    useIosHardwareKeyboardSubmit({
      isEnabled: isInputFocused && !isPrimarySendButtonDisabled,
      onSubmit: handleDefaultSendAction,
    });
    const submitAccessibilityLabel = resolveSubmitAccessibilityLabel({
      submitButtonAccessibilityLabel,
      canPressLoadingButton,
      defaultActionQueues,
      defaultSendBehavior,
      isAgentRunning,
      t,
    });


    const sendTooltipLabel = resolveSendTooltipLabel({
      submitButtonAccessibilityLabel,
      defaultActionQueues,
      t,
    });

    const handleInputChange = useCallback(
      (nextValue: string) => {
        updateComposerHeightForText?.(valueRef.current, nextValue);
        valueRef.current = nextValue;
        updateLiveTextPresence(nextValue);
        onChangeText(nextValue);
      },
      [onChangeText, updateComposerHeightForText, updateLiveTextPresence],
    );

    const handleInputFocus = useCallback(() => {
      isInputFocusedRef.current = true;
      setIsInputFocused(true);
      onFocusChange?.(true);
    }, [onFocusChange]);

    const handleInputBlur = useCallback(() => {
      isInputFocusedRef.current = false;
      setIsInputFocused(false);
      onFocusChange?.(false);
    }, [onFocusChange]);

    const handlePasteError = useCallback(
      (message: string) => {
        console.error("[MessageInput] Native paste failed:", message);
        toast.error(t("composer.errors.pasteImageFailed"));
      },
      [t, toast],
    );

    const attachButtonStyle = useCallback(
      ({ hovered }: { hovered?: boolean }) => [
        styles.attachButton,
        Boolean(hovered) && styles.iconButtonHovered,
        (!isConnected || disabled) && styles.buttonDisabled,
      ],
      [isConnected, disabled],
    );


    const inputWrapperCombinedStyle = useMemo(
      () => [styles.inputWrapper, readOnly && styles.inputWrapperReadOnly, inputWrapperStyle],
      [inputWrapperStyle, readOnly],
    );
    // `withUnistyles` maps this component's `style` into a `.hash > *` child
    // rule, which ties on specificity with react-native-web's own
    // `.css-textinput-*` class and loses on source order — so a themed
    // `fontFamily` here is silently dropped while every other property lands.
    // An inline style outranks both classes. See docs/unistyles.md.
    const textInputStyle = useMemo(
      () => [styles.textInput, mode.isMonospace && styles.textInputMonospace, composerHeightStyle],
      [composerHeightStyle, mode.isMonospace],
    );
    // Static content has no textarea to mirror, so it grows with its own text
    // instead of the measured input height.
    const readOnlyTextStyle = useMemo(
      () => [styles.textInput, mode.isMonospace && styles.textInputMonospace, styles.readOnlyText],
      [mode.isMonospace],
    );
    const sendButtonCombinedStyle = useMemo(
      () => [
        styles.sendButton,
        submitLabel ? styles.sendButtonLabeled : undefined,
        isSendButtonDisabled && styles.buttonDisabled,
      ],
      [isSendButtonDisabled, submitLabel],
    );

    const renderAttachButtonIcon = useCallback(
      ({ hovered }: { hovered?: boolean }) => (
        <AttachButtonIcon
          hovered={Boolean(hovered)}
          onAttachButtonRef={onAttachButtonRef}
          buttonIconSize={buttonIconSize}
        />
      ),
      [onAttachButtonRef, buttonIconSize],
    );


    return (
      <View
        ref={rootRef}
        style={styles.container}
        testID="message-input-root"
        onLayout={handleComposerLayout}
      >
        <MessageInputAutoFocus
          enabled={autoFocus}
          autoFocusKey={autoFocusKey}
          textInputRef={textInputRef}
        />
        {/* Regular input */}
        <View ref={inputWrapperRef} style={inputWrapperCombinedStyle}>
          {attachmentSlot}
          {/* Text input */}
          <RenderProfile id="ComposerTextSurface">
            <ComposerTextSurface
              readOnly={readOnly}
              value={value}
              textInputRef={textInputRef}
              textInputStyle={textInputStyle}
              readOnlyTextStyle={readOnlyTextStyle}
              placeholder={placeholder ?? t("composer.placeholders.fallback")}
              accessibilityLabel={t(mode.accessibilityLabelKey)}
              onChangeText={handleInputChange}
              onFocus={handleInputFocus}
              onBlur={handleInputBlur}
              editable={!disabled}
              scrollEnabled={isComposerScrollEnabled}
              autoFocus={false}
              onKeyPress={shouldHandleWebKeyPress ? handleDesktopKeyPress : undefined}
              onSelectionChange={handleSelectionChange}
              onPasteImages={onPasteImages}
              onPasteError={handlePasteError}
              focusHintVisible={isWeb && !isInputFocused && !value}
              focusInputKeys={focusInputKeys}
              focusHintLabel={t("composer.input.focusHint", {
                shortcut: focusInputKeys ? formatShortcut(focusInputKeys[0], getShortcutOs()) : "",
              })}
            />
          </RenderProfile>

          {/* Button row */}
          <View style={styles.buttonRow}>
            {/* Toolbar left: attachment button + agent controls */}
            <View style={styles.leftButtonGroup}>
              <AttachmentDropdown
                visible={mode.showAttachments}
                isConnected={isConnected}
                disabled={disabled}
                attachButtonStyle={attachButtonStyle}
                renderAttachButtonIcon={renderAttachButtonIcon}
                attachmentMenuItems={attachmentMenuItems}
                addAttachmentLabel={t("composer.input.addAttachment")}
              />
              {leftContent}
            </View>

            {/* Right: contextual controls and primary action */}
            <View style={styles.rightButtonGroup}>
              {rightLeadingContent}
              {rightContent}
              <PrimaryAction
                kind={primaryActionKind}
                activeActionContent={activeActionContent}
                shouldShow
                canPressLoadingButton={canPressLoadingButton}
                onSubmitLoadingPress={onSubmitLoadingPress}
                onDefaultSendAction={handleDefaultSendAction}
                isSendButtonDisabled={isPrimarySendButtonDisabled}
                submitAccessibilityLabel={submitAccessibilityLabel}
                sendButtonCombinedStyle={sendButtonCombinedStyle}
                isSubmitLoading={isSubmitLoading}
                submitIcon={submitIcon}
                submitLabel={submitLabel}
                submitButtonTestID={submitButtonTestID}
                buttonIconSize={buttonIconSize}
                sendKeys={DEFAULT_SEND_KEYS}
                sendTooltipLabel={sendTooltipLabel}
              />
            </View>
          </View>
        </View>
      </View>
    );
  },
);

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    position: "relative",
  },
  inputWrapper: {
    flexDirection: "column",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: {
      xs: theme.spacing[2],
      md: theme.spacing[4],
    },
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    ...(isWeb
      ? {
          transitionProperty: "border-color",
          transitionDuration: "200ms",
          transitionTimingFunction: "ease-in-out",
        }
      : {}),
  },
  // Dotted says "this surface is the same box, but there is nothing to type
  // into it" without swapping the border colour, which reads as an error state.
  inputWrapperReadOnly: {
    borderStyle: "dotted",
  },
  textInputScrollWrapper: {
    position: "relative",
  },
  focusHintText: {
    position: "absolute",
    top: 0,
    right: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    opacity: 0.5,
  },
  textInput: {
    width: "100%",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.normal,
    lineHeight: theme.fontSize.content * 1.4,
    ...(isWeb
      ? ({
          outlineStyle: "none",
          outlineWidth: 0,
          outlineColor: "transparent",
        } as object)
      : {}),
  },
  textInputMonospace: {
    fontFamily: theme.fontFamily.mono,
  },
  readOnlyText: {
    minHeight: MIN_INPUT_HEIGHT,
    color: theme.colors.foregroundMuted,
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginHorizontal: -6,
  },
  leftButtonGroup: {
    minWidth: 0,
    flexShrink: 1,
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[0],
  },
  rightButtonGroup: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  attachButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  attachButtonAnchor: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface4,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: theme.spacing[3],
  },
  sendButtonLabeled: {
    width: "auto",
    minWidth: 28,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
  },
  sendButtonLabel: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
})) as unknown as Record<string, object>;

const ThemedPlus = withUnistyles(Plus);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedCornerDownLeft = withUnistyles(CornerDownLeft);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const iconForegroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

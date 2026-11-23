import type pino from "pino";
import { isUtf8 } from "node:buffer";
import { getErrorMessage } from "@omp-desktop/protocol/error-utils";
import { MAX_WORKSPACE_FILE_BYTES } from "@omp-desktop/protocol/messages";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@omp-desktop/protocol/binary-frames/index";
import type {
  DirectorySubscribeRequest,
  DirectoryUnsubscribe,
  FileDownloadTokenRequest,
  FileEntryCreateRequest,
  FileEntryDeleteRequest,
  FileEntryDuplicateRequest,
  FileEntryMoveRequest,
  FileEntryRenameRequest,
  FileExplorerRequest,
  FileUploadRequest,
  FileSubscribeRequest,
  FileUnsubscribeRequest,
  FileWriteRequest,
  SessionInboundMessage,
  SessionOutboundMessage,
  WorkspaceFileCreateRequest,
  WorkspaceFileCreateResponse,
  WorkspaceFileExploreRequest,
  WorkspaceFileTarget,
  WorkspaceFileWriteRequest,
} from "../../messages.js";
import { FileUploadStore } from "../../file-upload/index.js";
import type { DownloadTokenStore } from "../../file-download/token-store.js";
import {
  createExplorerEntry,
  createScopedExplorerEntry,
  deleteExplorerEntry,
  duplicateExplorerEntry,
  getDownloadableFileInfo,
  isMissingExplorerEntry,
  listDirectoryEntries,
  moveExplorerEntry,
  readExplorerFile,
  resolveExplorerDirectoryPath,
  renameExplorerEntry,
  streamExplorerFile,
  validateWorkspaceFilePath,
  writeExplorerFile,
  type ExplorerFileWriteResult,
} from "../../file-explorer/service.js";
import { workspaceFileObserver, type FileObserver } from "../../file-explorer/observer.js";
import { createFileObserver as createDirectoryObserver } from "../../file-observer/index.js";
import { getProjectIcon } from "../../../utils/project-icon.js";

/**
 * What a workspace file-access request reaches outside its own domain: the
 * outbound message channel (text + binary). `hasBinaryChannel` gates the
 * binary file-explorer transfer path the same way the terminal subsystem does
 * — old clients without a binary channel fall back to inline JSON file content.
 */
export interface WorkspaceFilesSessionHost {
  emit(msg: SessionOutboundMessage, source?: object): void;
  emitBinary(frame: Uint8Array, source?: object): Promise<void>;
  hasBinaryChannel(): boolean;
}

export interface WorkspaceFilesSessionOptions {
  host: WorkspaceFilesSessionHost;
  downloadTokenStore: DownloadTokenStore;
  paseoHome: string;
  logger: pino.Logger;
  resolveWorkspaceRoot(target: WorkspaceFileTarget): Promise<string>;
  fileObserver?: FileObserver;
}

/**
 * A client's workspace file-access surface: browsing directories, reading file
 * contents (inline JSON or binary frames), receiving uploads, issuing download
 * tokens, and reading project icons. The host resolves registered scope roots;
 * this subsystem validates relative paths and handles the file I/O.
 */
export class WorkspaceFilesSession {
  private readonly host: WorkspaceFilesSessionHost;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly logger: pino.Logger;
  private readonly resolveWorkspaceRoot: WorkspaceFilesSessionOptions["resolveWorkspaceRoot"];
  private readonly fileUploads: FileUploadStore;
  private readonly fileObserver: FileObserver;
  private readonly fileSubscriptions = new Map<string, () => void>();
  private readonly directoryObserver = createDirectoryObserver();
  private readonly directorySubscriptions = new Map<
    object | undefined,
    Map<string, { unsubscribe?: () => Promise<void> }>
  >();

  constructor(options: WorkspaceFilesSessionOptions) {
    this.host = options.host;
    this.downloadTokenStore = options.downloadTokenStore;
    this.logger = options.logger;
    this.resolveWorkspaceRoot = options.resolveWorkspaceRoot;
    this.fileUploads = new FileUploadStore({ paseoHome: options.paseoHome });
    this.fileObserver = options.fileObserver ?? workspaceFileObserver;
  }

  async handleFileSubscribeRequest(request: FileSubscribeRequest): Promise<void> {
    this.fileSubscriptions.get(request.subscriptionId)?.();
    try {
      const subscription = await this.fileObserver.subscribe(
        { cwd: request.cwd, path: request.path },
        (version) => {
          this.host.emit({
            type: "fs.file.update",
            payload: { subscriptionId: request.subscriptionId, version },
          });
        },
      );
      this.fileSubscriptions.set(request.subscriptionId, subscription.unsubscribe);
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: subscription.initial,
          requestId: request.requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: {
            status: "error",
            cwd: request.cwd,
            path: request.path,
            error: getErrorMessage(error),
          },
          requestId: request.requestId,
        },
      });
    }
  }

  handleFileUnsubscribeRequest(request: FileUnsubscribeRequest): void {
    this.fileSubscriptions.get(request.subscriptionId)?.();
    this.fileSubscriptions.delete(request.subscriptionId);
    this.host.emit({
      type: "fs.file.unsubscribe.response",
      payload: { subscriptionId: request.subscriptionId, requestId: request.requestId },
    });
  }

  async handleDirectorySubscribeRequest(
    request: DirectorySubscribeRequest,
    source?: object,
  ): Promise<void> {
    if (!this.directorySubscriptions.has(source))
      this.directorySubscriptions.set(source, new Map());
    const subscriptions = this.directorySubscriptions.get(source)!;
    const { subscriptionId, requestId } = request;
    this.closeDirectoryWatch(subscriptions.get(subscriptionId)?.unsubscribe);
    const watch: { unsubscribe?: () => Promise<void> } = {};
    subscriptions.set(subscriptionId, watch);
    const isCurrent = () => subscriptions.get(subscriptionId) === watch;
    let error: string | null = null;
    try {
      const directory = await resolveExplorerDirectoryPath({
        root: request.cwd,
        relativePath: request.path,
      });
      if (!isCurrent()) return;
      const subscription = await this.directoryObserver.subscribe(
        directory,
        (failure) => {
          if (!isCurrent()) return;
          this.host.emit(
            {
              type: "fs.directory.update",
              payload: { subscriptionId, error: failure ? failure.message : null },
            },
            source,
          );
        },
        { recursive: false },
      );
      if (!isCurrent()) {
        await subscription.unsubscribe();
        return;
      }
      watch.unsubscribe = subscription.unsubscribe;
    } catch (cause) {
      if (!isCurrent()) return;
      error = getErrorMessage(cause);
      this.handleDirectoryUnsubscribe({ type: "fs.directory.unsubscribe", subscriptionId }, source);
    }
    this.host.emit(
      {
        type: "fs.directory.subscribe.response",
        payload: { subscriptionId, requestId, error },
      },
      source,
    );
  }

  handleDirectoryUnsubscribe(request: DirectoryUnsubscribe, source?: object): void {
    const subscriptions = this.directorySubscriptions.get(source);
    if (!subscriptions) return;
    this.closeDirectoryWatch(subscriptions.get(request.subscriptionId)?.unsubscribe);
    subscriptions.delete(request.subscriptionId);
    if (subscriptions.size === 0) this.directorySubscriptions.delete(source);
  }

  clearDirectorySubscriptions(source?: object): void {
    const subscriptions = this.directorySubscriptions.get(source);
    if (!subscriptions) return;
    this.directorySubscriptions.delete(source);
    for (const watch of subscriptions.values()) this.closeDirectoryWatch(watch.unsubscribe);
    subscriptions.clear();
  }

  private closeDirectoryWatch(unsubscribe?: () => Promise<void>): void {
    void unsubscribe?.().catch((err: unknown) => {
      this.logger.warn({ err }, "Failed to close directory watch");
    });
  }

  private async resolveScopedRoot(target: WorkspaceFileTarget): Promise<string> {
    validateWorkspaceFilePath(target.path);
    return this.resolveWorkspaceRoot(target);
  }

  async handleFileWriteRequest(
    request: FileWriteRequest | WorkspaceFileWriteRequest,
    source?: object,
  ): Promise<void> {
    const strict = request.type === "workspace.files.write.request";
    let result: ExplorerFileWriteResult;
    try {
      const root = strict ? await this.resolveScopedRoot(request) : request.cwd;
      result = await writeExplorerFile({
        root,
        relativePath: request.path,
        content: strict ? decodeWorkspaceFileContent(request.contentBase64) : request.content,
        expectedModifiedAt: request.expectedModifiedAt,
        expectedRevision: request.expectedRevision,
        strict,
      });
    } catch (error) {
      result = { status: "error", error: getErrorMessage(error) };
    }
    this.host.emit(
      { type: "fs.file.write.response", payload: { result, requestId: request.requestId } },
      source,
    );
  }

  async handleWorkspaceFileCreateRequest(
    request: WorkspaceFileCreateRequest,
    source?: object,
  ): Promise<void> {
    let result: WorkspaceFileCreateResponse["payload"]["result"];
    try {
      const root = await this.resolveScopedRoot(request);
      const entry = request.entry.kind === "file"
        ? { kind: "file" as const, content: decodeWorkspaceFileContent(request.entry.contentBase64) }
        : request.entry;
      result = {
        status: await createScopedExplorerEntry({ root, relativePath: request.path }, entry),
      };
    } catch (error) {
      result = { status: "error", error: getErrorMessage(error) };
    }
    this.host.emit(
      { type: "workspace.files.create.response", payload: { result, requestId: request.requestId } },
      source,
    );
  }

  async handleFileEntryCreateRequest(request: FileEntryCreateRequest): Promise<void> {
    const result = await createExplorerEntry({
      root: request.cwd,
      parentPath: request.parentPath,
      name: request.name,
      kind: request.kind,
    });
    this.host.emit({
      type: "fs.entry.create.response",
      payload: {
        cwd: request.cwd,
        parentPath: request.parentPath,
        path: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryRenameRequest(request: FileEntryRenameRequest): Promise<void> {
    const result = await renameExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
      name: request.name,
    });
    this.host.emit({
      type: "fs.entry.rename.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        renamedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }
  async handleFileEntryMoveRequest(request: FileEntryMoveRequest): Promise<void> {
    const result = await moveExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
      parentPath: request.parentPath,
    });
    this.host.emit({
      type: "fs.entry.move.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        parentPath: request.parentPath,
        movedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryDuplicateRequest(request: FileEntryDuplicateRequest): Promise<void> {
    const result = await duplicateExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.host.emit({
      type: "fs.entry.duplicate.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        duplicatedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryDeleteRequest(request: FileEntryDeleteRequest): Promise<void> {
    const result = await deleteExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.host.emit({
      type: "fs.entry.delete.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  dispose(): void {
    for (const unsubscribe of this.fileSubscriptions.values()) unsubscribe();
    this.fileSubscriptions.clear();
    for (const source of this.directorySubscriptions.keys())
      this.clearDirectorySubscriptions(source);
    this.closeDirectoryWatch(() => this.directoryObserver.close());
  }

  async handleFileExplorerRequest(
    request: FileExplorerRequest | WorkspaceFileExploreRequest,
    source?: object,
  ): Promise<void> {
    const { path: requestedPath = ".", mode, requestId } = request;
    const strict = request.type === "workspace.files.explore.request";
    let cwd = "";
    try {
      cwd = strict ? await this.resolveScopedRoot(request) : request.cwd.trim();
      if (!cwd) throw new Error("cwd is required");
      const options = { root: cwd, relativePath: requestedPath, strict };
      if (mode === "list") {
        const directory = await listDirectoryEntries(options);

        this.host.emit(
          {
            type: "file_explorer_response",
            payload: {
              cwd,
              path: directory.path,
              mode,
              directory,
              file: null,
              error: null,
              requestId,
            },
          },
          source,
        );
      } else {
        const readOptions = {
          ...options,
          maxBytes: strict ? MAX_WORKSPACE_FILE_BYTES : request.maxBytes,
        };
        if (request.acceptBinary && this.host.hasBinaryChannel()) {
          await streamExplorerFile(readOptions, async (file) => {
            await this.host.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileBegin,
                requestId,
                metadata: {
                  mime: file.mimeType,
                  size: file.size,
                  encoding: file.encoding,
                  modifiedAt: file.modifiedAt,
                  revision: file.revision,
                },
              }),
              source,
            );
            for await (const chunk of file.chunks) {
              await this.host.emitBinary(
                encodeFileTransferFrame({
                  opcode: FileTransferOpcode.FileChunk,
                  requestId,
                  payload: chunk,
                }),
                source,
              );
            }
            await this.host.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileEnd,
                requestId,
              }),
              source,
            );
          });
        } else {
          const file = await readExplorerFile(readOptions);

          this.host.emit(
            {
              type: "file_explorer_response",
              payload: {
                cwd,
                path: file.path,
                mode,
                directory: null,
                file,
                error: null,
                requestId,
              },
            },
            source,
          );
        }
      }
    } catch (error) {
      const missing = strict && cwd !== "" && isMissingExplorerEntry(error);
      if (!missing) {
        this.logger.error(
          { err: error, cwd, path: requestedPath },
          `Failed to fulfill file explorer request for workspace ${cwd}`,
        );
      }
      this.host.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd: cwd || (request.type === "file_explorer_request" ? request.cwd : ""),
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: getErrorMessage(error),
            ...(missing ? { errorCode: "not_found" } : {}),
            requestId,
          },
        },
        source,
      );
    }
  }

  handleFileUploadRequest(request: FileUploadRequest): void {
    this.fileUploads.beginUpload(request);
  }

  async handleFileTransferFrame(frame: FileTransferFrame): Promise<void> {
    const response = await this.fileUploads.receiveFrame(frame);
    if (response) {
      this.host.emit(response);
    }
  }

  async handleProjectIconRequest(
    request: Extract<SessionInboundMessage, { type: "project_icon_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = request;

    try {
      const icon = await getProjectIcon(cwd);
      this.host.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFileDownloadTokenRequest(request: FileDownloadTokenRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd: workspaceCwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    this.logger.debug(
      { cwd, path: requestedPath },
      `Handling file download token request for workspace ${cwd} (${requestedPath})`,
    );

    try {
      const info = await getDownloadableFileInfo({
        root: cwd,
        relativePath: requestedPath,
      });

      const entry = this.downloadTokenStore.issueToken({
        path: info.path,
        absolutePath: info.absolutePath,
        fileName: info.fileName,
        mimeType: info.mimeType,
        size: info.size,
      });

      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: info.path,
          token: entry.token,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          size: entry.size,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to issue download token for workspace ${cwd}`,
      );
      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }
}

function decodeWorkspaceFileContent(encoded: string): Uint8Array {
  const bytes = Buffer.from(encoded, "base64");
  if (!isUtf8(bytes)) throw new Error("Workspace file content must be valid UTF-8");
  return bytes;
}

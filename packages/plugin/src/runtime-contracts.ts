import type { ComponentType } from "react";
import type { OmpApi } from "@omp-desktop/client";
import type { AgentUsage } from "@omp-desktop/protocol/agent-types";
import type { PluginContext, PluginCleanup, PluginHostProps, PluginCommandCapabilities } from "./contracts.js";
import type { PluginRpcContract } from "./rpc.js";
import type { ZodType, input, output } from "zod";

export interface PluginInstallation {
  readonly id: string;
  readonly packageId: string;
  readonly owner: "desktop" | "daemon";
  readonly version: string;
  readonly generation: number;
  readonly enabled: boolean;
  readonly declaredCapabilities: readonly string[];
  readonly grantedCapabilities: readonly string[];
}
export interface PluginStorageSnapshot<T = Record<string, unknown>> { readonly revision: number; readonly values: T }
export interface PluginStorage {
  get<T = Record<string, unknown>>(): Promise<PluginStorageSnapshot<T>>;
  patch<T = Record<string, unknown>>(patch: Partial<T>, expectedRevision: number): Promise<PluginStorageSnapshot<T>>;
}
export interface PluginSecrets {
  configured(key: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface PluginServiceSecrets extends PluginSecrets { get(key: string): Promise<string | null> }
export interface PluginNativeApi {
  invoke<T = unknown>(operation: string, input?: unknown): Promise<T>;
  subscribe(event: string, listener: (payload: unknown) => void): PluginCleanup;
}
export interface PluginSettingsPageProps extends PluginHostProps {
  installation: PluginInstallation;
  mode: "manage" | "active";
}
export interface PluginSettingsPageContribution { id: string; title: string; icon?: string; Component: ComponentType<PluginSettingsPageProps> }
export interface PluginMenuContext extends PluginCommandCapabilities {
  readonly hostId: string;
  workspaceId?: string;
  agentId?: string;
  openPanel(id: string): void;
}
export interface PluginMenuItemContribution { id: string; title: string; icon?: string; position: "workspace" | "agent" | "tab" | "application"; order?: number; onSelect(context: PluginMenuContext): void | Promise<void> }
export interface PluginTurnMetricProps {
  hostId: string; agentId: string; turnId: string | null; visible: boolean; active: boolean; cancelling: boolean;
  recordedUsage: AgentUsage | null; replayedUsage: AgentUsage | null;
}
export interface PluginTurnMetricContribution { id: string; component: ComponentType<PluginTurnMetricProps>; order?: number }
export interface PluginBackgroundIntent { requestKey: string; source: { uri: string; kind: "image" | "video" }; opacity: number; onReady(): void; onError(): void }
export interface PluginBackgroundContribution { id: string; title?: string; subscribe(listener: () => void): PluginCleanup; getSnapshot(): PluginBackgroundIntent | null }
export interface PluginOverlayContribution { id: string; Component: ComponentType; }
export interface PluginClientContext extends PluginContext {
  readonly installation: PluginInstallation;
  readonly signal: AbortSignal;
  readonly mode: "manage" | "active";
  readonly role: "client";
  readonly omp: OmpApi;
  readonly storage: PluginStorage;
  readonly secrets: PluginSecrets;
  readonly native: PluginNativeApi;
  rpc<I extends ZodType, O extends ZodType>(contract: PluginRpcContract<I, O>, value: input<I>): Promise<output<O>>;
  own(cleanup: PluginCleanup): PluginCleanup;
  addSettingsPage(contribution: PluginSettingsPageContribution): PluginCleanup;
  addMenuItem(contribution: PluginMenuItemContribution): PluginCleanup;
  addTurnMetric(contribution: PluginTurnMetricContribution): PluginCleanup;
  addBackground(contribution: PluginBackgroundContribution): PluginCleanup;
  addOverlay(contribution: PluginOverlayContribution): PluginCleanup;
}
export interface PluginServiceContext extends PluginContext {
  readonly installation: PluginInstallation;
  readonly signal: AbortSignal;
  readonly mode: "active";
  readonly role: "service";
  readonly omp: OmpApi;
  readonly storage: PluginStorage;
  readonly secrets: PluginServiceSecrets;
  readonly native: PluginNativeApi;
  own(cleanup: PluginCleanup): PluginCleanup;
  waiting(reason: string | null): void;
  addAgentTool<I extends ZodType>(contribution:PluginAgentToolContribution<I>):PluginCleanup;
  addAgentPrompt(contribution:PluginAgentPromptContribution):PluginCleanup;
}
export type PluginClientSetup = (context: PluginClientContext) => void | PluginCleanup | Promise<void | PluginCleanup>;
export type PluginServiceSetup = (context: PluginServiceContext) => void | PluginCleanup | Promise<void | PluginCleanup>;

export interface PluginManagementContext extends Pick<PluginServiceContext,"installation"|"signal"|"storage"|"secrets"|"own"> {
  readonly mode: "manage";
  readonly role: "management";
  handle<I extends ZodType,O extends ZodType>(contract:PluginRpcContract<I,O>,handler:(value:output<I>)=>input<O>|Promise<input<O>>): void;
}
export type PluginManagementSetup = (context:PluginManagementContext)=>void|PluginCleanup|Promise<void|PluginCleanup>;
export interface PluginNativeOverlayRequest {
  id: string;
  /** Served from omp-desktop://overlay/plugin-overlay/... . Inline scripts require
   * nonce="omp-overlay-renderer". Host CSP forbids network, eval, frames and forms. */
  html: string;
  width: number;
  height: number;
  position: { x: number; y: number } | null;
  state: unknown;
  onAction(action:string,input?:unknown):unknown|Promise<unknown>;
  onPosition(position:{x:number;y:number}):Promise<void>;
}
export interface PluginNativeOverlayLease {
  update(update:{state?:unknown;width?:number;height?:number;position?:{x:number;y:number}|null}):void;
  showMenu(items:readonly {id:string;label:string;type?:"separator"}[]):void;
  release():void;
}
export interface PluginAgentToolContext { readonly agentId:string;readonly turnId:string|null;readonly signal:AbortSignal }
export interface PluginAgentToolResult { content:Array<{type:string;text?:string;[key:string]:unknown}>;structuredContent?:unknown;isError?:boolean }
export interface PluginAgentToolContribution<I extends ZodType=ZodType> { name:string;description:string;input:I;handler(value:output<I>,context:PluginAgentToolContext):unknown|Promise<unknown> }
export interface PluginAgentPromptSelection {text?:string;skills?:string[];tools?:string[]}
export interface PluginAgentPromptContribution {id:string;handler(context:PluginAgentToolContext):string|null|PluginAgentPromptSelection|Promise<string|null|PluginAgentPromptSelection>}
export interface PluginNativeOverlayWireRequest {
  id: string;
  /** Served from omp-desktop://overlay/plugin-overlay/... . Inline scripts require
   * nonce="omp-overlay-renderer". Host CSP forbids network, eval, frames and forms. */
  html: string;
  width: number;
  height: number;
  position: { x: number; y: number } | null;
  state: unknown;
  actionMethod: string;
  positionMethod: string;
}
export interface PluginNativeOverlayWireLease {leaseId:string}

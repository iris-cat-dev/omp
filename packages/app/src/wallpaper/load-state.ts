import { useSyncExternalStore } from "react";

export type WallpaperLoadStatus = "loading" | "ready" | "error";

let currentKey: string | null = null;
let currentToken = 0;
let currentStatus: WallpaperLoadStatus = "loading";
let retryRevision = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function beginWallpaperLoad(key: string | null): number {
  currentKey = key;
  currentToken += 1;
  currentStatus = "loading";
  notify();
  return currentToken;
}

export function finishWallpaperLoad(token: number, status: "ready" | "error"): void {
  if (
    currentToken !== token ||
    currentKey === null ||
    currentStatus === status ||
    currentStatus === "error"
  )
    return;
  currentStatus = status;
  notify();
}

export function endWallpaperLoad(token: number): void {
  if (currentToken !== token) return;
  beginWallpaperLoad(null);
}

export function retryWallpaperLoad(): void {
  retryRevision += 1;
  // Invalidate the old DOM event handlers before React commits the next attempt.
  currentToken += 1;
  currentStatus = "loading";
  notify();
}

export function getWallpaperLoadStatus(key: string | null): WallpaperLoadStatus {
  return key !== null && key === currentKey ? currentStatus : "loading";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWallpaperRetryRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => retryRevision,
    () => 0,
  );
}

export function useWallpaperLoadStatus(key: string | null): WallpaperLoadStatus {
  return useSyncExternalStore(
    subscribe,
    () => getWallpaperLoadStatus(key),
    () => "loading",
  );
}

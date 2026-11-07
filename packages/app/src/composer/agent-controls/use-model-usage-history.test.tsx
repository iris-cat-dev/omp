// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getModelUsageKey,
  useModelUsageStore,
  type ModelUsageSelection,
} from "@/stores/model-usage-store";
import { useModelUsageHistory } from "./use-model-usage-history";

const error = vi.hoisted(() => vi.fn());
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error }) }));

type Input = Parameters<typeof useModelUsageHistory>[0];
const selection: ModelUsageSelection = {
  serverId: "host",
  provider: "omp",
  modelId: "model-a",
  thinkingOptionId: "high",
  speed: "ultrafast",
};
function input(overrides: Partial<Input> = {}): Input {
  return {
    serverId: "host",
    provider: "omp",
    modelId: "model-a",
    thinkingOptionId: "high",
    thinkingOptions: [{ id: "medium" }, { id: "high" }],
    fastMode: {
      id: "fast_mode",
      label: "Speed",
      type: "select",
      value: "ultrafast",
      options: ["off", "on", "ultrafast"].map((id) => ({ id, label: id })),
    },
    metadataStatus: "ready",
    open: true,
    pending: false,
    disabled: false,
    onSelectModel: vi.fn(),
    onSelectThinkingOption: vi.fn(),
    onSetFeature: vi.fn(),
    ...overrides,
  };
}
beforeEach(async () => {
  await useModelUsageStore.persist.rehydrate();
  useModelUsageStore.setState({ entries: [] });
  error.mockClear();
});
afterEach(cleanup);

describe("model usage interactions", () => {
  it("records only the final confirmed combination once after closing, without counting passive visits", async () => {
    const initial = input();
    const { result, rerender } = renderHook(useModelUsageHistory, { initialProps: initial });
    rerender({ ...initial, open: false });
    expect(result.current.history.entries).toEqual([]);
    rerender(initial);
    act(() => result.current.markModelSelection("omp", "model-b"));
    rerender({
      ...initial,
      modelId: "model-b",
      thinkingOptionId: "medium",
      metadataStatus: "loading",
    });
    act(() => result.current.markSettingsChange());
    rerender({
      ...initial,
      modelId: "model-b",
      open: false,
      pending: true,
      metadataStatus: "loading",
    });
    expect(result.current.history.entries).toEqual([]);
    rerender({ ...initial, modelId: "model-b", open: false });
    await waitFor(() =>
      expect(result.current.history.entries).toEqual([
        expect.objectContaining({
          modelId: "model-b",
          thinkingOptionId: "high",
          speed: "ultrafast",
          useCount: 1,
        }),
      ]),
    );
    rerender({ ...initial, modelId: "model-b", open: true });
    rerender({ ...initial, modelId: "model-b", open: false });
    expect(result.current.history.entries[0].useCount).toBe(1);
  });

  it("waits for the target model's speed capabilities and counts the restored combination only on close", async () => {
    useModelUsageStore.getState().recordUsage(selection);
    const saved = useModelUsageStore.getState().entries[0];
    const initial = input({ modelId: "model-b", thinkingOptionId: "medium", fastMode: null });
    const { result, rerender } = renderHook(useModelUsageHistory, { initialProps: initial });
    await act(async () => result.current.history.onSelect(saved));
    rerender({ ...initial, modelId: "model-a", metadataStatus: "loading" });
    rerender({
      ...initial,
      modelId: "model-a",
      thinkingOptionId: "high",
      metadataStatus: "loading",
    });
    expect(result.current.restoring).toBe(true);
    expect(initial.onSetFeature).not.toHaveBeenCalled();
    const ready = input({
      onSetFeature: initial.onSetFeature,
      fastMode: {
        id: "fast_mode",
        label: "Speed",
        type: "select",
        value: "off",
        options: ["off", "on", "ultrafast"].map((id) => ({ id, label: id })),
      },
    });
    rerender(ready);
    await waitFor(() =>
      expect(initial.onSetFeature).toHaveBeenCalledWith("fast_mode", "ultrafast"),
    );
    rerender(input({ onSetFeature: initial.onSetFeature }));
    await waitFor(() => expect(result.current.restoring).toBe(false));
    expect(result.current.history.entries[0].useCount).toBe(1);
    rerender(input({ open: false }));
    await waitFor(() =>
      expect(result.current.history.entries[0]).toMatchObject({ ...selection, useCount: 2 }),
    );
  });

  it("rejects saved Ultrafast on a legacy toggle without replacing it with Fast or increasing frequency", async () => {
    useModelUsageStore.getState().recordUsage(selection);
    const saved = useModelUsageStore.getState().entries[0];
    const initial = input({
      fastMode: { id: "fast_mode", label: "Fast", type: "toggle", value: false },
    });
    const { result, rerender } = renderHook(useModelUsageHistory, { initialProps: initial });
    await act(async () => result.current.history.onSelect(saved));
    await waitFor(() => expect(result.current.restoring).toBe(false));
    expect(error).toHaveBeenCalledOnce();
    expect(initial.onSetFeature).not.toHaveBeenCalled();
    rerender({ ...initial, open: false });
    expect(result.current.history.entries).toEqual([saved]);
  });

  it("keeps deleted active records deleted when a dirty menu closes", async () => {
    useModelUsageStore.getState().recordUsage(selection);
    const other = { ...selection, modelId: "model-b" };
    useModelUsageStore.getState().recordUsage(other);
    const initial = input();
    const { result, rerender } = renderHook(useModelUsageHistory, { initialProps: initial });
    act(() => result.current.markModelSelection("omp", "model-a"));
    act(() => result.current.history.onRemove(getModelUsageKey(selection)));
    rerender({ ...initial, open: false });
    expect(result.current.history.entries).toEqual([
      expect.objectContaining({ ...other, useCount: 1 }),
    ]);
    expect(result.current.history.selection).toEqual(selection);
  });

  it("does not transfer a pending usage increment to a different host", () => {
    const initial = input();
    const { result, rerender } = renderHook(useModelUsageHistory, { initialProps: initial });
    act(() => result.current.markModelSelection("omp", "model-a"));
    rerender({ ...initial, serverId: "other-host", open: false });
    expect(result.current.history.entries).toEqual([]);
    expect(useModelUsageStore.getState().entries).toEqual([]);
  });

  it("does not recreate a record deleted while its configuration request is in flight", async () => {
    useModelUsageStore.getState().recordUsage(selection);
    const saved = useModelUsageStore.getState().entries[0];
    const request = Promise.withResolvers<void>();
    const initial = input({ onApplyConfiguration: () => request.promise });
    const { result, rerender } = renderHook(useModelUsageHistory, { initialProps: initial });
    let applying: void | Promise<void>;
    act(() => {
      applying = result.current.history.onSelect(saved);
    });
    act(() => result.current.history.onRemove(saved.key));
    await act(async () => {
      request.resolve();
      await applying;
    });
    rerender({ ...initial, open: false });
    expect(result.current.history.entries).toEqual([]);
    expect(result.current.restoring).toBe(false);
  });

  it("releases controls after a rejected configuration without recording success", async () => {
    useModelUsageStore.getState().recordUsage(selection);
    const saved = useModelUsageStore.getState().entries[0];
    const initial = input({
      onApplyConfiguration: async () => {
        throw new Error("Access denied");
      },
    });
    const { result, rerender } = renderHook(useModelUsageHistory, { initialProps: initial });
    await act(async () => result.current.history.onSelect(saved));
    rerender({ ...initial, open: false });
    expect(result.current.restoring).toBe(false);
    expect(result.current.history.disabled).toBe(false);
    expect(result.current.history.entries).toEqual([saved]);
    expect(error).toHaveBeenCalledWith("Access denied");
  });
});

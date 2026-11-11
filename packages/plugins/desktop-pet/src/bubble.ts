import type { DesktopPetActivity, PetBubbleProfile, PetBubbleState } from "./types.js";

// Keep this factory self-contained: html.ts embeds its emitted JavaScript in the sandboxed page.
export function createPetBubbleController(profile: PetBubbleProfile) {
  const positions: Record<PetBubbleState, number> = {
    idle: 0,
    offline: 0,
    running: 0,
    needs_input: 0,
    ready: 0,
    blocked: 0,
    dragging: 0,
    petted: 0,
  };
  let initialized = false;
  let baseState: PetBubbleState = "idle";
  let baseServerId: string | undefined;
  let baseAgentId: string | undefined;
  let activeState: PetBubbleState = "idle";
  let dragging = false;
  let petting = false;

  function enter(state: PetBubbleState, now: number) {
    activeState = state;
    const rule = profile.states[state];
    controller.line = null;
    controller.nextAt = rule.messages.length === 0 ? Infinity : now + rule.delayMs;
  }

  function updateBase(activity: Pick<DesktopPetActivity, "connected" | "tasks">): boolean {
    // Activity already orders attention before running; never search for another task.
    const task = activity.connected ? activity.tasks[0] : undefined;
    const nextBaseState = activity.connected ? (task?.status ?? "idle") : "offline";
    const changed =
      initialized &&
      (nextBaseState !== baseState ||
        task?.serverId !== baseServerId ||
        task?.agentId !== baseAgentId);
    baseState = nextBaseState;
    baseServerId = task?.serverId;
    baseAgentId = task?.agentId;
    return changed;
  }

  function showMessage(now: number): void {
    const rule = profile.states[activeState];
    controller.line = rule.messages[positions[activeState]];
    positions[activeState] = (positions[activeState] + 1) % rule.messages.length;
    controller.nextAt = rule.durationMs === 0 ? Infinity : now + rule.durationMs;
  }

  function advanceMessageClock(now: number): void {
    if (now < controller.nextAt) return;
    if (controller.line === null) {
      showMessage(now);
    } else if (activeState === "petted") {
      // Petting is a single event, not a repeating state. Release cannot cut it short.
      enter(baseState, now);
      if (controller.nextAt <= now) showMessage(now);
    } else {
      const rule = profile.states[activeState];
      controller.line = null;
      // Late callbacks start a full repeat wait; never replay missed messages in a burst.
      controller.nextAt = rule.repeatDelayMs === 0 ? Infinity : now + rule.repeatDelayMs;
    }
  }

  const controller = {
    line: null as string | null,
    nextAt: Infinity,
    update(
      activity: Pick<DesktopPetActivity, "connected" | "tasks">,
      now: number,
      interaction: { dragging: boolean; petting: boolean },
    ): boolean {
      const before = controller.line;
      const baseChanged = updateBase(activity);
      const pettingStarted = interaction.petting && !petting;

      if (interaction.dragging) {
        if (!initialized || !dragging) enter("dragging", now);
      } else if (dragging || baseChanged) {
        // Release and task transitions cancel stale petting, even before its delay expires.
        enter(baseState, now);
      } else if (pettingStarted) {
        enter("petted", now);
      } else if (!initialized) {
        enter(baseState, now);
      } else if (
        activeState === "petted" &&
        profile.states.petted.messages.length === 0 &&
        petting &&
        !interaction.petting
      ) {
        // A silent gesture has no message deadline; release restores normal state timing.
        enter(baseState, now);
      }
      initialized = true;
      dragging = interaction.dragging;
      petting = interaction.petting;

      advanceMessageClock(now);
      return controller.line !== before;
    },
  };
  return controller;
}

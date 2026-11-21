import { describe, expect, it } from "vitest";
import type { MobilePanelView } from "@/stores/panel-store";
import {
  createMobilePanelMotionState,
  getMobilePanelFrame,
  transitionMobilePanel,
  type MobilePanelEvent,
  type MobilePanelMotionState,
} from "./model";

class MobilePanelsScenario {
  private nextRevision = 0;
  private state: MobilePanelMotionState;

  constructor(target: MobilePanelView = "agent") {
    this.state = createMobilePanelMotionState({ target, revision: this.nextRevision });
  }

  command(target: MobilePanelView) {
    this.nextRevision += 1;
    this.dispatch({ type: "command", selection: { target, revision: this.nextRevision } });
    return this;
  }

  finishAnimation(target: MobilePanelView, revision = this.state.revision) {
    this.dispatch({ type: "animation.finished", revision, target });
    return this;
  }

  snapshot() {
    return {
      motionTarget: this.state.motionTarget,
      revision: this.state.revision,
      settledTarget: this.state.settledTarget,
      target: this.state.target,
    };
  }

  private dispatch(event: MobilePanelEvent) {
    const transition = transitionMobilePanel(this.state, event);
    this.state = transition.state;
  }
}

describe("mobile panel ownership", () => {
  it("follows programmatic commands through left, center, and right", () => {
    const panels = new MobilePanelsScenario();

    panels.command("agent-list").finishAnimation("agent-list");
    expect(panels.snapshot()).toEqual({
      target: "agent-list",
      motionTarget: "agent-list",
      settledTarget: "agent-list",
      revision: 1,
    });

    panels.command("agent").command("file-explorer").finishAnimation("file-explorer");
    expect(panels.snapshot()).toEqual({
      target: "file-explorer",
      motionTarget: "file-explorer",
      settledTarget: "file-explorer",
      revision: 3,
    });
  });

  it("keeps the latest rapid command and rejects stale animation completion", () => {
    const panels = new MobilePanelsScenario();

    panels.command("agent-list");
    const staleRevision = panels.snapshot().revision;
    panels.command("agent").command("file-explorer");
    panels.finishAnimation("agent-list", staleRevision);

    expect(panels.snapshot()).toEqual({
      target: "file-explorer",
      motionTarget: "file-explorer",
      settledTarget: "agent",
      revision: 3,
    });
  });

  it("derives both transforms and both backdrops from one normalized position", () => {
    expect(getMobilePanelFrame(0.25, 400)).toEqual({
      leftBackdropOpacity: 0,
      leftTranslateX: -400,
      rightBackdropOpacity: 0.25,
      rightTranslateX: 300,
    });
    expect(getMobilePanelFrame(0.25, 800)).toEqual({
      leftBackdropOpacity: 0,
      leftTranslateX: -800,
      rightBackdropOpacity: 0.25,
      rightTranslateX: 600,
    });
  });
});

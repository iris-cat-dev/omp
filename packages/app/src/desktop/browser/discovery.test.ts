import { describe, expect, it } from "vitest";
import { createBrowserRecord, type BrowserRecord } from "./store/state";
import { collectWorkspaceBrowserEntries } from "./discovery";
import { normalizeLayout, type WorkspaceLayout } from "@/stores/workspace-layout-actions";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

function layout(targets: WorkspaceTabTarget[]): WorkspaceLayout {
  return normalizeLayout({
    focusedPaneId: "main",
    root: {
      kind: "pane",
      pane: {
        id: "main",
        focusedTabId: "slot-0",
        tabs: targets.map((target, index) => ({ tabId: `slot-${index}`, target, createdAt: 0 })),
      },
    },
  });
}

function browser(browserId: string, ownerWorkspaceId?: string, serverId = "server") {
  return createBrowserRecord({
    browserId,
    automationServerId: ownerWorkspaceId ? serverId : null,
    automationWorkspaceId: ownerWorkspaceId ?? null,
    initialUrl: "https://example.com",
    now: 0,
  });
}

function browserTarget(browserId: string): WorkspaceTabTarget {
  return { kind: "browser", browserId };
}

function discover(records: BrowserRecord[], layouts: Record<string, WorkspaceLayout>) {
  return collectWorkspaceBrowserEntries({
    serverId: "server",
    workspaceId: "owner",
    browsersById: Object.fromEntries(records.map((record) => [record.browserId, record])),
    layoutByWorkspace: layouts,
  }).map((entry) => ({ id: entry.browser.browserId, hosts: entry.hostWorkspaceIds }));
}

describe("workspace browser discovery", () => {
  it("finds owner browsers in other hosts and without layout entries", () => {
    expect(
      discover([browser("hosted", "owner"), browser("unhosted", "owner")], {
        "server:guest": layout([browserTarget("hosted"), browserTarget("hosted")]),
        "other-server:foreign": layout([browserTarget("hosted")]),
      }),
    ).toEqual([
      { id: "hosted", hosts: ["guest"] },
      { id: "unhosted", hosts: [] },
    ]);
  });

  it("includes hosted guest and UI-owned browsers but hides unrelated workspaces", () => {
    expect(
      discover(
        [
          browser("guest", "another-owner"),
          browser("ui-owned"),
          browser("unrelated", "another-owner"),
          browser("ui-unrelated"),
        ],
        {
          "server:owner": layout([browserTarget("guest"), browserTarget("ui-owned")]),
          "server:another-owner": layout([
            browserTarget("unrelated"),
            browserTarget("ui-unrelated"),
          ]),
        },
      ),
    ).toEqual([
      { id: "guest", hosts: ["owner"] },
      { id: "ui-owned", hosts: ["owner"] },
    ]);
  });

  it("rejects other-server ownership even with a stale local browser entry", () => {
    expect(
      discover([browser("foreign", "owner", "other-server"), browser("foreign-ui")], {
        "server:owner": layout([browserTarget("foreign")]),
        "other-server:owner": layout([browserTarget("foreign-ui")]),
      }),
    ).toEqual([]);
  });
});

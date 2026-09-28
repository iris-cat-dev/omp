import { describe, expect, it } from "vitest";
import { listActiveWorkspaceRootAgentIds, pickWorkspacePrimaryAgentId } from "@/subagents/policies";

describe("workspace conversation references", () => {
  it("selects the oldest workspace root despite history order and newer conversations", () => {
    expect(
      pickWorkspacePrimaryAgentId(
        [
          {
            id: "child",
            workspaceId: "workspace-1",
            parentAgentId: "root-old",
            createdAt: "2026-03-02",
          },
          {
            id: "root-new",
            workspaceId: "workspace-1",
            parentAgentId: null,
            createdAt: "2026-03-03",
          },
          {
            id: "root-old",
            workspaceId: "workspace-1",
            parentAgentId: null,
            createdAt: "2026-03-01",
          },
        ],
        "workspace-1",
      ),
    ).toBe("root-old");
  });

  it("lists every active root in stable creation order for legacy duplicate workspaces", () => {
    expect(
      listActiveWorkspaceRootAgentIds(
        [
          {
            id: "root-new",
            workspaceId: "workspace-1",
            parentAgentId: null,
            createdAt: "2026-03-03",
          },
          {
            id: "child",
            workspaceId: "workspace-1",
            parentAgentId: "root-old",
            createdAt: "2026-03-02",
          },
          {
            id: "archived-root",
            workspaceId: "workspace-1",
            parentAgentId: null,
            createdAt: "2026-02-28",
            archivedAt: "2026-03-04",
          },
          {
            id: "root-old",
            workspaceId: "workspace-1",
            parentAgentId: null,
            createdAt: "2026-03-01",
          },
        ],
        "workspace-1",
      ),
    ).toEqual(["root-old", "root-new"]);
  });

  it("treats a child whose known parent has no workspace as the target workspace root", () => {
    expect(
      listActiveWorkspaceRootAgentIds(
        [
          { id: "legacy-parent", parentAgentId: null },
          {
            id: "workspace-root",
            workspaceId: "workspace-1",
            parentAgentId: "legacy-parent",
          },
        ],
        "workspace-1",
      ),
    ).toEqual(["workspace-root"]);
  });

  it("promotes the oldest active root when the former primary is archived", () => {
    expect(
      pickWorkspacePrimaryAgentId(
        [
          {
            id: "archived",
            workspaceId: "workspace-1",
            parentAgentId: null,
            createdAt: "2026-03-01",
            archivedAt: "2026-03-04",
          },
          {
            id: "active",
            workspaceId: "workspace-1",
            parentAgentId: null,
            createdAt: "2026-03-02",
          },
        ],
        "workspace-1",
      ),
    ).toBe("active");
  });

  it("treats an agent whose parent belongs to another workspace as a root", () => {
    expect(
      pickWorkspacePrimaryAgentId(
        [
          { id: "root", workspaceId: "workspace-1", parentAgentId: "outside-parent" },
          { id: "outside-parent", workspaceId: "workspace-2", parentAgentId: null },
        ],
        "workspace-1",
      ),
    ).toBe("root");
  });

  it("returns null when the workspace has no conversation", () => {
    expect(
      pickWorkspacePrimaryAgentId(
        [{ id: "root", workspaceId: "workspace-2", parentAgentId: null }],
        "workspace-1",
      ),
    ).toBeNull();
  });
});

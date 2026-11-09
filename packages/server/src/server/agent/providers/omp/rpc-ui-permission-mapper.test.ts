import { describe, expect, test } from "vitest";

import type { OmpRuntimeEvent } from "./rpc-types.js";
import {
  buildOmpRpcUiPermissionResponse,
  classifyOmpRpcUiPermissionRequest,
  mapOmpRpcUiPermissionRequest,
} from "./rpc-ui-permission-mapper.js";

type ExtensionUiRequestEvent = Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>;

const GROUPED_ASK: ExtensionUiRequestEvent = {
  type: "extension_ui_request",
  id: "grouped-ask",
  method: "ask",
  questions: [
    {
      id: "deployment",
      header: "Choice",
      question: "Where should we deploy?",
      options: [
        {
          label: "East, West (Recommended)",
          description: "Both regions",
          preview: "region preview",
        },
        { label: "Staging" },
      ],
      recommended: 1,
    },
    {
      id: "features",
      header: "Choice",
      question: "Which features should ship?",
      options: [{ label: "Search" }, { label: "Export, CSV" }],
      multi: true,
    },
  ],
};

function groupedAsk() {
  const request = mapOmpRpcUiPermissionRequest(GROUPED_ASK);
  if (!request) throw new Error("Expected grouped ask permission");
  return request;
}

const RPC_UI_CASES: ExtensionUiRequestEvent[] = [
  { type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "status" },
  { type: "extension_ui_request", id: "notify", method: "notify", message: "done" },
  {
    type: "extension_ui_request",
    id: "bash",
    method: "select",
    title: "Allow tool: bash\nCommand: echo rpc-ui-hi",
    options: ["Approve", "Deny"],
  },
  {
    type: "extension_ui_request",
    id: "edit",
    method: "select",
    title: "Allow tool: edit\nFile: fixture.txt",
    options: ["Approve", "Deny"],
  },
  {
    type: "extension_ui_request",
    id: "write",
    method: "select",
    title: "Allow tool: write\nPath: created.txt\nContent:\nhello write",
    options: ["Approve", "Deny"],
  },
];

function toolApproval(id: string) {
  const event = RPC_UI_CASES.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`Missing RPC-UI case ${id}`);
  const classification = classifyOmpRpcUiPermissionRequest(event);
  if (classification.kind !== "tool") throw new Error(`Expected ${id} to be a tool approval`);
  return classification.request;
}

describe("OMP rpc-ui permission mapper", () => {
  test("maps the entire ask group without changing option identities or merging duplicate headers", () => {
    expect(classifyOmpRpcUiPermissionRequest(GROUPED_ASK)).toEqual({ kind: "passthrough" });
    expect(groupedAsk()).toMatchObject({
      id: "grouped-ask",
      provider: "omp",
      kind: "question",
      input: {
        questions: [
          {
            id: "deployment",
            header: "Choice",
            question: "Where should we deploy?",
            options: [
              {
                label: "East, West (Recommended)",
                description: "Both regions",
                preview: "region preview",
                recommended: false,
              },
              { label: "Staging", recommended: true },
            ],
            multiSelect: false,
            allowOther: true,
          },
          {
            id: "features",
            header: "Choice",
            question: "Which features should ship?",
            options: [
              { label: "Search", recommended: false },
              { label: "Export, CSV", recommended: false },
            ],
            multiSelect: true,
            allowOther: true,
          },
        ],
      },
      metadata: { extensionUiMethod: "ask", questions: GROUPED_ASK.questions },
    });
  });

  test("falls back to question IDs only for absent or blank headers", () => {
    const request = mapOmpRpcUiPermissionRequest(
      {
        ...GROUPED_ASK,
        questions: [
          { id: "no-header", question: "First?", options: [] },
          { id: "blank-header", header: "  ", question: "Second?", options: [] },
          { id: "header", header: " Visible ", question: "Third?", options: [] },
        ],
      },
      { provider: "omp" },
    );
    expect(request?.input?.questions).toMatchObject([
      { id: "no-header", header: "no-header" },
      { id: "blank-header", header: "blank-header" },
      { id: "header", header: " Visible " },
    ]);
  });

  test.each(
    [
      undefined,
      [],
      [{ id: "invalid", question: "Invalid?", options: ["plain label"] }],
      [{ id: "invalid", question: "Invalid?", options: [], multi: "yes" }],
    ].map((questions) => ({ questions })),
  )("rejects malformed ask questions at the RPC boundary: %j", ({ questions }) => {
    expect(() => mapOmpRpcUiPermissionRequest({ ...GROUPED_ASK, questions })).toThrow();
  });

  test("returns ordered selections and custom input independently with their exact contents", () => {
    const answers = [
      { id: "deployment", selectedOptions: ["East, West (Recommended)"] },
      {
        id: "features",
        selectedOptions: ["Search", "Export, CSV"],
        customInput: "  Extra feature  ",
      },
    ];
    expect(
      buildOmpRpcUiPermissionResponse(groupedAsk(), {
        behavior: "allow",
        updatedInput: { answers },
      }),
    ).toEqual({ answers });
  });

  test("does not infer selected options from custom input that matches an option label", () => {
    const answers = [
      { id: "deployment", selectedOptions: [], customInput: "Staging" },
      { id: "features", selectedOptions: [], customInput: "Search" },
    ];
    expect(
      buildOmpRpcUiPermissionResponse(groupedAsk(), {
        behavior: "allow",
        updatedInput: { answers },
      }),
    ).toEqual({ answers });
  });

  test("cancels the complete ask group without requiring answers", () => {
    expect(buildOmpRpcUiPermissionResponse(groupedAsk(), { behavior: "deny" })).toEqual({
      cancelled: true,
    });
  });

  test.each(
    [
      undefined,
      { Choice: "Staging" },
      [{ id: "deployment", selectedOptions: ["Staging"] }],
      [
        { id: "features", selectedOptions: ["Search"] },
        { id: "deployment", selectedOptions: ["Staging"] },
      ],
      [
        { id: "deployment", selectedOptions: ["Staging"] },
        { id: "deployment", selectedOptions: ["Search"] },
      ],
      [
        { id: "deployment", selectedOptions: "Staging" },
        { id: "features", selectedOptions: ["Search"] },
      ],
      [
        { id: "deployment", selectedOptions: ["East, West"] },
        { id: "features", selectedOptions: ["Search"] },
      ],
      [
        { id: "deployment", selectedOptions: ["East", "West (Recommended)"] },
        { id: "features", selectedOptions: ["Search"] },
      ],
      [
        { id: "deployment", selectedOptions: ["Staging"] },
        { id: "features", selectedOptions: ["Search", "Search"] },
      ],
      [
        { id: "deployment", selectedOptions: [] },
        { id: "features", selectedOptions: ["Search"] },
      ],
      [
        { id: "deployment", selectedOptions: [], customInput: "  " },
        { id: "features", selectedOptions: ["Search"] },
      ],
      [
        { id: "deployment", selectedOptions: ["Staging", "East, West (Recommended)"] },
        { id: "features", selectedOptions: ["Search"] },
      ],
      [
        { id: "deployment", selectedOptions: ["Staging"], customInput: "Other" },
        { id: "features", selectedOptions: ["Search"] },
      ],
      [
        { id: "deployment", selectedOptions: ["Staging"] },
        { id: "features", selectedOptions: [], customInput: 3 },
      ],
      [
        { id: "deployment", selectedOptions: ["Staging"] },
        { id: "features", selectedOptions: ["Search"] },
        { id: "extra", selectedOptions: [] },
      ],
    ].map((answers) => ({ answers })),
  )("rejects malformed or incomplete answer groups: %j", ({ answers }) => {
    expect(() =>
      buildOmpRpcUiPermissionResponse(groupedAsk(), {
        behavior: "allow",
        updatedInput: { answers },
      }),
    ).toThrow();
  });

  test("classifies tool approvals and passes through unrelated UI requests", () => {
    expect(
      RPC_UI_CASES.map((event) => {
        const classification = classifyOmpRpcUiPermissionRequest(event);
        return [event.id, classification.kind];
      }),
    ).toEqual([
      ["widget", "passthrough"],
      ["notify", "passthrough"],
      ["bash", "tool"],
      ["edit", "tool"],
      ["write", "tool"],
    ]);
  });

  test("maps tool approvals to renderable permissions", () => {
    expect([toolApproval("bash"), toolApproval("edit"), toolApproval("write")]).toEqual([
      expect.objectContaining({
        id: "bash",
        provider: "omp",
        name: "bash",
        kind: "tool",
        detail: { type: "shell", command: "echo rpc-ui-hi" },
        metadata: expect.objectContaining({
          toolName: "bash",
          toolArgs: { command: "echo rpc-ui-hi" },
          approveValue: "Approve",
          denyValue: "Deny",
        }),
      }),
      expect.objectContaining({
        id: "edit",
        provider: "omp",
        name: "edit",
        kind: "tool",
        detail: { type: "edit", filePath: "fixture.txt" },
        metadata: expect.objectContaining({ toolName: "edit", toolArgs: { path: "fixture.txt" } }),
      }),
      expect.objectContaining({
        id: "write",
        provider: "omp",
        name: "write",
        kind: "tool",
        detail: { type: "write", filePath: "created.txt", content: "hello write" },
        metadata: expect.objectContaining({
          toolName: "write",
          toolArgs: { path: "created.txt", content: "hello write" },
        }),
      }),
    ]);
  });

  test("preserves destructive multiline CRLF bash commands exactly", () => {
    const title = "Allow tool: bash\r\nCommand: printf first\r\n\r\n  rm -rf /tmp/example\r\n";
    const classification = classifyOmpRpcUiPermissionRequest({
      type: "extension_ui_request",
      id: "multiline-bash",
      method: "select",
      title,
      options: ["Approve", "Deny"],
    });
    if (classification.kind !== "tool") throw new Error("Expected multiline bash approval");

    expect(classification.request.detail).toEqual({
      type: "shell",
      command: "printf first\r\n\r\n  rm -rf /tmp/example\r\n",
    });
    expect(classification.request.metadata?.toolArgs).toEqual({
      command: "printf first\r\n\r\n  rm -rf /tmp/example\r\n",
    });
  });

  test("rejects approval lookalikes and unknown tools", () => {
    expect(
      classifyOmpRpcUiPermissionRequest({
        type: "extension_ui_request",
        id: "not-tool",
        method: "select",
        title: "Allow tool: bash\nCommand: echo hi",
        options: ["Yes", "No"],
      }),
    ).toEqual({ kind: "passthrough" });
    expect(
      classifyOmpRpcUiPermissionRequest({
        type: "extension_ui_request",
        id: "unknown-tool",
        method: "select",
        title: "Allow tool: custom_tool\nReason: needs approval",
        options: ["Approve", "Deny"],
      }),
    ).toEqual({ kind: "passthrough" });
  });

  test.each([
    ["Approve", "Approve edit for this session", "Deny"],
    ["Approve", "Approve all tools for this session", "Deny"],
    ["Deny", "Approve bash for this session", "Approve"],
    ["Approve", "Approve bash for this session", "Deny", "Other"],
  ])("leaves unrecognized session-grant options for the user: %j", (...options) => {
    expect(
      classifyOmpRpcUiPermissionRequest({
        type: "extension_ui_request",
        id: "unrecognized-grant",
        method: "select",
        title: "Allow tool: bash\nCommand: echo hi",
        options,
      }),
    ).toEqual({ kind: "passthrough" });
  });

  test("responds to tool approvals with exact select values", () => {
    const request = toolApproval("bash");

    expect(buildOmpRpcUiPermissionResponse(request, { behavior: "allow" })).toEqual({
      value: "Approve",
    });
    expect(
      buildOmpRpcUiPermissionResponse(request, {
        behavior: "allow",
        selectedActionId: "allow_always",
      }),
    ).toEqual({ value: "Approve" });
    expect(buildOmpRpcUiPermissionResponse(request, { behavior: "deny", message: "no" })).toEqual({
      value: "Deny",
    });
  });
});

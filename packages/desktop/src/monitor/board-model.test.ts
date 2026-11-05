/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MONITOR_BOARD_MODEL_SCRIPT } from "./board-model.js";
import { MONITOR_BOARD_MARKUP } from "./board-ui.js";
import { MONITOR_BOARD_RENDERER_SCRIPT } from "./board-renderer.js";
import { MONITOR_BOARD_EFFECTS_SCRIPT } from "./board-renderer-effects.js";
import { MONITOR_PERF_MARKUP, MONITOR_PERF_SCRIPT } from "./performance-ui.js";
import { MONITOR_TITLE_THEMES_SCRIPT } from "./title-themes-ui.js";
import type { OmpTitleThemesState } from "./title-themes.js";
import { MONITOR_VISUALS_SCRIPT } from "./visuals.js";
import type { MonitorPerformanceEvaluation } from "./performance-types.js";
import {
  DEFAULT_BOARD_PREFERENCES,
  type OmpMonitorBoardPreferences,
  type OmpMonitorBoardSize,
  type OmpMonitorBoardStyle,
} from "./board-types.js";

interface RankGroup {
  id: string;
  live: number;
  lastActiveMs: number;
}
interface RankEvent {
  type: "overtake" | "newLeader";
  id: string;
  from: number;
  to: number;
}
interface ModeFact {
  value: string;
  evidence: "selected" | "recorded" | "configured";
  provider: string | null;
}
interface Agent {
  id: string;
  project?: string;
  name?: string;
  model?: string;
  parentId: string | null;
  lastActivityAt: number;
  phase: "idle" | "tools" | "generating";
  liveMeasuredTps: number;
  liveEstimatedTps: number;
  liveMeasuredTotalTps?: number;
  liveEstimatedTotalTps?: number;
  effortMode?: ModeFact | null;
  speedMode?: ModeFact | null;
  thinkingTps: number | null;
  liveCostUsdPerSecond: number | null;
  outputTps?: number;
}
interface PerformanceValue {
  form: "none" | "live" | "resting";
  score: number | null;
  shown: number | null;
  provisional: boolean;
  n: number;
}
interface Score {
  agent: Agent | null;
  value: number | null;
  form: string;
  count: number;
  provisional: boolean;
  n: number;
}
interface Aggregate {
  live: number;
  estimated: number;
  thinking: number | null;
  cost: number | null;
  costPartial: boolean;
  generating: number;
  tools: number;
  lastActiveMs: number;
  score: Score;
}
interface BoardGroup extends Aggregate {
  id: string;
  root: Agent;
  members: Agent[];
  subs: Agent[];
}
type Readouts = Pick<OmpMonitorBoardPreferences, "showPerformance" | "showThinking" | "showCost">;
interface BoardGeometry {
  side: number;
  pad: number;
  heroTop: number;
  hero: number;
  listTop: number;
  listBottom: number;
  startY: number;
  room: number;
  groupHeight: number;
  subHeight: number;
  moreHeight: number;
  footerTop: number;
  footerHeight: number;
}
interface BoardEntry {
  key: string;
  kind: "group" | "sub" | "more";
  group: BoardGroup;
  agent?: Agent;
  y: number;
  height: number;
  rest?: number;
  live?: number;
  allGroups?: boolean;
}
interface BoardModel {
  createRanking(): {
    tick(
      groups: RankGroup[],
      scope: string,
      tick: number,
    ): { groups: RankGroup[]; events: RankEvent[] };
    reset(): void;
  };
  metrics(
    style: OmpMonitorBoardStyle,
    size: OmpMonitorBoardSize,
    readouts: Readouts,
  ): BoardGeometry;
  layout(
    groups: BoardGroup[],
    style: OmpMonitorBoardStyle,
    size: OmpMonitorBoardSize,
    readouts: Readouts,
    expanded: string | null,
    metric?: "output" | "total",
  ): { rows: BoardEntry[]; height: number };
  groups(
    agents: Agent[],
    values: Record<string, PerformanceValue> | null,
    metric?: "output" | "total",
  ): BoardGroup[];
  aggregate(
    agents: Agent[],
    values: Record<string, PerformanceValue> | null,
    metric?: "output" | "total",
  ): Aggregate;
  score(agents: Agent[], values: Record<string, PerformanceValue> | null): Score;
  formatSpeed(value: number | null): string;
  rateNumber(value: number | null, digits: number): string;
  amountNumber(value: number | null, digits: number): string;
}
const model = new Function(MONITOR_BOARD_MODEL_SCRIPT + "\nreturn boardModel;")() as BoardModel;
const originalCases = [
  {
    name: "initial order follows the values",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 50,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 120,
            lastActiveMs: 0,
          },
          {
            id: "c",
            live: 80,
            lastActiveMs: 0,
          },
        ],
        order: ["b", "c", "a"],
        events: [],
      },
    ],
  },
  {
    name: "a lead inside 10 % never passes",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 90,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 108,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 110,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 110.9,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
    ],
  },
  {
    name: "a lead must hold for two ticks",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 90,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 130,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 95,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 130,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 131,
            lastActiveMs: 0,
          },
        ],
        order: ["b", "a"],
        events: [
          {
            type: "newLeader",
            id: "b",
            from: 2,
            to: 1,
          },
        ],
      },
    ],
  },
  {
    name: "an overwhelming lead passes at once",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 90,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 221,
            lastActiveMs: 0,
          },
        ],
        order: ["b", "a"],
        events: [
          {
            type: "newLeader",
            id: "b",
            from: 2,
            to: 1,
          },
        ],
      },
    ],
  },
  {
    name: "a climber passes several groups in one tick",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 300,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 200,
            lastActiveMs: 0,
          },
          {
            id: "c",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "d",
            live: 50,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b", "c", "d"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 300,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 200,
            lastActiveMs: 0,
          },
          {
            id: "c",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "d",
            live: 360,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b", "d", "c"],
        events: [
          {
            type: "overtake",
            id: "d",
            from: 4,
            to: 3,
          },
        ],
      },
      {
        groups: [
          {
            id: "a",
            live: 300,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 200,
            lastActiveMs: 0,
          },
          {
            id: "c",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "d",
            live: 360,
            lastActiveMs: 0,
          },
        ],
        order: ["d", "a", "b", "c"],
        events: [
          {
            type: "newLeader",
            id: "d",
            from: 3,
            to: 1,
          },
        ],
      },
    ],
  },
  {
    name: "the second place takes the lead",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 200,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 150,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 120,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 180,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 110,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 185,
            lastActiveMs: 0,
          },
        ],
        order: ["b", "a"],
        events: [
          {
            type: "newLeader",
            id: "b",
            from: 2,
            to: 1,
          },
        ],
      },
    ],
  },
  {
    name: "idle groups order by latest activity",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 0,
            lastActiveMs: 1000,
          },
          {
            id: "b",
            live: 0,
            lastActiveMs: 5000,
          },
        ],
        order: ["b", "a"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 0,
            lastActiveMs: 1000,
          },
          {
            id: "b",
            live: 0,
            lastActiveMs: 5000,
          },
        ],
        order: ["b", "a"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 0,
            lastActiveMs: 1000,
          },
          {
            id: "b",
            live: 0,
            lastActiveMs: 5000,
          },
        ],
        order: ["b", "a"],
        events: [],
      },
    ],
  },
  {
    name: "new groups enter at their place without an event",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 300,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 100,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 300,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "c",
            live: 200,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "c", "b"],
        events: [],
      },
    ],
  },
  {
    name: "groups that leave are dropped",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 300,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 200,
            lastActiveMs: 0,
          },
          {
            id: "c",
            live: 100,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b", "c"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 300,
            lastActiveMs: 0,
          },
          {
            id: "c",
            live: 100,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "c"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 300,
            lastActiveMs: 0,
          },
          {
            id: "c",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 50,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "c", "b"],
        events: [],
      },
    ],
  },
  {
    name: "near-equal values never flap",
    ticks: [
      {
        groups: [
          {
            id: "a",
            live: 100,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 99,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 99,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 104,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 104,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 99,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 98,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 106,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
      {
        groups: [
          {
            id: "a",
            live: 105,
            lastActiveMs: 0,
          },
          {
            id: "b",
            live: 100,
            lastActiveMs: 0,
          },
        ],
        order: ["a", "b"],
        events: [],
      },
    ],
  },
];
function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    parentId: null,
    lastActivityAt: 1000,
    phase: "generating",
    liveMeasuredTps: 0,
    liveEstimatedTps: 0,
    liveMeasuredTotalTps: 0,
    liveEstimatedTotalTps: 0,
    effortMode: null,
    speedMode: null,
    thinkingTps: null,
    liveCostUsdPerSecond: null,
    ...patch,
  };
}
function perf(
  shown: number | null,
  form: PerformanceValue["form"] = "live",
  n = 10,
): MonitorPerformanceEvaluation {
  return {
    form,
    score: shown,
    shown,
    provisional: shown !== null && n < 10,
    n,
    tools: 0,
    activeMs: n * 1000,
    spanStartMs: 0,
    model: null,
    components:
      shown === null
        ? []
        : [
            {
              id: "T",
              present: true,
              reason: null,
              samples: n,
              measure: shown * 0.05,
              ratio: shown / 1000,
              subScore: shown,
            },
          ],
    baseline: null,
    vsUsual: null,
    vsUsualPercent: null,
  };
}
describe("Agent Speed original board ranking", () => {
  for (const fixture of originalCases)
    it(fixture.name, () => {
      const ranking = model.createRanking();
      for (let tick = 0; tick < fixture.ticks.length; tick++) {
        const expected = fixture.ticks[tick]!,
          result = ranking.tick(expected.groups, "scope", tick);
        expect(result.groups.map((group) => group.id)).toEqual(expected.order);
        expect(result.events).toEqual(expected.events);
      }
    });
  it("does not turn language, resize or readout rerenders into a second engine tick", () => {
    const ranking = model.createRanking();
    ranking.tick(
      [
        { id: "a", live: 100, lastActiveMs: 0 },
        { id: "b", live: 90, lastActiveMs: 0 },
      ],
      "scope",
      0,
    );
    const leading = [
      { id: "a", live: 100, lastActiveMs: 0 },
      { id: "b", live: 130, lastActiveMs: 0 },
    ];
    expect(ranking.tick(leading, "scope", 1).groups.map((group) => group.id)).toEqual(["a", "b"]);
    expect(ranking.tick(leading, "scope", 1).events).toEqual([]);
    expect(ranking.tick(leading, "scope", 2).groups.map((group) => group.id)).toEqual(["b", "a"]);
  });
  it("resets pressure and ranking when the owning orb changes scope", () => {
    const ranking = model.createRanking();
    ranking.tick(
      [
        { id: "a", live: 100, lastActiveMs: 0 },
        { id: "b", live: 90, lastActiveMs: 0 },
      ],
      "first",
      0,
    );
    ranking.tick(
      [
        { id: "a", live: 100, lastActiveMs: 0 },
        { id: "b", live: 130, lastActiveMs: 0 },
      ],
      "first",
      1,
    );
    const result = ranking.tick(
      [
        { id: "a", live: 100, lastActiveMs: 0 },
        { id: "b", live: 101, lastActiveMs: 0 },
      ],
      "second",
      1,
    );
    expect(result.groups.map((group) => group.id)).toEqual(["b", "a"]);
    expect(result.events).toEqual([]);
  });
  it("keeps arbitrary log identifiers separate in pair pressure", () => {
    const ranking = model.createRanking(),
      groups = [
        { id: "a,b", live: 90, lastActiveMs: 0 },
        { id: "a", live: 100, lastActiveMs: 0 },
        { id: "b,c", live: 80, lastActiveMs: 0 },
      ];
    ranking.tick(groups, "scope", 0);
    groups[0]!.live = 130;
    ranking.tick(groups, "scope", 1);
    expect(ranking.tick(groups, "scope", 2).events).toEqual([
      { type: "newLeader", id: "a,b", from: 2, to: 1 },
    ]);
  });
});
describe("board facts from own OMP agent windows", () => {
  it("sums parent and descendant own live windows, never outputTps or child-inclusive totals", () => {
    const agents = [
      agent("root", { liveMeasuredTps: 10, outputTps: 900 }),
      agent("child", { parentId: "root", liveEstimatedTps: 20, outputTps: 800 }),
      agent("grandchild", { parentId: "child", liveMeasuredTps: 5, thinkingTps: 3 }),
    ];
    const [group] = model.groups(agents, null);
    expect(group!.live).toBe(35);
    expect(group!.estimated).toBe(20);
    expect(group!.thinking).toBe(3);
    expect(group!.subs.map((row) => row.id)).toEqual(["child", "grandchild"]);
    expect(model.aggregate(agents, null).live).toBe(35);
  });
  it("uses a missing parent as an independent root, preserving its own descendants", () => {
    const groups = model.groups(
      [
        agent("missing-parent-child", { parentId: "outside-scope" }),
        agent("grandchild", { parentId: "missing-parent-child" }),
        agent("unrelated"),
      ],
      null,
    );
    const memberships: Array<[string, string[]]> = [];
    for (const group of groups)
      memberships.push([group.id, group.members.map((member) => member.id)]);
    expect(memberships).toEqual([
      ["missing-parent-child", ["missing-parent-child", "grandchild"]],
      ["unrelated", ["unrelated"]],
    ]);
  });
  it("terminates malformed parent cycles deterministically without counting anyone twice", () => {
    const groups = model.groups(
      [
        agent("b", { parentId: "a", liveMeasuredTps: 5 }),
        agent("a", { parentId: "b", liveMeasuredTps: 8 }),
        agent("c", { parentId: "b", liveMeasuredTps: 2 }),
      ],
      null,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("a");
    expect(groups[0]!.live).toBe(15);
    expect(groups[0]!.members).toHaveLength(3);
  });
  it("keeps unknown thinking distinct from a recorded real zero", () => {
    expect(model.aggregate([agent("a", { liveMeasuredTps: 20 })], null).thinking).toBeNull();
    expect(
      model.aggregate([agent("a", { liveMeasuredTps: 20, thinkingTps: 0 })], null).thinking,
    ).toBe(0);
    expect(
      model.aggregate([agent("a", { thinkingTps: 0, phase: "tools" })], null).thinking,
    ).toBeNull();
  });
  it("shows unknown live cost when nothing is priced, a lower bound when partially priced, and real free zero", () => {
    const known = agent("known", { liveMeasuredTps: 10, liveCostUsdPerSecond: 0.02 }),
      unknown = agent("unknown", { liveEstimatedTps: 10 });
    expect(model.aggregate([unknown], null).cost).toBeNull();
    expect(model.aggregate([known, unknown], null)).toMatchObject({
      cost: 0.02,
      costPartial: true,
    });
    expect(
      model.aggregate([agent("free", { liveMeasuredTps: 10, liveCostUsdPerSecond: 0 })], null),
    ).toMatchObject({ cost: 0, costPartial: false });
    expect(model.aggregate([], null).cost).toBe(0);
  });
  it("selects the highest live performance before any resting score, without capping or token weighting", () => {
    const agents = [
      agent("resting", { phase: "idle", liveMeasuredTps: 500 }),
      agent("live", { phase: "tools" }),
      agent("second", { liveMeasuredTps: 1 }),
    ];
    const score = model.score(agents, {
      resting: perf(99999, "resting"),
      live: perf(12840, "live", 3),
      second: perf(4000),
    });
    expect(score).toMatchObject({
      value: 12840,
      form: "live",
      count: 2,
      provisional: true,
      n: 3,
    });
    expect(score.agent!.id).toBe("live");
  });
  it("uses the latest native line activity then smallest ordinal id for equal scores, including a real zero", () => {
    const agents = [
      agent("z", { lastActivityAt: 200 }),
      agent("b", { lastActivityAt: 300 }),
      agent("a", { lastActivityAt: 300 }),
    ];
    const scores = { z: perf(0), b: perf(0), a: perf(0) },
      score = model.score(agents, scores);
    expect(score.value).toBe(0);
    expect(score.agent!.id).toBe("a");
    expect(score.count).toBe(3);
    expect(
      model.score(agents, {
        z: perf(1540, "resting"),
        b: perf(null),
        a: perf(null, "none", 0),
      }),
    ).toMatchObject({ value: 1540, form: "resting", count: 1 });
  });
  it("propagates the supplying member’s provisional request count to the whole group", () => {
    const [group] = model.groups([agent("root"), agent("sub", { parentId: "root" })], {
      root: perf(1000),
      sub: perf(1540, "live", 9),
    });
    expect(group!.score).toMatchObject({ value: 1540, provisional: true, n: 9, count: 2 });
    expect(group!.score.agent!.id).toBe("sub");
  });
  it("keeps uncapped resting values and excludes absent display facts from the set count", () => {
    const agents = [agent("wide"), agent("missing")];
    expect(
      model.score(agents, {
        wide: perf(1284000, "resting"),
        missing: perf(null),
      }),
    ).toMatchObject({ value: 1284000, form: "resting", count: 1, provisional: false });
  });
  it("preserves original speed and live money magnitude transitions without an approximation prefix", () => {
    expect([null, 0, 0.03, 9.99, 999.5, 999500].map((value) => model.formatSpeed(value))).toEqual([
      "–",
      "0",
      "0.0",
      "10.0",
      "1.00k",
      "1.00M",
    ]);
    expect(
      [null, 0, 0.0000001, 0.000088, 0.0996, 12.345, 1000].map((value) =>
        model.rateNumber(value, 2),
      ),
    ).toEqual(["–", "0", "<0.000001", "0.000088", "0.10", "12.30", "1,000"]);
    expect(
      [null, 0, 0.000088, 0.0996, 12.345, 1000].map((value) => model.amountNumber(value, 2)),
    ).toEqual(["–", "0.00", "0.000088", "0.10", "12.35", "1,000.00"]);
  });
});
describe("native Windows board layout invariants", () => {
  const styles: OmpMonitorBoardStyle[] = ["glass", "timing", "neon"];
  const sizes: OmpMonitorBoardSize[] = ["small", "medium", "large"];
  const all: Readouts = { showPerformance: true, showThinking: true, showCost: true };
  const none: Readouts = { showPerformance: false, showThinking: false, showCost: false };
  function groups(count: number, children = 0): BoardGroup[] {
    const agents: Agent[] = [];
    for (let index = 0; index < count; index++) {
      const id = "root-" + index;
      agents.push(agent(id, { liveMeasuredTps: 20 }));
      for (let sub = 0; sub < children; sub++)
        agents.push(agent(id + "-" + sub, { parentId: id, liveMeasuredTps: children - sub }));
    }
    return model.groups(agents, null);
  }
  // BoardMetrics.For, DESIGN 2c hero/ranking table; independent of DOM rounding and desktop scale.
  it.each([
    ["glass", "small", 12, 78, 104, 38, 14, 124, 32],
    ["glass", "medium", 14, 86, 116, 38, 14, 172, 38],
    ["glass", "large", 16, 94, 128, 38, 14, 240, 40],
    ["timing", "small", 14, 72, 109, 32, 16, 123, 30],
    ["timing", "medium", 16, 80, 121, 32, 16, 171, 38],
    ["timing", "large", 18, 88, 131, 32, 16, 241, 40],
    ["neon", "small", 12, 92, 108, 36, 14, 122, 32],
    ["neon", "medium", 14, 100, 118, 36, 14, 172, 38],
    ["neon", "large", 16, 108, 128, 36, 14, 242, 40],
  ] as const)(
    "keeps %s/%s canonical bands and whole-row room",
    (style, size, heroTop, hero, listTop, listBottom, startY, room, groupHeight) => {
      expect(model.metrics(style, size, all)).toMatchObject({
        heroTop,
        hero,
        listTop,
        listBottom,
        startY,
        room,
        groupHeight,
      });
    },
  );
  it("restores the original hero when every readout is off, retaining M/L second lines", () => {
    expect(sizes.map((size) => model.metrics("timing", size, none).hero)).toEqual([70, 78, 86]);
    expect(sizes.map((size) => model.metrics("neon", size, none).hero)).toEqual([82, 92, 100]);
    expect(styles.map((style) => model.metrics(style, "medium", none).groupHeight)).toEqual([
      38, 38, 38,
    ]);
    for (const style of styles)
      for (const size of sizes) {
        const withoutPerformance = model.metrics(style, size, { ...all, showPerformance: false });
        expect(withoutPerformance.listTop).toBe(model.metrics(style, size, all).listTop);
        expect(withoutPerformance.startY).toBe(style === "timing" ? 0 : 6);
      }
  });
  it.each(styles.flatMap((style) => sizes.map((size) => [style, size] as const)))(
    "never clips a %s/%s row, scrolls past capacity or lets sub rows displace groups for any switch combination",
    (style, size) => {
      for (let mask = 0; mask < 8; mask++) {
        const readouts = {
          showPerformance: !!(mask & 1),
          showThinking: !!(mask & 2),
          showCost: !!(mask & 4),
        };
        const geometry = model.metrics(style, size, readouts);
        for (let count = 0; count <= 12; count++) {
          const rootsOnly = model.layout(groups(count), style, size, readouts, null);
          const ranked = groups(count, 10);
          for (const expanded of [null, "root-0", "root-2", "outside-scope"]) {
            const plan = model.layout(ranked, style, size, readouts, expanded);
            expect(plan.rows.filter((row) => row.kind === "group")).toHaveLength(
              rootsOnly.rows.filter((row) => row.kind === "group").length,
            );
            let y = geometry.startY;
            for (const row of plan.rows) {
              expect(row.y).toBe(y);
              y += row.height;
              expect(y).toBeLessThanOrEqual(geometry.startY + geometry.room);
            }
            expect(plan.height).toBe(y);
            const rest = plan.rows.find((row) => row.allGroups);
            const shown = plan.rows.filter((row) => row.kind === "group").length;
            if (rest) {
              expect(rest.rest).toBe(count - shown);
              expect(rest.live).toBe(
                ranked.slice(shown).reduce((sum, group) => sum + group.live, 0),
              );
            }
          }
        }
      }
    },
  );
  it("keeps the native team capacities including the timing L child and summary", () => {
    for (const style of styles) {
      expect(
        model.layout(groups(5, 4), style, "small", all, null).rows.map((row) => row.kind),
      ).toEqual(["group", "group", "group", "more"]);
      expect(
        model.layout(groups(5, 4), style, "medium", all, null).rows.map((row) => row.kind),
      ).toEqual(["group", "group", "group", "group", "more"]);
      const large = model.layout(groups(5, 4), style, "large", all, null).rows;
      expect(large.filter((row) => row.kind === "group")).toHaveLength(5);
      expect(large.filter((row) => row.kind === "sub")).toHaveLength(style === "timing" ? 1 : 0);
      expect(large.filter((row) => row.kind === "more")).toHaveLength(style === "timing" ? 1 : 0);
    }
  });
  it("includes a generating child before tokens arrive and expands S only inside its remaining room", () => {
    const ranked = model.groups(
      [
        agent("root", { liveMeasuredTps: 20 }),
        agent("starting", { parentId: "root", phase: "generating" }),
        agent("idle", { parentId: "root", phase: "idle", lastActivityAt: 0 }),
      ],
      null,
    );
    expect(
      model.layout(ranked, "glass", "medium", all, null).rows.find((row) => row.kind === "sub")
        ?.agent?.id,
    ).toBe("starting");
    expect(
      model.layout(ranked, "glass", "small", all, null).rows.some((row) => row.kind === "sub"),
    ).toBe(false);
    const expanded = model.layout(ranked, "glass", "small", all, "root");
    expect(expanded.rows.filter((row) => row.kind === "sub").map((row) => row.agent?.id)).toEqual([
      "starting",
      "idle",
    ]);
    expect(expanded.height).toBeLessThanOrEqual(138);
  });
  it("uses the chosen metric for real group/sub rates and ranking without changing performance", () => {
    const agents = [
      agent("root", { liveMeasuredTps: 10, liveMeasuredTotalTps: 100 }),
      agent("child", { parentId: "root", liveMeasuredTps: 5, liveMeasuredTotalTps: 20 }),
      agent("grandchild", { parentId: "child", liveEstimatedTps: 1, liveEstimatedTotalTps: 60 }),
      agent("other", { liveMeasuredTps: 30, liveMeasuredTotalTps: 40 }),
    ];
    const values = {
      root: perf(1000),
      child: perf(2000),
      grandchild: perf(1200),
      other: perf(1500),
    };
    const output = model.groups(agents, values, "output"),
      total = model.groups(agents, values, "total");
    expect(output[0]?.live).toBe(16);
    expect(total[0]?.live).toBe(180);
    expect(total[0]?.subs.map((sub) => sub.id)).toEqual(["grandchild", "child"]);
    expect(total[0]?.score).toEqual(output[0]?.score);
    const ranking = model.createRanking();
    expect(ranking.tick(output, "output", 1).groups.map((group) => group.id)).toEqual([
      "other",
      "root",
    ]);
    expect(ranking.tick(total, "total", 1).groups.map((group) => group.id)).toEqual([
      "root",
      "other",
    ]);
    expect(model.aggregate(agents, values, "total").estimated).toBe(60);
  });
});

interface BoardRowElement extends HTMLElement {
  boardPerfFacts: string[];
  boardTooltipFacts: string[];
}
interface BoardConsumer {
  paint(score: Score, instant?: boolean): void;
  row(agents: Agent[], values: Record<string, PerformanceValue>): BoardRowElement;
  capsule(agent: Agent, previous?: HTMLElement): HTMLElement;
  rows(agents: Agent[]): HTMLElement[];
  words(score: Score): string;
  panel: HTMLElement;
  title(value: number | null, id: string, source: OmpTitleThemesState): string;
}
function boardConsumer(
  style: OmpMonitorBoardStyle,
  options: Partial<OmpMonitorBoardPreferences> & {
    appearance?: "dark" | "light";
    language?: "en" | "zh";
  } = {},
) {
  document.body.innerHTML = MONITOR_BOARD_MARKUP + MONITOR_PERF_MARKUP;
  vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false }));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "Path2D",
    class {
      readonly data: string;
      constructor(data: string) {
        this.data = data;
      }
    },
  );
  let now = 0;
  let serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const code = `
    let language=${JSON.stringify(options.language ?? "en")},appearance=${JSON.stringify(options.appearance ?? "dark")};
    const view={surface:'board',preferences:{effects:'standard',metric:'output',celebratePeaks:true,titleTheme:'vehicles',redline:2000},board:${JSON.stringify({ ...DEFAULT_BOARD_PREFERENCES, ...options, style, id: "board", orbId: "orb" })},orbs:[],snapshot:null,titleThemes:null};
    const node=id=>document.getElementById(id),snapshotFacts=()=>view.snapshot;
    const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
    const timestamp=value=>String(value),number=(value,digits)=>value.toFixed(digits);
    ${MONITOR_VISUALS_SCRIPT}
    ${MONITOR_TITLE_THEMES_SCRIPT}
    const boardEffects={create:()=>({setVisible(){},destroy(){}})};
    ${MONITOR_PERF_SCRIPT}
    ${MONITOR_BOARD_MODEL_SCRIPT}
    ${MONITOR_BOARD_RENDERER_SCRIPT}
    boardCreatePanel(null);
    return {
      panel:boardState.panel,
      paint:boardPaintScore,
      words:boardScoreWords,
      capsule:boardCapsule,
      title(value,id,source){view.preferences.titleTheme=id;view.titleThemes=source;return boardTrackedTitle(value);},
      rows(agents){
        const values={};view.snapshot={agents,performance:{current:values,records:[],baselines:[],scanning:false,limited:false}};boardState.latest=view.snapshot;boardState.liveKnown=true;
        boardRenderRows(boardModel.groups(agents,values),boardModel.aggregate(agents,values),[],true);
        return [...boardState.panel.querySelectorAll('.item .row')];
      },
      row(agents,values){
        view.snapshot={agents,performance:{current:values,records:[],baselines:[],scanning:false,limited:false}};
        boardState.latest=view.snapshot;boardState.liveKnown=true;
        const group=boardModel.groups(agents,values)[0],record=boardCreateRow('group',group.id);
        boardPaintRow(record,{kind:'group',group},boardModel.aggregate(agents,values),1,null,true);
        return record.row;
      }
    };
  `;
  const consumer = new Function(
    "document",
    "window",
    "performance",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "AbortController",
    code,
  )(
    document,
    window,
    { now: () => now },
    (callback: FrameRequestCallback) => {
      const id = ++serial;
      frames.set(id, callback);
      return id;
    },
    (id: number) => frames.delete(id),
    window.AbortController,
  ) as BoardConsumer;
  return {
    consumer,
    advance(ms: number) {
      now += ms;
      const pending = Array.from(frames.values());
      frames.clear();
      for (const callback of pending) callback(now);
    },
    pending: () => frames.size,
  };
}
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("board performance renderer consumer boundaries", () => {
  it.each(
    (["glass", "timing", "neon"] as const).flatMap((style) =>
      (["en", "zh"] as const).map((language) => [style, language] as const),
    ),
  )(
    "labels omitted %s groups and their combined speed in %s, not executing agents",
    (style, language) => {
      const { consumer } = boardConsumer(style, {
        language,
        size: "small",
        showPerformance: true,
        showThinking: true,
        showCost: true,
      });
      const roots = Array.from({ length: 6 }, (_, index) =>
        agent(`root-${index}`, { phase: "idle" }),
      );
      roots[4]!.phase = "tools";
      roots[5]!.phase = "generating";
      roots[5]!.liveMeasuredTps = 7;
      const members = [
        ...roots,
        agent("child", { parentId: "root-4", phase: "tools", liveMeasuredTps: 12 }),
        agent("grandchild", { parentId: "child", phase: "idle" }),
      ];
      consumer.rows(members);
      expect(consumer.panel.querySelectorAll(".item.group")).toHaveLength(3);
      expect(consumer.panel.querySelectorAll(".item.more")).toHaveLength(1);
      const summary = consumer.panel.querySelector(".item.more .row")!;
      const label =
        language === "zh" ? "还有 3 个近期分组 · 19 tok/s" : "3 more recent groups · 19 tok/s";
      expect(summary.querySelector(".label")!.textContent).toBe(label);
      expect(summary.getAttribute("aria-label")).toBe(label);
      for (const member of members) {
        member.phase = "idle";
        member.liveMeasuredTps = 0;
      }
      consumer.rows(members);
      expect(consumer.panel.querySelectorAll(".item.group")).toHaveLength(3);
      expect(summary.querySelector(".label")!.textContent).toBe(
        language === "zh" ? "还有 3 个近期分组 · 0 tok/s" : "3 more recent groups · 0 tok/s",
      );
    },
  );
  it("renders a custom theme's idle and tracked labels and picks up edits without losing its tier", () => {
    const page = boardConsumer("glass"),
      id = "custom:00000000-0000-4000-8000-000000000052";
    const titles: Array<string | null> = Array(13).fill(null);
    titles[1] = "原版称号";
    const source: OmpTitleThemesState = {
      version: 1,
      revision: 1,
      custom: [{ id, name: "Owned theme", base: "vehicles", idle: "自定义待机", titles }],
      draft: null,
      undo: null,
      error: false,
    };
    expect(page.consumer.title(52, id, source)).toBe("自定义待机");
    page.advance(801);
    expect(page.consumer.title(52, id, source)).toBe("原版称号");
    titles[1] = "更新称号";
    expect(page.consumer.title(52, id, source)).toBe("更新称号");
    page.consumer.title(null, id, source);
  });
  it.each([
    ["glass", "12.8k"],
    ["timing", "12,840"],
    ["neon", "12,840"],
  ] as const)(
    "formats the uncapped %s hero and carries the supplier and provisional sample count",
    (style, text) => {
      const { consumer } = boardConsumer(style);
      const value = model.score([agent("winner"), agent("resting")], {
        winner: perf(12840, "live", 7),
        resting: perf(99999, "resting"),
      });
      consumer.paint(value, true);
      expect(
        consumer.panel.querySelector('[data-board-metric="performance"] .mn')!.textContent,
      ).toBe(text);
      const anchor = consumer.panel.querySelector<HTMLElement>("[data-perf-agent-id]")!;
      expect(anchor.dataset.perfAgentId).toBe("winner");
      expect(anchor.dataset.perfSetCount).toBe("1");
      expect(consumer.words(value)).toContain("12,840");
      expect(consumer.words(value)).toContain("7 timed requests");
      expect(
        consumer.panel.querySelector(".board-perf-value")!.classList.contains("board-provisional"),
      ).toBe(true);
    },
  );
  it("uses the reference log scale for glass, not a 0–100 gauge", () => {
    const { consumer } = boardConsumer("glass");
    consumer.paint(model.score([agent("a")], { a: perf(1000) }), true);
    expect(consumer.panel.querySelector(".arc")!.getAttribute("stroke-dashoffset")).toBe("50");
    consumer.paint(model.score([agent("a")], { a: perf(4000) }), true);
    expect(consumer.panel.querySelector(".arc")!.getAttribute("stroke-dashoffset")).toBe("0");
    consumer.paint(model.score([agent("a")], { a: perf(1284000, "resting", 9) }), true);
    expect(consumer.panel.querySelector(".board-perf-value")!.textContent).toBe("1.28M");
    expect(consumer.panel.querySelector(".gauge")!.classList.contains("board-resting")).toBe(true);
    expect(consumer.panel.querySelector(".arc")!.getAttribute("stroke-dasharray")).toBe("0 6");
  });
  it("lights six neon segments at 1000 and keeps the number rising after all twelve are lit", () => {
    const { consumer } = boardConsumer("neon");
    consumer.paint(model.score([agent("a")], { a: perf(1000) }), true);
    expect(consumer.panel.querySelectorAll(".segs .on")).toHaveLength(6);
    consumer.paint(model.score([agent("a")], { a: perf(12840) }), true);
    expect(consumer.panel.querySelectorAll(".segs .on")).toHaveLength(12);
    expect(consumer.panel.querySelector(".board-perf-value")!.textContent).toBe("12,840");
  });
  it("counts calmly in both directions and retargets from the number currently on screen", () => {
    const page = boardConsumer("timing");
    page.consumer.paint(model.score([agent("a")], { a: perf(1000) }), true);
    page.consumer.paint(model.score([agent("a")], { a: perf(2000) }));
    expect(page.pending()).toBe(1);
    page.advance(325);
    expect(page.consumer.panel.querySelector(".board-perf-value")!.textContent).toBe("1,875");
    page.consumer.paint(model.score([agent("a")], { a: perf(1000) }));
    page.advance(700);
    expect(page.consumer.panel.querySelector(".board-perf-value")!.textContent).toBe("1,000");
    expect(page.pending()).toBe(0);
  });
  it("uses the real score-cell consumer for group rows and names the child supplying the performance", () => {
    const { consumer } = boardConsumer("glass");
    const row = consumer.row(
      [
        agent("root", {
          project: "root-project",
          model: "root-model",
          liveMeasuredTps: 10,
          effortMode: { value: "low", evidence: "recorded", provider: null },
        }),
        agent("child", {
          parentId: "root",
          project: "child-project",
          model: "child-model",
          liveMeasuredTps: 10,
          effortMode: { value: "max", evidence: "recorded", provider: null },
        }),
      ],
      { root: perf(1000), child: perf(12840, "live", 8) },
    );
    expect(row.querySelector(".perf-score-value")!.textContent).toBe("12.8k");
    expect(row.tabIndex).toBe(0);
    const description = document.getElementById(
      row.getAttribute("aria-describedby")!,
    )!.textContent!;
    expect(description).toContain("child-project");
    expect(description).toContain("Speed 20 tok/s (sub-agents 10)");
    expect(row.getAttribute("aria-label")).toContain("low");
    expect(row.getAttribute("aria-label")).not.toContain("max");
  });
  it("keeps a real zero distinct from no score and removes a departed supplier anchor", () => {
    const { consumer } = boardConsumer("neon");
    consumer.paint(model.score([agent("zero")], { zero: perf(0) }), true);
    expect(consumer.panel.querySelector(".board-perf-value")!.textContent).toBe("0");
    expect(
      consumer.panel.querySelector<HTMLElement>("[data-perf-agent-id]")!.dataset.perfAgentId,
    ).toBe("zero");
    consumer.paint(model.score([], null), true);
    expect(consumer.panel.querySelector(".board-perf-value")!.textContent).toBe("–");
    expect(consumer.panel.querySelector("[data-perf-agent-id]")).toBeNull();
    expect(consumer.panel.querySelectorAll(".segs .on")).toHaveLength(0);
  });
});

describe("native board execution-mode capsules", () => {
  it.each(["glass", "timing", "neon"] as const)(
    "renders real meters and both speed tiers in %s at every size/appearance",
    (style) => {
      for (const size of ["small", "medium", "large"] as const)
        for (const appearance of ["dark", "light"] as const) {
          const { consumer } = boardConsumer(style, { size, appearance });
          const capsule = consumer.capsule(
            agent("a", {
              effortMode: { value: "ultracode", evidence: "selected", provider: null },
              speedMode: { value: "ultrafast", evidence: "recorded", provider: "priority" },
            }),
          );
          expect(capsule.classList.contains("top")).toBe(true);
          expect(capsule.classList.contains("configured")).toBe(false);
          expect(capsule.querySelectorAll(".meter i.on")).toHaveLength(5);
          expect(capsule.querySelectorAll(".bolts svg")).toHaveLength(2);
          expect(capsule.querySelector(".word")?.textContent).toBe("ultracode");
          expect(capsule.title).toContain("priority");
          expect(capsule.title.toLowerCase()).toContain("selected");
          expect(consumer.panel.dataset.size).toBe({ small: "S", medium: "M", large: "L" }[size]);
        }
    },
  );
  it("keeps off, an unsupported known effort, standard speed and unknown distinct", () => {
    const { consumer } = boardConsumer("glass", { size: "small" });
    const off = consumer.capsule(
      agent("off", { effortMode: { value: "off", evidence: "recorded", provider: null } }),
    );
    expect(off.classList.contains("none")).toBe(false);
    expect(off.querySelectorAll(".meter i")).toHaveLength(5);
    expect(off.querySelectorAll(".meter i.on")).toHaveLength(0);
    const future = consumer.capsule(
      agent("future", {
        effortMode: { value: "future-effort", evidence: "recorded", provider: null },
      }),
    );
    expect(future.classList.contains("no-meter")).toBe(true);
    expect(future.classList.contains("word-only")).toBe(true);
    expect(future.querySelector(".word")?.textContent).toBe("future-effort");
    for (const speedMode of [
      null,
      { value: "standard", evidence: "selected" as const, provider: null },
    ]) {
      const unknown = consumer.capsule(agent("unknown", { speedMode }));
      expect(unknown.classList.contains("none")).toBe(true);
      expect(unknown.querySelectorAll(".meter i.on,.bolts svg")).toHaveLength(0);
    }
  });
  it("preserves the meter nodes across changes and makes only literal configured facts dashed", () => {
    const { consumer } = boardConsumer("neon");
    const capsule = consumer.capsule(
      agent("a", {
        effortMode: { value: "max", evidence: "configured", provider: null },
        speedMode: { value: "fast", evidence: "configured", provider: null },
      }),
    );
    const bars = Array.from(capsule.querySelectorAll(".meter i"));
    expect(capsule.classList.contains("configured")).toBe(true);
    expect(capsule.classList.contains("max")).toBe(false);
    expect(capsule.querySelector(".mode-mark")?.textContent).toBe("config");
    consumer.capsule(
      agent("a", {
        effortMode: { value: "high", evidence: "selected", provider: null },
        speedMode: { value: "highspeed", evidence: "recorded", provider: null },
      }),
      capsule,
    );
    expect(Array.from(capsule.querySelectorAll(".meter i"))).toEqual(bars);
    expect(capsule.querySelectorAll(".meter i.on")).toHaveLength(3);
    expect(capsule.querySelectorAll(".bolts svg")).toHaveLength(1);
    expect(capsule.classList.contains("configured")).toBe(false);
    expect(capsule.querySelector(".mode-mark")?.textContent).toBe("");
  });
  it("keeps overflow informational without a show-all action", () => {
    const { consumer } = boardConsumer("timing", { size: "small" });
    const rows = consumer.rows(
      Array.from({ length: 5 }, (_, index) => agent("root-" + index, { liveMeasuredTps: 10 })),
    );
    expect(rows).toHaveLength(4);
    const summary = rows[3]!;
    expect(summary.tabIndex).toBe(-1);
    expect(summary.dataset.boardMore).toBeUndefined();
    expect(consumer.panel.querySelectorAll(".fastest")).toHaveLength(1);
  });
});

interface BoardBloomCanvasContext {
  image(): ImageData | null;
  createImageData(width: number, height: number): ImageData;
  putImageData(image: ImageData): void;
}
function boardBloomConsumer(style: OmpMonitorBoardStyle, side: number, scale: number) {
  const panel = document.createElement("section");
  document.body.append(panel);
  let currentSide = side,
    now = 0,
    serial = 0,
    notifyResize = () => {};
  const frames = new Map<number, FrameRequestCallback>(),
    disconnected = vi.fn();
  vi.spyOn(panel, "getBoundingClientRect").mockImplementation(function () {
    const value = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: currentSide,
      bottom: currentSide,
      width: currentSide,
      height: currentSide,
    };
    return { ...value, toJSON: () => value };
  });
  vi.stubGlobal("devicePixelRatio", scale);
  vi.stubGlobal(
    "Path2D",
    class {
      roundRect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notifyResize = callback;
      }
      observe() {}
      disconnect = disconnected;
    },
  );
  function canvasContext() {
    let framebuffer: ImageData | null = null;
    const draw = () => {};
    return {
      image: () => framebuffer,
      createImageData: vi.fn(
        (width: number, height: number) =>
          ({
            width,
            height,
            data: new Uint8ClampedArray(width * height * 4),
          }) as ImageData,
      ),
      putImageData: vi.fn((next: ImageData) => {
        framebuffer = next;
      }),
      setTransform: draw,
      clearRect: draw,
      save: draw,
      restore: draw,
      translate: draw,
      setLineDash: draw,
      stroke: draw,
      beginPath: draw,
      moveTo: draw,
      lineTo: draw,
      arc: draw,
      roundRect: draw,
      clip: draw,
    };
  }
  const contexts = new Map<HTMLCanvasElement, BoardBloomCanvasContext>();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(function (this: HTMLCanvasElement) {
      let context = contexts.get(this);
      if (!context) {
        context = canvasContext();
        contexts.set(this, context);
      }
      return context as unknown as CanvasRenderingContext2D;
    });
  const factory = new Function(
    "document",
    "window",
    "performance",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    MONITOR_BOARD_EFFECTS_SCRIPT + "\nreturn boardEffects;",
  )(
    document,
    window,
    { now: () => now },
    (callback: FrameRequestCallback) => {
      frames.set(++serial, callback);
      return serial;
    },
    (id: number) => frames.delete(id),
  ) as {
    create(
      panel: HTMLElement,
      style: string,
    ): {
      update(frame: Record<string, unknown>): void;
      setVisible(value: boolean): void;
      destroy(): void;
    };
  };
  const effects = factory.create(panel, style),
    bloom = panel.querySelector<HTMLCanvasElement>(".board-bloom")!;
  const context = contexts.get(bloom)!;
  const frame = {
    heat: 1,
    overdrive: 0,
    active: false,
    reduced: true,
    contrast: false,
    intensity: 0,
    maxFps: 60,
    color: "rgba(124,135,152,1)",
    bloomColor: "rgba(250,204,21,1)",
    headColor: "rgba(255,247,214,1)",
    tailColor: "rgba(250,204,21,1)",
    starColors: [],
  };
  function update(patch: Partial<typeof frame> = {}) {
    Object.assign(frame, patch);
    effects.update(frame);
  }
  function image() {
    const value = context.image();
    if (!value) throw new Error("The visible board bloom has no painted pixels");
    return value;
  }
  function pixel(x: number, y: number) {
    const value = image(),
      offset = (y * value.width + x) * 4;
    return Array.from(value.data.subarray(offset, offset + 4));
  }
  update();
  effects.setVisible(true);
  return {
    effects,
    bloom,
    context,
    getContext,
    disconnected,
    update,
    image,
    pixel,
    visibleAlpha: (x: number, y: number) => (bloom.hidden ? 0 : pixel(x, y)[3]),
    pending: () => frames.size,
    resize(nextSide = currentSide, nextScale = scale) {
      currentSide = nextSide;
      scale = nextScale;
      vi.stubGlobal("devicePixelRatio", scale);
      notifyResize();
    },
    advance(ms: number) {
      now += ms;
      const pending = Array.from(frames.values());
      frames.clear();
      for (const callback of pending) callback(now);
    },
  };
}
function outerBloomAlpha(image: ImageData, margin: number) {
  let maximum = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      if (x < margin || y < margin || x >= image.width - margin || y >= image.height - margin) {
        maximum = Math.max(maximum, image.data[(y * image.width + x) * 4 + 3]!);
      }
    }
  return maximum;
}
describe("original Windows board exterior bloom", () => {
  it("matches native rounded Gaussian/fade alpha samples and preserves straight heat color", () => {
    const page = boardBloomConsumer("glass", 340, 2);
    // Frozen native BoardComets/OrbShapes/OrbCommon at heat=1, overdrive=0,
    // scale=2: no offset shadow; these are pixel-center samples outside x=80.
    for (const [x, alpha] of [
      [79, 77],
      [60, 66],
      [40, 35],
      [20, 7],
      [12, 2],
    ]) {
      expect(page.pixel(x!, 420)).toEqual([250, 204, 21, alpha]);
    }
    expect(page.pixel(420, 420)).toEqual([0, 0, 0, 0]);
    expect(page.pixel(0, 420)).toEqual([0, 0, 0, 0]);
    expect(page.pixel(79, 79)[3]).toBeGreaterThan(0);
    expect(page.pixel(79, 79)[3]).toBeLessThan(page.pixel(79, 420)[3]!);
    expect(outerBloomAlpha(page.image(), 4)).toBe(0);
    page.effects.destroy();
  });
  it.each([
    ["glass", 280, 1],
    ["timing", 340, 1.25],
    ["neon", 420, 2],
  ] as const)(
    "keeps %s bloom rounded, symmetric and clear of the window edge at maximum drive",
    (style, side, scale) => {
      const page = boardBloomConsumer(style, side, scale);
      page.update({ overdrive: 1 });
      const image = page.image(),
        center = Math.floor(image.width / 2),
        near = Math.floor(35 * scale);
      const alpha = page.pixel(near, center)[3]!;
      expect(alpha).toBeGreaterThan(0);
      expect(page.pixel(image.width - 1 - near, center)[3]).toBe(alpha);
      expect(page.pixel(center, near)[3]).toBe(alpha);
      expect(page.pixel(center, image.height - 1 - near)[3]).toBe(alpha);
      expect(page.pixel(near, near)[3]).toBeLessThan(alpha);
      expect(page.pixel(center, center)).toEqual([0, 0, 0, 0]);
      expect(outerBloomAlpha(image, Math.floor(2 * scale))).toBe(0);
      page.effects.destroy();
    },
  );
  it("retains static bloom across off/reduced/idle, suspends hidden work and never resurrects disposed buffers", () => {
    const page = boardBloomConsumer("glass", 340, 1),
      original = page.image();
    expect(page.context.putImageData).toHaveBeenCalledTimes(1);
    expect(page.context.createImageData).toHaveBeenCalledTimes(1);
    expect(page.getContext).toHaveBeenCalledTimes(2);
    page.update({ active: true, reduced: false, intensity: 2 });
    page.advance(34);
    page.advance(34);
    expect(page.context.putImageData).toHaveBeenCalledTimes(1);
    page.update({ active: false, reduced: true, intensity: 0 });
    expect(page.pending()).toBe(0);
    expect(page.visibleAlpha(39, 210)).toBe(77);
    page.resize();
    expect(page.image()).toBe(original);
    expect(page.context.createImageData).toHaveBeenCalledTimes(1);
    expect(page.context.putImageData).toHaveBeenCalledTimes(1);
    page.effects.setVisible(false);
    page.update({ heat: 0.2, bloomColor: "rgba(45,212,191,1)" });
    expect(page.visibleAlpha(39, 210)).toBe(0);
    expect(page.context.putImageData).toHaveBeenCalledTimes(1);
    page.effects.setVisible(true);
    expect(page.image()).toBe(original);
    expect(page.pixel(39, 210)).toEqual([45, 212, 191, 77]);
    expect(page.context.putImageData).toHaveBeenCalledTimes(2);
    page.update({ contrast: true });
    expect(page.visibleAlpha(39, 210)).toBe(0);
    page.update({ contrast: false });
    expect(page.visibleAlpha(39, 210)).toBe(77);
    expect(page.context.putImageData).toHaveBeenCalledTimes(2);
    page.resize(280, 1.5);
    expect([page.image().width, page.image().height]).toEqual([540, 540]);
    expect(outerBloomAlpha(page.image(), 3)).toBe(0);
    page.resize();
    expect(page.context.createImageData).toHaveBeenCalledTimes(2);
    expect(page.context.putImageData).toHaveBeenCalledTimes(3);
    expect(page.getContext).toHaveBeenCalledTimes(2);
    page.effects.destroy();
    expect(page.disconnected).toHaveBeenCalledTimes(1);
    expect(page.bloom.isConnected).toBe(false);
    expect([page.bloom.width, page.bloom.height]).toEqual([0, 0]);
    page.update({ heat: 1, reduced: false, intensity: 2, active: true });
    page.effects.setVisible(true);
    page.resize(420, 2);
    page.advance(34);
    expect(page.pending()).toBe(0);
    expect(page.bloom.hidden).toBe(true);
    expect([page.bloom.width, page.bloom.height]).toEqual([0, 0]);
    expect(page.context.createImageData).toHaveBeenCalledTimes(2);
    expect(page.context.putImageData).toHaveBeenCalledTimes(3);
    expect(page.getContext).toHaveBeenCalledTimes(2);
  });
});

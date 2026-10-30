/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MONITOR_BOARD_MODEL_SCRIPT } from "./board-model.js";
import { MONITOR_BOARD_MARKUP } from "./board-ui.js";
import { MONITOR_BOARD_RENDERER_SCRIPT } from "./board-renderer.js";
import { MONITOR_PERF_SCRIPT } from "./performance-ui.js";
import { DEFAULT_BOARD_PREFERENCES } from "./board-types.js";

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
interface Agent {
  id: string;
  parentId: string | null;
  lastActivityAt: number;
  phase: "idle" | "tools" | "generating";
  liveMeasuredTps: number;
  liveEstimatedTps: number;
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
interface BoardModel {
  createRanking(): {
    tick(
      groups: RankGroup[],
      scope: string,
      tick: number,
    ): { groups: RankGroup[]; events: RankEvent[] };
    reset(): void;
  };
  groups(
    agents: Agent[],
    values: Record<string, PerformanceValue> | null,
  ): Array<Aggregate & { id: string; root: Agent; members: Agent[]; subs: Agent[] }>;
  aggregate(agents: Agent[], values: Record<string, PerformanceValue> | null): Aggregate;
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
    thinkingTps: null,
    liveCostUsdPerSecond: null,
    ...patch,
  };
}
function perf(
  shown: number | null,
  form: PerformanceValue["form"] = "live",
  n = 10,
): PerformanceValue {
  return { form, score: shown, shown, provisional: shown !== null && n < 10, n };
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

interface BoardConsumer {
  paint(score: Score, instant?: boolean): void;
  row(agents: Agent[], values: Record<string, PerformanceValue>): HTMLElement;
  words(score: Score): string;
  panel: HTMLElement;
}
function boardConsumer(style: "glass" | "timing" | "neon") {
  document.body.innerHTML = MONITOR_BOARD_MARKUP;
  vi.stubGlobal("matchMedia", (media: string) => ({ media, matches: false }));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  let now = 0;
  let serial = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const code = `
    let language='en',appearance='dark';
    const view={surface:'board',preferences:{effects:'standard'},board:${JSON.stringify({ ...DEFAULT_BOARD_PREFERENCES, style, id: "board", orbId: "orb" })},orbs:[],snapshot:null};
    const node=id=>document.getElementById(id),snapshotFacts=()=>view.snapshot;
    const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
    const timestamp=value=>String(value),number=(value,digits)=>value.toFixed(digits);
    const agentSpeedVisuals={heat:()=>0,color:()=>''};
    const boardEffects={create:()=>({setVisible(){},destroy(){}})};
    ${MONITOR_PERF_SCRIPT}
    ${MONITOR_BOARD_MODEL_SCRIPT}
    ${MONITOR_BOARD_RENDERER_SCRIPT}
    boardCreatePanel(null);
    return {
      panel:boardState.panel,
      paint:boardPaintScore,
      words:boardScoreWords,
      row(agents,values){
        view.snapshot={agents,performance:{current:values,records:[],baselines:[],scanning:false,limited:false}};
        boardState.latest=view.snapshot;
        const group=boardModel.groups(agents,values)[0],record=boardCreateRow('group',group.id);
        boardPaintRow(record,{kind:'group',group},boardModel.aggregate(agents,values),1,null);
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
    const row = consumer.row([agent("root"), agent("child", { parentId: "root" })], {
      root: perf(1000),
      child: perf(12840, "live", 8),
    });
    expect(row.dataset.perfAgentId).toBe("child");
    expect(row.dataset.perfSetCount).toBe("2");
    expect(row.querySelector(".perf-score-value")!.textContent).toBe("12.8k");
    expect(row.querySelector(".perf-score-value")!.classList.contains("perf-pm")).toBe(true);
    expect(row.querySelector<HTMLElement>(".perf-score-cell")!.dataset.perfCardHost).toBe("board");
    expect(row.tabIndex).toBe(0);
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

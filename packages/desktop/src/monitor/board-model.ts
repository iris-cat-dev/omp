// Agent Speed v1.6.0, MIT, ca460d7f899e7adc73391ea706b729f1fc481fde.
// Ranking: spec/tools/board_ranking.py. Performance: METRICS 6.9, highest live before resting.
// A static browser module, also exercised by behavioral fixtures without a DOM or provider.
import { highestPerformanceValue } from "./performance.js";

export const MONITOR_BOARD_MODEL_SCRIPT = String.raw`
const boardModel = (() => {
  const highest = ${highestPerformanceValue.toString()};
  const emptyValues = Object.create(null);
  function numeric(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
  function rate(agent) { return (numeric(agent.liveMeasuredTps) || 0) + (numeric(agent.liveEstimatedTps) || 0); }
  function activity(agent) { return numeric(agent.lastActivityAt) || 0; }
  function score(agents, values) {
    const highestValue = highest(agents, values || emptyValues), supplier = agents.find(agent => agent.id === highestValue.agent) || null;
    if (highestValue.shown === null) return { agent: null, value: null, form: 'none', count: 0, provisional: false, n: 0 };
    let count = 0;
    for (const agent of agents) {
      const value = values && values[agent.id];
      if (value && numeric(value.shown) !== null && value.form === highestValue.form) count++;
    }
    const evaluation = supplier && values[supplier.id];
    return { agent: supplier, value: highestValue.shown, form: highestValue.form, count, provisional: !!(evaluation && evaluation.provisional), n: evaluation ? evaluation.n : 0 };
  }
  function aggregate(agents, values) {
    let live = 0, estimated = 0, thinking = 0, thinkingKnown = false, cost = 0, priced = 0, unknown = 0, generating = 0, tools = 0, lastActiveMs = 0;
    for (const agent of agents) {
      const own = rate(agent); live += own; estimated += numeric(agent.liveEstimatedTps) || 0;
      const thought = numeric(agent.thinkingTps); if (thought !== null) { thinking += thought; thinkingKnown = true; }
      const amount = numeric(agent.liveCostUsdPerSecond);
      if (amount !== null) { cost += amount; priced += own; }
      else if (own > 0) unknown += own;
      if (agent.phase === 'generating') generating++; else if (agent.phase === 'tools') tools++;
      lastActiveMs = Math.max(lastActiveMs, activity(agent));
    }
    return { live, estimated, thinking: live > 0 && thinkingKnown ? thinking : null,
      cost: live > 0 && priced === 0 && unknown > 0 ? null : cost,
      costPartial: cost > 0 && unknown > 0 && (priced + unknown === 0 || priced / (priced + unknown) < .995),
      generating, tools, lastActiveMs, score: score(agents, values) };
  }
  function groups(agents, values) {
    const byId = new Map(agents.map(agent => [agent.id, agent])), roots = new Map(), grouped = new Map();
    function rootFor(agent) {
      if (roots.has(agent.id)) return roots.get(agent.id);
      const chain = [], seen = new Map(); let current = agent, root;
      while (true) {
        if (roots.has(current.id)) { root = roots.get(current.id); break; }
        if (seen.has(current.id)) { root = chain.slice(seen.get(current.id)).sort()[0]; break; }
        seen.set(current.id, chain.length); chain.push(current.id);
        const parent = current.parentId && byId.get(current.parentId);
        if (!parent) { root = current.id; break; }
        current = parent;
      }
      for (const id of chain) roots.set(id, root); return root;
    }
    for (const agent of byId.values()) {
      const root = rootFor(agent); let members = grouped.get(root);
      if (!members) { members = []; grouped.set(root, members); } members.push(agent);
    }
    const result = [];
    for (const [id, members] of grouped) {
      const root = byId.get(id), subs = members.filter(agent => agent.id !== id);
      subs.sort((a, b) => rate(b) - rate(a) || activity(b) - activity(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      result.push({ id, root, members, subs, ...aggregate(members, values) });
    }
    return result;
  }
  function createRanking() {
    let order = [], previousTick = new Map(), scope = null, lastTick = null;
    function leads(a, b) {
      return a.live < .05 && b.live < .05 ? a.lastActiveMs > b.lastActiveMs + 1000 : a.live > b.live * 1.1 + 1;
    }
    return {
      reset() { order = []; previousTick.clear(); scope = null; lastTick = null; },
      tick(groups, scopeKey, tick) {
        if (scopeKey !== scope) { order = []; previousTick.clear(); lastTick = null; scope = scopeKey; }
        const byId = new Map(groups.map(group => [group.id, group]));
        if (tick === lastTick) return { groups: order.map(id => byId.get(id)).filter(Boolean), events: [] };
        lastTick = tick;
        const challengers = [...groups].sort((a, b) => b.live - a.live || b.lastActiveMs - a.lastActiveMs || (a.id < b.id ? -1 : 1));
        // Two ticks need only the prior tick's numeric facts, not an O(groups²) table of pair counters.
        // leads(current) && leads(previous) is exactly reference pressure >= 2 for every possible pair.
        const previous = new Set(order); order = order.filter(id => byId.has(id));
        for (const group of challengers) if (!previous.has(group.id)) {
          const index = order.findIndex(id => byId.get(id).live < group.live);
          order.splice(index < 0 ? order.length : index, 0, group.id);
        }
        const baseline = new Map(order.map((id, index) => [id, index + 1]));
        for (let i = 1; i < order.length; i++) {
          let j = i;
          while (j > 0) {
            const a = byId.get(order[j]), b = byId.get(order[j - 1]);
            const priorA = previousTick.get(a.id), priorB = previousTick.get(b.id);
            const held = priorA && priorB && leads(a, b) && leads(priorA, priorB);
            if (!held && !(a.live > b.live * 2 + 20)) break;
            order[j - 1] = a.id; order[j] = b.id; j--;
          }
        }
        const events = [];
        for (let index = 0; index < order.length; index++) {
          const id = order[index], to = index + 1, from = baseline.get(id);
          if (to < from) events.push({ type: to === 1 ? 'newLeader' : 'overtake', id, from, to });
        }
        previousTick = new Map(groups.map(group => [group.id, { live: group.live, lastActiveMs: group.lastActiveMs }]));
        return { groups: order.map(id => byId.get(id)), events };
      }
    };
  }
  function formatSpeed(value) {
    if (value === null || !Number.isFinite(value)) return '–';
    if (!(value > 0)) return '0';
    if (value < 10) return value.toFixed(1);
    if (value < 999.5) return String(Math.round(value));
    const units = [[1e3, 'k'], [1e6, 'M'], [1e9, 'B']];
    for (let i = 0; i < units.length; i++) {
      const scale = units[i][0], suffix = units[i][1], x = value / scale;
      const text = x.toFixed(x < 9.995 ? 2 : x < 99.95 ? 1 : 0);
      if (parseFloat(text) < 1000 || i === units.length - 1) return text + suffix;
    }
    return String(value);
  }
  function significant(value, digits, decimals) {
    let magnitude = Math.floor(Math.log10(value)), places = Math.min(decimals, Math.max(0, digits - 1 - magnitude));
    let text = (Math.round(value * Math.pow(10, places) + 1e-9) / Math.pow(10, places)).toFixed(places);
    if (parseFloat(text) >= Math.pow(10, magnitude + 1)) { magnitude++; places = Math.min(decimals, Math.max(0, digits - 1 - magnitude)); text = parseFloat(text).toFixed(places); }
    return text;
  }
  function trimNumber(text, digits) {
    let [whole, fraction = ''] = text.split('.');
    while (fraction.length > digits && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
    while (fraction.length < digits) fraction += '0';
    return fraction ? whole + '.' + fraction : whole;
  }
  function rateNumber(value, digits) {
    if (value === null || !Number.isFinite(value)) return '–';
    if (value === 0) return '0';
    if (value < 5e-7) return '<0.000001';
    if (value < 1) { const text = significant(value, 2, 6); if (parseFloat(text) < 1) return trimNumber(text, digits); value = parseFloat(text); }
    if (value < 100) { const text = significant(value, 3, 6); if (parseFloat(text) < 100) return trimNumber(text, digits); value = parseFloat(text); }
    return value < 999999.5 ? String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : formatSpeed(value);
  }
  function amountNumber(value, digits) {
    if (value === null || !Number.isFinite(value)) return '–';
    if (value === 0) return (0).toFixed(digits);
    if (value < 5e-7) return '<0.000001';
    if (value < 1) { const text = significant(value, 2, 6); if (parseFloat(text) < 1) return trimNumber(text, digits); value = parseFloat(text); }
    const fixed = (Math.round(value * Math.pow(10, digits) + 1e-9) / Math.pow(10, digits)).toFixed(digits);
    if (parseFloat(fixed) >= 1e6) return formatSpeed(value);
    const [whole, fraction] = fixed.split('.');
    return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
  }
  return { rate, score, aggregate, groups, createRanking, formatSpeed, rateNumber, amountNumber };
})();
`;

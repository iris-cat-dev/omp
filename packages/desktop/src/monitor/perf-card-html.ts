import { MONITOR_PERF_CARD_METRICS } from "./perf-card-types.js";
import {
  MONITOR_PERF_CARD_CONTENT_SCRIPT,
  MONITOR_PERF_CARD_CSS,
  MONITOR_PERF_NUMBER_SCRIPT,
  MONITOR_PERF_PRESENTATION_SCRIPT,
} from "./performance-ui.js";

// Agent Speed v1.6.1 PerfCardWindow: one painted card, two content layers, no input or GPU.
const MONITOR_PERF_CARD_SCRIPT =
  MONITOR_PERF_PRESENTATION_SCRIPT +
  MONITOR_PERF_NUMBER_SCRIPT +
  MONITOR_PERF_CARD_CONTENT_SCRIPT +
  String.raw`
const bridge = window.ompMonitor;
const perfMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const perfDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const perfContrastQuery = window.matchMedia('(prefers-contrast: more)');
const perfForcedColorsQuery = window.matchMedia('(forced-colors: active)');
const frame = document.getElementById('perf-card-frame');
const perfRowValues = new Map(), frameEffects = new Set(), contentEffects = new Set(), listeners = [];
let language = 'en', latestState = null, sequence = -1, revision = 0, disposed = false, shown = false, shownAgent = null, frontAgent = null, perfRaf = 0;
let front = perfBuildCardView(document.getElementById('perf-card-front')), back = perfBuildCardView(document.getElementById('perf-card-back'));
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function timestamp(value) { return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US',{dateStyle:'short',timeStyle:'medium'}).format(new Date(value)); }
function perfReduced() { return perfMotionQuery.matches; }
function listen(target,event,handler) { target.addEventListener(event,handler); listeners.push(() => target.removeEventListener(event,handler)); }
function animate(element,frames,duration,effects,complete) {
  if (typeof element.animate !== 'function') { if (complete) complete(); return; }
  const effect = element.animate(frames,{duration,easing:'linear'}); effects.add(effect);
  effect.onfinish = () => { effects.delete(effect); effect.cancel(); if (complete) complete(); };
  effect.oncancel = () => effects.delete(effect);
}
function cancelEffects(effects) { for (const effect of effects) effect.cancel(); effects.clear(); }
function finishNumbers() {
  if (perfRaf) cancelAnimationFrame(perfRaf); perfRaf = 0;
  for (const [element,motion] of perfNumberAnimations) perfDisplayNumber(element,motion.to,motion.compact,motion.meter);
  perfNumberAnimations.clear(); for (const element of perfNumberFades.keys()) perfFinishNumberFade(element);
}
function perfScheduleAnimation() {
  if (disposed || perfRaf) return;
  perfRaf = requestAnimationFrame(now => {
    perfRaf = 0;
    for (const [element,motion] of perfNumberAnimations) {
      const progress = Math.min(1,Math.max(0,(now-motion.start)/motion.duration)), eased = 1-Math.pow(1-progress,3);
      perfDisplayNumber(element,progress >= 1 ? motion.to : perfRound(motion.from+(motion.to-motion.from)*eased),motion.compact,motion.meter);
      if (progress >= 1) perfNumberAnimations.delete(element);
    }
    for (const [element,fade] of perfNumberFades) {
      const progress = Math.min(1,Math.max(0,(now-fade.start)/fade.duration)), incoming = 1-Math.pow(1-progress,2);
      element.style.setProperty('--perf-outgoing-alpha',String(1-incoming)); element.style.setProperty('--perf-incoming-alpha',String(incoming));
      if (progress >= 1) perfFinishNumberFade(element);
    }
    if (perfNumberAnimations.size || perfNumberFades.size) perfScheduleAnimation();
  });
}
function syncBaseline(refs) {
  const digits = refs.digits, style = getComputedStyle(digits), marker = perfElement('span');
  marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline';
  digits.append(marker); const baseline = marker.getBoundingClientRect().top-digits.getBoundingClientRect().top; marker.remove();
  if (!(baseline > 0)) return;
  digits.style.setProperty('--perf-baseline',baseline+'px'); digits.style.setProperty('--perf-dot-min',1/(window.devicePixelRatio || 1)+'px');
  // SVG text exposes the actual cap box without a canvas or GPU context.
  const probe = perfSvg('svg',{'aria-hidden':'true',width:100,height:100}), glyph = perfSvg('text',{x:0,y:60});
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'; glyph.style.font = [style.fontWeight,style.fontSize,style.fontFamily].join(' ');
  perfText(glyph,'0'); probe.append(glyph); document.body.append(probe);
  const cap = typeof glyph.getBBox === 'function' ? -glyph.getBBox().y+60 : null; probe.remove();
  refs.scale.style.marginTop = baseline+10-digits.getBoundingClientRect().height+'px';
  if (cap !== null && Number.isFinite(cap)) refs.usual.style.setProperty('--perf-chip-top',baseline-cap/2-refs.usual.getBoundingClientRect().height/2+'px');
}
function hideCard(token) {
  finishNumbers(); cancelEffects(frameEffects); cancelEffects(contentEffects); shown = false; shownAgent = null;
  back.card.hidden = true; back.card.setAttribute('aria-hidden','true');
  const opacity = getComputedStyle(frame).opacity; frame.style.opacity = '0'; frame.style.transform = 'none';
  if (frame.hidden || perfReduced()) { frame.hidden = true; return; }
  animate(frame,[{opacity},{opacity:0}],100,frameEffects,() => { if (!disposed && token === revision && !shown) frame.hidden = true; });
}
async function applyState(state,token) {
  if (document.fonts) await document.fonts.ready;
  if (disposed || token !== revision || !state.request) return;
  const request = state.request, snapshot = state.view.snapshot, agent = snapshot && snapshot.agents.find(value => value.id === request.agentId);
  if (!agent) { hideCard(token); return; }
  language = state.view.language; document.documentElement.lang = language;
  const appearance = state.view.preferences.appearance;
  document.body.dataset.appearance = appearance === 'system' ? perfDarkQuery.matches ? 'dark' : 'light' : appearance;
  const same = shown && shownAgent === agent.id && frontAgent === agent.id, switching = shown && !same;
  if (frontAgent !== agent.id) {
    finishNumbers(); cancelEffects(contentEffects);
    if (shown) { const outgoing = front; front = back; back = outgoing; }
    frontAgent = agent.id;
  }
  if (!same) {
    back.card.dataset.outgoing = 'true'; back.card.setAttribute('aria-hidden','true'); back.card.hidden = !switching;
    front.card.dataset.outgoing = 'false'; front.card.removeAttribute('aria-hidden'); front.card.hidden = false; front.card.style.opacity = '1';
  }
  frame.hidden = false;
  if (!shown) frame.style.opacity = '0';
  perfUpdateCard(front,agent,snapshot.performance && snapshot.performance.current[agent.id] || null,request,same);
  frame.setAttribute('aria-label',perfT('a11y.perf.card')); syncBaseline(front);
  // Measure the natural 320-DIP card, never its old native viewport or the host panel.
  frame.dataset.compact = '0'; let compact = 0, height = Math.ceil(frame.getBoundingClientRect().height);
  while (height > state.maxCardHeight && compact < 2) { frame.dataset.compact = String(++compact); height = Math.ceil(frame.getBoundingClientRect().height); }
  await bridge.resizePerfCard({sequence:state.sequence,height,compact});
  if (disposed || token !== revision) return;
  if (!same) cancelEffects(frameEffects); frame.style.opacity = '1'; frame.style.transform = 'none';
  if (!same && !switching) {
    // Sample the original QuadraticEase opacity and CubicEase 2-DIP slide together.
    const frames = [];
    for (let index = 0; index <= 64; index++) { const remaining = 1-index/64; frames.push({offset:index/64,opacity:1-remaining*remaining,transform:perfReduced() ? 'none' : 'translateX('+(state.slideFrom*remaining*remaining*remaining)+'px)'}); }
    animate(frame,frames,150,frameEffects);
  } else if (switching) {
    const outgoing = back; front.card.style.opacity = '1'; outgoing.card.style.opacity = '0';
    animate(outgoing.card,[{opacity:1},{opacity:0}],120,contentEffects,() => { if (outgoing !== front) outgoing.card.hidden = true; });
    animate(front.card,[{opacity:0},{opacity:1}],120,contentEffects);
  }
  shown = true; shownAgent = agent.id;
}
function receiveState(state) {
  if (disposed || state.sequence < sequence) return;
  sequence = state.sequence; latestState = state; const token = ++revision;
  if (!state.request) { hideCard(token); return; }
  void applyState(state,token).catch(error => {
    if (disposed || token !== revision) return;
    console.error('Unable to render the native performance card',error); hideCard(token);
  });
}
const unsubscribe = bridge.onPerfCardState(receiveState);
for (const query of [perfMotionQuery,perfDarkQuery,perfContrastQuery,perfForcedColorsQuery]) listen(query,'change',() => {
  if (perfReduced()) { finishNumbers(); cancelEffects(frameEffects); frame.style.transform = 'none'; }
  if (latestState) receiveState(latestState);
});
if (document.fonts && typeof document.fonts.addEventListener === 'function') listen(document.fonts,'loadingdone',() => { if (latestState) receiveState(latestState); });
listen(document,'visibilitychange',() => { if (document.hidden) finishNumbers(); });
listen(window,'beforeunload',() => {
  disposed = true; revision++; unsubscribe(); finishNumbers(); cancelEffects(frameEffects); cancelEffects(contentEffects);
  for (const remove of listeners.splice(0)) remove();
});
void bridge.readyPerfCard().then(receiveState).catch(error => {
  if (disposed || latestState) return;
  console.error('Unable to initialize the native performance card',error); hideCard(++revision);
});
`;

const { width, shadow } = MONITOR_PERF_CARD_METRICS;
export const MONITOR_PERF_CARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-omp-local-perf-card-v1'; style-src 'nonce-omp-local-perf-card-v1'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'">
<title>OMP · Agent Speed</title><style nonce="omp-local-perf-card-v1">
:root{font-size:14px;font-synthesis:none;font-variant-numeric:tabular-nums}
*{box-sizing:border-box}html,body{margin:0;overflow:hidden;background:transparent;pointer-events:none;user-select:none}
body{width:${width + shadow.left + shadow.right}px;padding:${shadow.top}px ${shadow.right}px ${shadow.bottom}px ${shadow.left}px}
[hidden]{display:none!important}#perf-card-frame{opacity:0}#perf-card-stack{position:relative;isolation:isolate}.perf-card-content{width:100%;min-width:0}
.perf-card-content[data-outgoing="true"]{position:absolute;left:0;right:0;top:0;z-index:0}.perf-card-content[data-outgoing="false"]{position:relative;z-index:1}
${MONITOR_PERF_CARD_CSS}
</style></head><body data-appearance="light">
<section id="perf-card-frame" class="perf-theme perf-card" role="tooltip" hidden><div id="perf-card-stack"><div id="perf-card-front" class="perf-card-content" data-outgoing="false"></div><div id="perf-card-back" class="perf-card-content" data-outgoing="true" aria-hidden="true" hidden></div></div></section>
<script nonce="omp-local-perf-card-v1">'use strict';
${MONITOR_PERF_CARD_SCRIPT}
</script></body></html>`;

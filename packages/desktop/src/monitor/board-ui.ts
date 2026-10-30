import { MONITOR_BOARD_MODEL_SCRIPT } from "./board-model.js";
import { MONITOR_BOARD_EFFECTS_SCRIPT } from "./board-renderer-effects.js";
import { MONITOR_BOARD_RENDERER_SCRIPT } from "./board-renderer.js";

// Agent Speed v1.5.0 board-metrics.css, layout B / DESIGN 2c (MIT).
// Frozen upstream 29dffc4e6fbe1da435071e40781b1571dd45ac22; all demo/page chrome removed.
export const MONITOR_BOARD_CSS = String.raw`
.board-panel {
  --ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "PingFang TC",
        "Microsoft JhengHei", system-ui, sans-serif;
  --num: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
  --mono: "SF Mono", ui-monospace, "Cascadia Mono", "Consolas", monospace;
  --disp: "SF Pro Display", -apple-system, "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
  --gold: #FACC15; --amber: #F5A524; --mint: #34D399; --purple: #A855F7; --green: #22C55E; --red: #EF4444;
}

.board-panel { --w: 340px; position: relative; width: var(--w); height: var(--w); flex: none; overflow: hidden; isolation: isolate;
      display: flex; flex-direction: column; user-select: none; color: var(--ink); font-family: var(--ui); }
.board-panel[data-size="S"] { --w: 280px; }
.board-panel[data-size="L"] { --w: 420px; }
.board-panel .hero { flex: none; margin: 0 var(--pad); height: var(--hero); display: grid; grid-template-columns: minmax(0,1fr) auto;
            align-items: center; position: relative; z-index: 2; }
.board-panel .hl { min-width: 0; }
.board-panel .hr { position: relative; justify-self: end; }
.board-panel .board { flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden; z-index: 2; margin: var(--bgap) var(--bx) 0; }
.board-panel .value { display: flex; align-items: baseline; gap: 6px; position: relative; }
.board-panel .num { display: inline-flex; height: 1.08em; overflow: hidden; position: relative; font-variant-numeric: tabular-nums; }
.board-panel .slot { position: relative; display: inline-block; height: 1em; }
.board-panel .ch { display: inline-block; transition: transform .24s cubic-bezier(.2,.8,.2,1), opacity .2s; }
.board-panel .ch.out { position: absolute; left: 0; top: 0; filter: blur(1.2px); }
.board-panel .ch.in { animation: board-digitIn .6s cubic-bezier(.2,.8,.2,1); }
@keyframes board-digitIn { 0% { filter: blur(1.4px); } 40% { filter: none; } }
.board-motion-reduced .board-panel .ch.in { animation: none; }

.board-panel .ch.fade { animation: board-valueFade .15s ease-out; }
@keyframes board-valueFade { from { opacity: 0; } }
.board-panel .meta { display: flex; gap: 6px; align-items: center; white-space: nowrap; overflow: hidden; }
.board-panel .meta .title { flex: none; }
.board-panel .meta .counts { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.board-panel[data-size="S"].optB .meta { gap: 4px; letter-spacing: 0; }
.board-panel.optB .hero { column-gap: 8px; }
.board-panel .item { position: absolute; left: 0; right: 0; top: 0; will-change: transform, opacity; transition: opacity .3s ease; }
.board-panel .item.gone { opacity: 0; }
.board-panel .row { display: grid; align-items: center; position: relative; }
.board-panel .name { min-width: 0; display: flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.board-panel .name b { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 22px; }
.board-panel .name small { overflow: hidden; text-overflow: ellipsis; flex: 1 1 0; min-width: 0; }
.board-panel .speed, .board-panel .iq { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

.board-panel:not(.cap-on) .row > .iq { display: none; }
.board-panel.glass:not(.cap-on) .row, .board-panel.neon:not(.cap-on) .row { grid-template-columns: 16px 10px minmax(0,1fr) var(--capw, auto) 46px; }
.board-panel.timing:not(.cap-on) .row { grid-template-columns: 24px 3px minmax(0,1fr) var(--capw, auto) 38px 46px; }
.board-panel.timing[data-size="S"]:not(.cap-on) .row { grid-template-columns: 24px 3px minmax(0,1fr) var(--capw, auto) 44px; }


.board-panel .cap { display: inline-flex; align-items: center; gap: 5px; justify-self: stretch; transition: opacity .2s; }
.board-panel .cap.none { opacity: 0; }
.board-panel .meter { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 10px; }
.board-panel .meter i { width: 2.5px; border-radius: .75px; background: var(--unlit); transition: background .22s ease, box-shadow .22s; }
.board-panel .meter i:nth-child(1) { height: 4px; } .board-panel .meter i:nth-child(2) { height: 5.5px; } .board-panel .meter i:nth-child(3) { height: 7px; }
.board-panel .meter i:nth-child(4) { height: 8.5px; } .board-panel .meter i:nth-child(5) { height: 10px; }
.board-panel .meter i.on { background: var(--ink-2); }
.board-panel .cap.max .meter i.on { background: var(--maxc); }
.board-panel .cap.top .meter i.on { background: linear-gradient(0deg, var(--topa), var(--topb)); box-shadow: 0 0 3px color-mix(in oklab, var(--topb) 55%, transparent); }
.board-panel .cap.max .word { color: var(--maxc); }
.board-panel .cap.top .word { background: linear-gradient(90deg, var(--topa), var(--topb)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.board-panel .bolts { display: inline-flex; margin-left: auto; }
.board-panel .bolts svg { width: 8px; height: 10px; fill: var(--amber-ink); }
.board-panel .bolts svg + svg { margin-left: -3px; }
.board-panel .bolts svg:first-child:not(:only-child) { opacity: .6; }
.board-panel .bolts:empty { display: none; }
.board-panel[data-size="S"] .word { display: none; }


.board-panel .m { min-width: 0; }
.board-panel .mv { display: inline-flex; align-items: baseline; white-space: nowrap; gap: 3px; }
.board-panel .mn { position: relative; display: inline-flex; font-variant-numeric: tabular-nums; height: 1.1em; overflow: hidden; }
.board-panel .mn .slot { height: 1.1em; line-height: 1.1em; }
.board-panel .ge { font-size: .6em; color: var(--ink-3); margin-right: -2px; display: none; }
.board-panel .m.partial .ge { display: inline; }

.board-panel .m:is(.unknown, .none, .zero, .tag) .mn { color: var(--ink-3) !important; text-shadow: none !important; }
.board-panel .m.tag .mn { font-family: var(--ui) !important; font-weight: 600 !important; font-size: .8em; letter-spacing: 0 !important; }
.board-panel .m.tag .mn[data-ghost]::before { content: none; }



.board-panel .iq { font-weight: 600; color: var(--ink-2); transition: color .2s ease; }
.board-panel .iq.grade { color: var(--ink-3); font-weight: 500; }
.board-panel .cols { position: absolute; left: 0; right: 0; top: 0; display: grid; align-items: center; pointer-events: none; }
.board-panel .cols .ln { grid-column: 1 / span 4; height: 1px; background: var(--line); align-self: center; margin-right: 2px; }
.board-panel .cols span { text-align: right; white-space: nowrap; color: var(--ink-3); }


.board-panel[data-theme="dark"].glass { --glass: rgba(20,22,33,.58); --glass-edge: rgba(255,255,255,.13); --glass-top: rgba(255,255,255,.22);
  --ink: rgba(244,246,252,.96); --ink-2: rgba(226,230,242,.62); --ink-3: rgba(226,230,242,.38); --line: rgba(255,255,255,.08);
  --line-2: rgba(255,255,255,.14); --fill: rgba(255,255,255,.055); --fill-2: rgba(255,255,255,.09); --unlit: rgba(255,255,255,.18);
  --shadow: 0 30px 80px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.35); --amber-ink: #F5A524;
  --pearl-a: #c7d2fe; --pearl-b: #f5d0fe; --pearl-c: #a5f3fc; }
.board-panel[data-theme="light"].glass { --glass: rgba(252,252,255,.62); --glass-edge: rgba(0,0,0,.08); --glass-top: rgba(255,255,255,.9);
  --ink: rgba(17,20,30,.94); --ink-2: rgba(30,36,52,.6); --ink-3: rgba(30,36,52,.4); --line: rgba(0,0,0,.07); --line-2: rgba(0,0,0,.11);
  --fill: rgba(0,0,0,.04); --fill-2: rgba(0,0,0,.07); --unlit: rgba(0,0,0,.14);
  --shadow: 0 30px 70px rgba(40,50,80,.22), 0 2px 8px rgba(40,50,80,.12); --amber-ink: #B86E00;
  --pearl-a: #6d7cf0; --pearl-b: #c05bd9; --pearl-c: #1aa3c4; }
.board-panel.glass { --pad: 16px; --row: 30px; --sub: 22px; --hero: 86px; --big: 40px; --bgap: 6px; --bx: 10px; --iqw: 22px; --top: 14px;
  border-radius: 26px; padding-top: var(--top); background: var(--glass);
  backdrop-filter: blur(30px) saturate(170%); -webkit-backdrop-filter: blur(30px) saturate(170%);
  box-shadow: var(--shadow), 0 0 calc(var(--bloom, .15) * 70px) calc(var(--bloom, .15) * 6px) var(--heat-soft); }
.board-panel.glass[data-size="S"] { --pad: 14px; --hero: 78px; --big: 34px; --bx: 8px; --iqw: 20px; --top: 12px; }
.board-panel.glass[data-size="L"] { --pad: 18px; --row: 32px; --sub: 23px; --hero: 94px; --big: 46px; --bx: 12px; --iqw: 24px; --top: 16px; }
.board-panel.glass::after { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 5;
  box-shadow: inset 0 0 0 .5px var(--glass-edge), inset 0 1px 0 0 var(--glass-top); }
.board-panel.glass .aurora { position: absolute; inset: -40% -20% 30% -20%; z-index: -1; pointer-events: none;
  opacity: calc(.18 + var(--heat-amount, 0) * .62); transition: opacity 1.2s ease; }
.board-panel.glass .aurora i { position: absolute; width: 70%; height: 90%; border-radius: 50%; filter: blur(34px);
  background: radial-gradient(closest-side, var(--heat), transparent); transition: background 1s linear; }
.board-panel.glass .aurora i:nth-child(1) { left: 0; top: 10%; animation: board-drift1 19s ease-in-out infinite alternate; }
.board-panel.glass .aurora i:nth-child(2) { right: -5%; top: 0; opacity: .7; background: radial-gradient(closest-side, var(--heat-2, var(--heat)), transparent);
  animation: board-drift2 23s ease-in-out infinite alternate; }
@keyframes board-drift1 { to { transform: translate(18%, 8%) scale(1.15); } }
@keyframes board-drift2 { to { transform: translate(-14%, 12%) scale(.92); } }
.board-motion-reduced .board-panel.glass .aurora i, .board-settled .board-panel.glass .aurora i { animation: none; }
.board-panel.glass .value { filter: drop-shadow(0 0 calc(var(--heat-amount, 0) * 14px) var(--heat-soft)); }
.board-panel.glass .num { font: 700 var(--big)/1 var(--num); letter-spacing: -.02em; }
.board-panel.glass .unit { font-size: 13px; color: var(--ink-2); font-weight: 500; }
.board-panel.glass .meta { margin-top: 7px; font-size: 12px; color: var(--ink-2); }
.board-panel.glass .title { color: var(--heat); font-weight: 650; letter-spacing: .03em; transition: color .8s ease; }
.board-panel.glass .spark { display: block; width: 104px; height: 40px; overflow: visible; }
.board-panel.glass[data-size="S"] .spark { width: 76px; }
.board-panel.glass .board::before { content: ""; position: absolute; left: 6px; right: 6px; top: 0; height: 1px; background: var(--line); }
.board-panel.glass.cap-on .board::before { display: none; }
.board-panel.glass .row { height: var(--row); column-gap: 8px; padding: 0 6px; border-radius: 10px;
  grid-template-columns: 16px 10px minmax(0,1fr) var(--capw, auto) var(--iqw) 44px; }
.board-panel.glass .cols { height: 12px; padding: 0 6px; column-gap: 8px; grid-template-columns: 16px 10px minmax(0,1fr) var(--capw, auto) var(--iqw) 44px;
  font: 600 9px/1 var(--ui); letter-spacing: .06em; }
.board-panel.glass .cols .ln { grid-column: 1 / span 4; }
.board-panel.glass .bar { position: absolute; left: 40px; right: 6px; bottom: 1px; height: 2px; border-radius: 2px; z-index: -1; pointer-events: none; }
.board-panel.glass .bar::before, .board-panel.neon .bar::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; border-radius: inherit;
  width: calc(100% * var(--share, 0)); transition: width .55s cubic-bezier(.2,.8,.2,1); }
.board-panel.glass .bar::before { background: linear-gradient(90deg, color-mix(in oklab, var(--rowheat) 35%, transparent), var(--rowheat));
  box-shadow: 0 0 6px color-mix(in oklab, var(--rowheat) 70%, transparent); }
.board-panel.glass .lead .row { background: linear-gradient(90deg, rgba(250,204,21,.11), rgba(250,204,21,.03) 55%, transparent); }
.board-panel[data-theme="light"].glass .lead .row { background: linear-gradient(90deg, rgba(233,168,0,.12), rgba(233,168,0,.03) 55%, transparent); }
.board-panel.glass .rank { font: 650 12px/16px var(--num); color: var(--ink-3); text-align: center; font-variant-numeric: tabular-nums;
  position: relative; height: 16px; overflow: hidden; }
.board-panel.glass .rank span, .board-panel.neon .rank span { display: block; transition: transform .35s cubic-bezier(.2,.8,.2,1); }
.board-panel.glass .lead .rank { color: transparent; background: linear-gradient(180deg, #FFE58A, #E9A800); -webkit-background-clip: text; background-clip: text; }
.board-panel[data-theme="light"].glass .lead .rank { background: linear-gradient(180deg, #E0A000, #9A6500); -webkit-background-clip: text; background-clip: text; }
.board-panel.glass .badge, .board-panel.neon .badge { width: 10px; height: 10px; position: relative; }
.board-panel.glass .badge.idle::before, .board-panel.neon .badge.idle::before { content: ""; position: absolute; inset: 3px; border-radius: 50%; background: var(--ink-3); }
.board-panel.glass .badge.gen i { position: absolute; top: 4px; width: 3px; height: 3px; border-radius: 50%; background: var(--src); animation: board-dot 1.1s ease-in-out infinite; }
.board-panel.glass .badge.gen i:nth-child(1) { left: -1px; } .board-panel.glass .badge.gen i:nth-child(2) { left: 3.5px; animation-delay: .15s; }
.board-panel.glass .badge.gen i:nth-child(3) { left: 8px; animation-delay: .3s; }
@keyframes board-dot { 0%, 100% { opacity: .35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-1.5px); } }
.board-motion-reduced .board-panel.glass .badge.gen i, .board-settled .board-panel.glass .badge.gen i { animation: none; opacity: .9; }
.board-panel.glass .badge.tools::before { content: ""; position: absolute; inset: 1px; border-radius: 3px; border: 1.5px solid var(--src);
  transform: rotate(45deg) scale(.72); opacity: .9; }
.board-panel.glass .name b { font-weight: 640; font-size: 12.5px; }
.board-panel.glass .name small { font-size: 11px; color: var(--ink-3); }
.board-panel.glass .speed { font: 650 13px/1 var(--num); transition: color .6s ease; }
.board-panel.glass .speed.dim { color: var(--ink-3); font-weight: 500; }
.board-panel.glass .iq { font: 600 13px/1 var(--num); } .board-panel.glass .iq > span { font-size: 11px; }
.board-panel.glass .sub .row { height: var(--sub); }
.board-panel.glass .sub .name, .board-panel.neon .sub .name { padding-left: 12px; position: relative; }
.board-panel.glass .sub .name::before, .board-panel.neon .sub .name::before { content: ""; position: absolute; left: 2px; top: -12px; bottom: 50%; width: 7px;
  border-left: 1px solid var(--line); border-bottom: 1px solid var(--line); border-bottom-left-radius: 5px; }
.board-panel.glass .sub .name b { font-weight: 540; font-size: 11.5px; color: var(--ink-2); }
.board-panel.glass .sub .speed { font-size: 11.5px; font-weight: 600; color: var(--ink-2); }
.board-panel.glass .sub .iq { font-size: 11.5px; } .board-panel.glass .sub .iq > span { font-size: 10.5px; }
.board-panel.glass .sub .bar { left: 46px; height: 1.5px; opacity: .7; }
.board-panel.glass .more .row, .board-panel.neon .more .row { height: 20px; }
.board-panel.glass .more .name { padding-left: 12px; font-size: 11px; color: var(--ink-3); }
.board-panel.glass .more .speed, .board-panel.neon .more .speed { color: var(--ink-3); font-weight: 500; font-size: 11px; }
.board-panel .more .stack { display: inline-flex; margin-right: 6px; transform: translateY(1px); }
.board-panel .more .stack i { width: 6px; height: 6px; border-radius: 50%; background: var(--src); margin-left: -2px; box-shadow: 0 0 0 1.5px var(--glass, transparent); opacity: .85; }
.board-panel.glass .cap { height: 18px; border-radius: 9px; padding: 0 6px; background: var(--fill); box-shadow: inset 0 0 0 .5px var(--line); }
.board-panel.glass .sub .cap { height: 16px; padding: 0 5px; }
.board-panel.glass .word { font-size: 11px; font-weight: 560; color: var(--ink-2); letter-spacing: .01em; }
.board-panel.glass .bolts svg { filter: drop-shadow(0 0 2px color-mix(in oklab, var(--amber) 45%, transparent)); }
.board-panel.glass .foot { flex: none; margin: 8px var(--pad) 12px; height: 18px; display: flex; justify-content: space-between; align-items: center;
  font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; position: relative; z-index: 2; }
.board-panel.glass .foot b { color: var(--ink-2); font-weight: 600; }
.board-panel.glass .foot span { white-space: nowrap; }
.board-panel[data-size="S"] .foot .peak { display: none; }


.board-panel[data-theme="dark"].timing { --slab: #0c0e14; --slab-2: #12151d; --edge: rgba(255,255,255,.09);
  --ink: #f5f7fb; --ink-2: rgba(232,236,245,.66); --ink-3: rgba(232,236,245,.36); --block: #1b1f2a; --block-ink: #e8ecf5;
  --line: rgba(255,255,255,.06); --line-2: rgba(255,255,255,.1); --hatch: rgba(255,255,255,.025); --unlit: rgba(255,255,255,.16);
  --fill: rgba(255,255,255,.05); --amber-ink: #F5A524; --shadow: 0 28px 70px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3); }
.board-panel[data-theme="light"].timing { --slab: #fbfbfd; --slab-2: #f1f3f7; --edge: rgba(0,0,0,.08);
  --ink: #0e1118; --ink-2: rgba(14,17,24,.62); --ink-3: rgba(14,17,24,.4); --block: #e6e9f0; --block-ink: #1a1e28;
  --line: rgba(0,0,0,.06); --line-2: rgba(0,0,0,.1); --hatch: rgba(0,0,0,.025); --unlit: rgba(0,0,0,.14); --fill: rgba(0,0,0,.045);
  --amber-ink: #B86E00; --shadow: 0 24px 60px rgba(30,40,60,.18), 0 2px 6px rgba(30,40,60,.1); }
.board-panel.timing { --pad: 14px; --row: 30px; --sub: 21px; --hero: 80px; --big: 36px; --bgap: 6px; --bx: 10px; --iqw: 24px; --top: 16px;
  border-radius: 20px; padding-top: var(--top); background: var(--slab);
  box-shadow: 0 0 0 1px var(--edge), var(--shadow), 0 0 calc(var(--bloom, .15) * 60px) calc(var(--bloom, .15) * 4px) var(--heat-soft); }
.board-panel.timing[data-size="S"] { --pad: 12px; --hero: 72px; --big: 30px; --bx: 8px; --iqw: 22px; --top: 14px; }
.board-panel.timing[data-size="L"] { --pad: 16px; --row: 32px; --sub: 22px; --hero: 88px; --big: 42px; --bx: 12px; --iqw: 26px; --top: 18px; }
.board-panel.timing::before { content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background: repeating-linear-gradient(135deg, var(--hatch) 0 2px, transparent 2px 7px); }
.board-panel.timing .rail { position: absolute; left: 0; right: 0; top: 0; height: 3px; background: var(--line); z-index: 3; }
.board-panel.timing .rail i { position: absolute; inset: 0; transform-origin: left; transform: scaleX(var(--heat-amount, 0));
  background: linear-gradient(90deg, #2DD4BF, #818CF8 40%, #FB7185 75%, #FACC15); transition: transform .6s cubic-bezier(.2,.9,.2,1);
  box-shadow: 0 0 10px color-mix(in oklab, var(--heat) 70%, transparent); }
.board-panel.timing .live { display: flex; width: max-content; align-items: center; gap: 6px; font: 700 10px/1 var(--disp); letter-spacing: .14em; color: var(--ink-2); }
.board-panel.timing .live i { width: 7px; height: 7px; border-radius: 50%; background: var(--red); animation: board-live 1.6s ease-out infinite; }
.board-panel.timing .live.idle i { background: var(--ink-3); animation: none; }
@keyframes board-live { 0% { box-shadow: 0 0 0 0 rgba(239,68,68,.55); } 100% { box-shadow: 0 0 0 7px rgba(239,68,68,0); } }
.board-motion-reduced .board-panel.timing .live i, .board-settled .board-panel.timing .live i { animation: none; }
.board-panel.timing .value { margin-top: 6px; }
.board-panel.timing .num { font: 800 var(--big)/1 var(--mono); letter-spacing: -.04em; }
.board-panel.timing .unit { font: 600 11px/1 var(--mono); color: var(--ink-3); letter-spacing: .04em; }
.board-panel.timing .meta { margin-top: 7px; gap: 7px; font: 600 10.5px/1 var(--mono); color: var(--ink-3); letter-spacing: .03em; }
.board-panel.timing .title { font: 700 11px/1 var(--ui); padding: 3px 7px; border-radius: 5px; color: #0b0d12; background: var(--heat); letter-spacing: .04em; transition: background .6s; }
.board-panel.timing .bars { display: flex; align-items: flex-end; gap: 2px; height: 38px; }
.board-panel.timing .bars i { width: 3px; border-radius: 1px; background: var(--heat); opacity: .85; transition: height .3s ease, background .6s; flex: none; }
.board-panel.timing[data-size="S"] .hr .bars i:nth-child(-n+10) { display: none; }
.board-panel.timing .row { height: var(--row); column-gap: 7px; padding: 0 4px;
  grid-template-columns: 24px 3px minmax(0,1fr) var(--capw, auto) 34px var(--iqw) 42px; }
.board-panel.timing .cols { height: 14px; padding: 0 4px; column-gap: 7px; grid-template-columns: 24px 3px minmax(0,1fr) var(--capw, auto) 34px var(--iqw) 42px;
  font: 700 8.5px/1 var(--mono); letter-spacing: .1em; }
.board-panel.timing .cols .ln { grid-column: 1 / span 4; }
.board-panel.timing .group .row { border-bottom: 1px solid var(--line); }
.board-panel.timing .pos { width: 24px; height: 22px; border-radius: 5px; background: var(--block); color: var(--block-ink); display: grid; place-items: center;
  font: 800 12px/1 var(--mono); overflow: hidden; position: relative; transition: background .3s, color .3s; }
.board-panel.timing .pos span { display: block; transition: transform .32s cubic-bezier(.3,1.3,.4,1); }
.board-panel.timing .lead .pos { background: linear-gradient(160deg, #fff1a8, var(--gold) 45%, #d49b00); color: #241a00; box-shadow: 0 0 12px rgba(250,204,21,.35); }
.board-panel.timing .stripe { width: 3px; height: 18px; border-radius: 2px; background: var(--src); box-shadow: 0 0 6px color-mix(in oklab, var(--src) 60%, transparent); }
.board-panel.timing .gen .stripe { animation: board-stripe 1.1s ease-in-out infinite; }
@keyframes board-stripe { 50% { opacity: .45; } }
.board-motion-reduced .board-panel.timing .gen .stripe, .board-settled .board-panel.timing .gen .stripe { animation: none; }
.board-panel.timing .name b { font: 700 12.5px/1.2 var(--disp); letter-spacing: .005em; }
.board-panel.timing .name small { font: 600 10px/1 var(--mono); color: var(--ink-3); letter-spacing: .02em; }
.board-panel.timing .gap { font: 600 10.5px/1 var(--mono); color: var(--ink-3); text-align: right; white-space: nowrap; }
.board-panel.timing .lead .gap { color: var(--gold); font-weight: 800; letter-spacing: .06em; font-size: 9px; }
.board-panel[data-theme="light"].timing .lead .gap { color: #B07800; }
.board-panel.timing .speed { font: 800 13px/1 var(--mono); letter-spacing: -.02em; position: relative; }
.board-panel.timing .speed.dim { color: var(--ink-3); font-weight: 600; }
.board-panel.timing .iq { font: 700 13px/1 var(--mono); } .board-panel.timing .iq > span { font-size: 11px; letter-spacing: -.02em; }
.board-panel.timing .iq.grade { font-weight: 600; }
.board-panel.timing .sub .row { height: var(--sub); }
.board-panel.timing .sub .pos { visibility: hidden; }
.board-panel.timing .sub .stripe { height: 10px; width: 2px; opacity: .7; margin-left: 1px; }
.board-panel.timing .sub .name { padding-left: 10px; position: relative; }
.board-panel.timing .sub .name::before { content: ""; position: absolute; left: 0; top: 50%; width: 6px; border-top: 1px solid var(--ink-3); opacity: .6; }
.board-panel.timing .sub .name b { font: 600 11px/1.2 var(--ui); color: var(--ink-2); }
.board-panel.timing .sub .speed { font-size: 11px; color: var(--ink-2); font-weight: 700; }
.board-panel.timing .sub .iq { font-size: 11px; } .board-panel.timing .sub .iq > span { font-size: 10px; }
.board-panel.timing .more .row { height: 19px; }
.board-panel.timing .more .name { padding-left: 10px; font: 600 10px/1 var(--mono); color: var(--ink-3); letter-spacing: .03em; }
.board-panel.timing .more .speed { font-size: 10.5px; color: var(--ink-3); font-weight: 700; }
.board-panel.timing .cap { height: 17px; border-radius: 4px; gap: 4px; padding: 0 5px; background: var(--fill); box-shadow: inset 0 0 0 1px var(--line); }
.board-panel.timing .meter i { border-radius: .5px; }
.board-panel.timing .word { font: 700 10px/1 var(--mono); color: var(--ink-2); letter-spacing: .02em; text-transform: uppercase; }

.board-panel.timing.cap-on:not([data-size="L"]) .word { display: none; }
.board-panel.timing[data-size="S"] .gap, .board-panel.timing[data-size="S"] .cols .g { display: none; }
.board-panel.timing[data-size="S"] .row, .board-panel.timing[data-size="S"] .cols { grid-template-columns: 24px 3px minmax(0,1fr) var(--capw, auto) var(--iqw) 40px; }
.board-panel.timing .foot { flex: none; margin-top: 4px; height: 28px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 var(--pad); font: 700 10px/1 var(--mono); color: var(--ink-3); letter-spacing: .06em; border-top: 1px solid var(--line);
  background: var(--slab-2); position: relative; z-index: 2; }
.board-panel.timing .foot b { color: var(--ink-2); }


.board-panel[data-theme="dark"].neon { --deck: #05060c; --deck-2: #0a0d18; --ink: #f3f6ff; --ink-2: rgba(214,224,255,.66); --ink-3: rgba(214,224,255,.36);
  --line: rgba(140,170,255,.10); --line-2: rgba(140,170,255,.16); --fill: rgba(140,170,255,.07); --fill-2: rgba(140,170,255,.13);
  --unlit: rgba(140,170,255,.16); --amber-ink: #FFC24B; --grid: rgba(120,150,255,.05);
  --led: #eaf2ff; --led-glow: 0 0 4px rgba(150,190,255,.75), 0 0 12px rgba(120,160,255,.4); --ghost: rgba(160,190,255,.075);
  --well: rgba(0,0,0,.38); --well-shadow: inset 0 1px 6px rgba(0,0,0,.55), inset 0 0 0 1px rgba(140,170,255,.10); --mind: #cfe0ff; }
.board-panel[data-theme="light"].neon { --deck: #f7f8fc; --deck-2: #eceff7; --ink: #0a0d18; --ink-2: rgba(10,13,24,.62); --ink-3: rgba(10,13,24,.4);
  --line: rgba(20,30,80,.08); --line-2: rgba(20,30,80,.12); --fill: rgba(20,30,80,.05); --fill-2: rgba(20,30,80,.09);
  --unlit: rgba(20,30,80,.14); --amber-ink: #B86E00; --grid: rgba(20,30,80,.04);
  --led: #141a33; --led-glow: none; --ghost: rgba(20,30,80,.06);
  --well: rgba(20,30,80,.045); --well-shadow: inset 0 1px 3px rgba(20,30,80,.12), inset 0 0 0 1px rgba(20,30,80,.08); --mind: #3d4f9a; }
.board-panel.neon { --pad: 16px; --row: 30px; --sub: 22px; --hero: 92px; --big: 40px; --bgap: 4px; --bx: 10px; --iqw: 22px; --top: 14px;
  border-radius: 22px; padding-top: var(--top);
  background: radial-gradient(120% 80% at 85% 0%, color-mix(in oklab, var(--heat) calc(var(--heat-amount, 0) * 22%), transparent), transparent 60%),
              repeating-linear-gradient(0deg, var(--grid) 0 1px, transparent 1px 22px),
              repeating-linear-gradient(90deg, var(--grid) 0 1px, transparent 1px 22px), var(--deck);
  box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 calc(var(--bloom, .15) * 80px) calc(var(--bloom, .15) * 8px) var(--heat-soft); }
.board-panel[data-theme="light"].neon { box-shadow: 0 26px 60px rgba(30,40,80,.2), 0 0 calc(var(--bloom, .15) * 60px) calc(var(--bloom, .15) * 6px) var(--heat-soft); }
.board-panel.neon[data-size="S"] { --pad: 14px; --hero: 82px; --big: 34px; --bx: 8px; --iqw: 20px; --top: 12px; }
.board-panel.neon[data-size="L"] { --pad: 18px; --row: 32px; --sub: 23px; --hero: 100px; --big: 46px; --bx: 12px; --iqw: 24px; --top: 16px; }
.board-panel.neon.optB { --hero: 100px; } .board-panel.neon.optB[data-size="S"] { --hero: 92px; } .board-panel.neon.optB[data-size="L"] { --hero: 108px; }
.board-panel.neon::after { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 7;
  box-shadow: inset 0 0 0 1.2px color-mix(in oklab, var(--heat) 75%, white 10%),
              inset 0 0 calc(6px + var(--heat-amount, 0) * 18px) color-mix(in oklab, var(--heat) 55%, transparent);
  opacity: calc(.45 + var(--heat-amount, 0) * .55); animation: board-tube var(--breath, 3s) ease-in-out infinite; }
@keyframes board-tube { 50% { opacity: calc(.3 + var(--heat-amount, 0) * .5); } }
.board-motion-reduced .board-panel.neon::after, .board-settled .board-panel.neon::after { animation: none; }
.board-panel.neon .glow { display: inline-flex; filter: drop-shadow(0 0 3px var(--heat)) drop-shadow(0 0 10px var(--heat)) drop-shadow(0 0 calc(4px + var(--heat-amount, 0) * 16px) var(--heat)); }
.board-panel[data-theme="light"].neon .glow { filter: drop-shadow(0 0 8px var(--heat-soft)); }
.board-panel.neon .value { gap: 7px; }
.board-panel.neon .num { font: 700 var(--big)/1 var(--mono); letter-spacing: -.03em; color: #FFFDF5; }
.board-panel[data-theme="light"].neon .num { color: var(--ink); }
.board-panel.neon .unit { font: 700 10.5px/1 var(--mono); color: var(--heat); letter-spacing: .14em; text-shadow: 0 0 8px var(--heat-soft); }
.board-panel.neon .meta { margin-top: 8px; gap: 8px; font: 600 10.5px/1 var(--mono); color: var(--ink-3); letter-spacing: .06em; }
.board-panel.neon .title { font: 700 12px/1 var(--ui); color: var(--heat); letter-spacing: .06em; text-shadow: 0 0 10px var(--heat-soft); }
.board-panel.neon .hl { align-self: start; }
.board-panel.neon .led { position: absolute; left: 0; right: 0; bottom: 6px; height: 7px; display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; }
.board-panel.neon .led i { border-radius: 1.5px; background: var(--unlit); transition: background .25s, box-shadow .25s; }
.board-panel.neon .led i.on { background: var(--c); box-shadow: 0 0 6px var(--c); }
.board-panel.neon .led i.pk { background: #FFF7D6; box-shadow: 0 0 8px #FFF7D6; }
.board-panel[data-theme="light"].neon .led i.pk { background: #B07800; box-shadow: none; }
.board-panel.neon .row { height: var(--row); column-gap: 8px; padding: 0 6px; border-radius: 9px;
  grid-template-columns: 16px 10px minmax(0,1fr) var(--capw, auto) var(--iqw) 44px; }
.board-panel.neon .cols { height: 12px; padding: 0 6px; column-gap: 8px; grid-template-columns: 16px 10px minmax(0,1fr) var(--capw, auto) var(--iqw) 44px;
  font: 600 8.5px/1 var(--mono); letter-spacing: .12em; }
.board-panel.neon .lead .row { background: linear-gradient(100deg, rgba(250,204,21,.12), rgba(232,121,249,.07) 45%, transparent 75%); }
.board-panel.neon .bar { position: absolute; left: 40px; right: 6px; bottom: 1px; height: 2px; border-radius: 2px; z-index: -1; pointer-events: none; }
.board-panel.neon .bar::before { background: linear-gradient(90deg, transparent, var(--rowheat)); box-shadow: 0 0 8px var(--rowheat), 0 0 2px var(--rowheat); }
.board-panel.neon .rank { font: 700 12px/16px var(--mono); color: var(--ink-3); text-align: center; position: relative; height: 16px; overflow: hidden; }
.board-panel.neon .lead .rank { color: #FFE58A; text-shadow: 0 0 8px rgba(250,204,21,.9); }
.board-panel[data-theme="light"].neon .lead .rank { color: #B07800; text-shadow: none; }
.board-panel.neon .badge.gen::before { content: ""; position: absolute; inset: 2px; border-radius: 50%; background: var(--src);
  box-shadow: 0 0 6px var(--src), 0 0 12px var(--src); animation: board-pulse 1s ease-in-out infinite; }
@keyframes board-pulse { 50% { transform: scale(.65); opacity: .7; } }
.board-panel.neon .badge.gen i { display: none; }
.board-motion-reduced .board-panel.neon .badge.gen::before, .board-settled .board-panel.neon .badge.gen::before { animation: none; }
.board-panel.neon .badge.tools::before { content: ""; position: absolute; inset: 1px; border-radius: 3px; border: 1.5px solid var(--src);
  transform: rotate(45deg) scale(.7); box-shadow: 0 0 6px var(--src); }
.board-panel.neon .name b { font-weight: 650; font-size: 12.5px; }
.board-panel.neon .name small { font: 500 10px/1 var(--mono); color: var(--ink-3); letter-spacing: .02em; }
.board-panel.neon .speed { font: 700 13px/1 var(--mono); letter-spacing: -.02em; }
.board-panel.neon .speed.dim { color: var(--ink-3); font-weight: 500; }
.board-panel.neon .iq { font: 600 13px/1 var(--mono); color: var(--led); opacity: .78; } .board-panel.neon .iq > span { font-size: 11px; letter-spacing: -.02em; }
.board-panel[data-theme="dark"].neon .iq:not(.grade) { text-shadow: 0 0 6px rgba(140,180,255,.45); }
.board-panel.neon .iq.grade { color: var(--ink-3); opacity: 1; }
.board-panel.neon .sub .row { height: var(--sub); }
.board-panel.neon .sub .name b { font-weight: 540; font-size: 11.5px; color: var(--ink-2); }
.board-panel.neon .sub .speed { font-size: 11px; color: var(--ink-2); }
.board-panel.neon .sub .iq { font-size: 11px; } .board-panel.neon .sub .iq > span { font-size: 10px; }
.board-panel.neon .sub .bar { left: 46px; height: 1.5px; opacity: .7; }
.board-panel.neon .more .name { padding-left: 12px; font: 500 10px/1 var(--mono); color: var(--ink-3); letter-spacing: .03em; }
.board-panel.neon .more .stack i { width: 5px; height: 5px; margin-left: -1px; box-shadow: 0 0 4px var(--src); }
.board-panel.neon .cap { height: 18px; border-radius: 9px; padding: 0 6px; background: var(--fill); box-shadow: inset 0 0 0 1px var(--line); }
.board-panel.neon .sub .cap { height: 16px; }
.board-panel.neon .meter i.on { background: #cfe0ff; box-shadow: 0 0 4px rgba(170,200,255,.8); }
.board-panel[data-theme="light"].neon .meter i.on { background: var(--ink-2); box-shadow: none; }
.board-panel.neon .cap.max .meter i.on { box-shadow: 0 0 5px var(--maxc); }
.board-panel.neon .word { font: 700 10px/1 var(--mono); color: var(--ink-2); letter-spacing: .04em; }
.board-panel.neon .cap.max .word { text-shadow: 0 0 6px var(--maxc); }
.board-panel.neon .bolts svg { filter: drop-shadow(0 0 3px var(--amber)); }
.board-panel.neon .foot { flex: none; margin: 7px var(--pad) 11px; height: 18px; display: flex; justify-content: space-between; align-items: center;
  font: 600 10px/1 var(--mono); color: var(--ink-3); letter-spacing: .06em; position: relative; z-index: 2; }
.board-panel.neon .foot b { color: var(--ink-2); font-weight: 700; }


.board-panel.neon .mn[data-ghost]::before { content: attr(data-ghost); position: absolute; left: 0; top: 0; color: var(--ghost); text-shadow: none;
  line-height: 1.1em; pointer-events: none; }


.board-panel .strip { flex: none; position: relative; z-index: 2; }
.board-panel.glass .strip { margin: 0 var(--pad); height: 16px; }
.board-panel.glass .strip svg, .board-panel.glass[data-size] .strip svg { display: block; width: 100%; height: 100%; overflow: visible; }
.board-panel.glass[data-size="L"] .strip { height: 18px; }
.board-panel.glass[data-size="S"] .strip { height: 14px; }
.board-panel.glass.optB .board { margin-top: 0; }
.board-panel.timing .strip { margin: 8px var(--pad) 0; height: 12px; }
.board-panel.timing.optB .board { margin-top: 5px; }
.board-panel.timing .strip .bars { height: 12px; gap: 0; width: 100%; justify-content: space-between; }
.board-panel.timing .strip .bars i { width: 3px; border-radius: 1px; }
.board-panel.timing[data-size="S"] .strip { height: 10px; }
.board-panel.timing[data-size="S"] .strip .bars { height: 10px; }

.board-panel .gauge { display: flex; flex-direction: column; align-items: center; }
.board-panel .gauge .gl { display: flex; flex-direction: column; align-items: center; }
.board-panel .gauge .m { display: flex; justify-content: center; align-items: baseline; gap: 3px; white-space: nowrap; }



.board-panel.glass .gauge { min-width: 112px; }
.board-panel.glass .gauge .dial { position: relative; width: 66px; height: 49px; }
.board-panel.glass .gauge .dial svg { position: absolute; left: 0; top: 0; width: 66px; height: 66px; overflow: visible; }
.board-panel.glass .gauge .trk { fill: none; stroke: var(--line-2); stroke-width: 3; stroke-linecap: round; }
.board-panel.glass .gauge .arc { fill: none; stroke: url(#pearl); stroke-width: 3; stroke-linecap: round;
  transition: stroke-dashoffset .24s cubic-bezier(.2,.8,.2,1), opacity .2s; filter: drop-shadow(0 0 3px color-mix(in oklab, var(--pearl-b) 60%, transparent)); }
.board-panel.glass .gauge .tip { fill: #fff; filter: drop-shadow(0 0 3px var(--pearl-b)); transition: transform .24s cubic-bezier(.2,.8,.2,1), opacity .2s; }
.board-motion-reduced .board-panel.glass .gauge .arc, .board-motion-reduced .board-panel.glass .gauge .tip { transition: opacity .15s; }
.board-panel[data-theme="light"].glass .gauge .tip { fill: var(--pearl-b); filter: none; }
.board-panel.glass .gauge .m.main { position: absolute; left: 0; right: 0; top: 15px; flex-direction: column; align-items: center; gap: 2px; }
.board-panel.glass .gauge .m.main .ml { font-size: 8.5px; font-weight: 600; color: var(--ink-3); letter-spacing: .1em; line-height: 1; padding-left: .1em; }
.board-panel.glass .gauge .m.main .mn { font: 650 19px/1 var(--num); letter-spacing: -.02em; }

.board-panel .gauge .subs { position: relative; display: grid; align-items: baseline; row-gap: 3px; grid-auto-rows: 15px;
  grid-template-columns: minmax(var(--sublabel, 0px), auto) auto minmax(var(--subnum, 0px), auto) minmax(var(--subunit, 0px), auto); }

.board-panel .m.off .ml, .board-panel .m.off .mv, .board-panel .m.off .ge, .board-panel .m.off .mn, .board-panel .m.off .mu { display: none !important; }
.board-panel .m.leaving .ml, .board-panel .m.leaving .mv, .board-panel .m.leaving .ge, .board-panel .m.leaving .mn, .board-panel .m.leaving .mu { pointer-events: none; }
.board-panel .gauge .subs .m, .board-panel .gauge .subs .mv { display: contents; }
.board-panel .gauge .subs .ml { margin-right: 4px; }
.board-panel .gauge .subs .ge { display: inline; visibility: hidden; margin-right: 1px; }
.board-panel .gauge .subs .m.partial .ge { visibility: visible; }

.board-panel.glass .gauge .subs .ge { font-size: 9.35px; } .board-panel.glass[data-size="S"] .gauge .subs .ge { font-size: 8.1px; } .board-panel.glass[data-size="L"] .gauge .subs .ge { font-size: 10.2px; }
.board-panel.neon .gauge .subs .ge { font-size: 8.9px; } .board-panel.neon[data-size="S"] .gauge .subs .ge { font-size: 8.1px; } .board-panel.neon[data-size="L"] .gauge .subs .ge { font-size: 9.8px; }
.board-panel.timing .dbox .ge { font-size: 9.8px; margin-right: 1px; } .board-panel.timing[data-size="S"] .dbox .ge { font-size: 8.9px; } .board-panel.timing[data-size="L"] .dbox .ge { font-size: 10.6px; }
.board-panel .gauge .subs .mn { justify-self: end; }
.board-panel .gauge .subs .mu { margin-left: 3px; }
.board-panel.glass .gauge .subs { row-gap: 2px; }
.board-panel.glass .gauge .dial + .subs { margin-top: 3px; }
.board-panel.glass .gauge .subs .ml { font-size: 8.5px; font-weight: 600; color: var(--ink-3); letter-spacing: .04em; }
.board-panel.glass .gauge .subs .mn { font: 600 11px/1 var(--num); color: var(--ink); }
.board-panel.glass .gauge .subs .mu { font-size: 8.5px; color: var(--ink-3); font-weight: 500; }
.board-panel.glass[data-size="L"] .gauge { min-width: 128px; }
.board-panel.glass[data-size="L"] .gauge .dial { width: 74px; height: 55px; }
.board-panel.glass[data-size="L"] .gauge .dial svg { width: 74px; height: 74px; }
.board-panel.glass[data-size="L"] .gauge .m.main { top: 17px; }
.board-panel.glass[data-size="L"] .gauge .m.main .mn { font-size: 21px; }
.board-panel.glass[data-size="L"] .gauge .subs .mn { font-size: 12px; }
.board-panel.glass[data-size="L"] .gauge .subs .ml, .board-panel.glass[data-size="L"] .gauge .subs .mu { font-size: 9px; }
.board-panel.glass[data-size="S"] .gauge { min-width: 92px; }
.board-panel.glass[data-size="S"] .gauge .dial { width: 54px; height: 40px; }
.board-panel.glass[data-size="S"] .gauge .dial svg { width: 54px; height: 54px; }
.board-panel.glass[data-size="S"] .gauge .m.main { top: 13px; gap: 1px; }
.board-panel.glass[data-size="S"] .gauge .m.main .mn { font-size: 16px; }
.board-panel.glass[data-size="S"] .gauge .m.main .ml { font-size: 7.5px; }
.board-panel.glass[data-size="S"] .gauge .subs { row-gap: 2px; }
.board-panel.glass[data-size="S"] .gauge .subs .mn { font-size: 9.5px; }
.board-panel.glass[data-size="S"] .gauge .subs .ml, .board-panel.glass[data-size="S"] .gauge .subs .mu { font-size: 7.5px; }
.board-panel.glass[data-size="S"] .gauge .subs .ml { letter-spacing: .02em; }


.board-panel.timing .dbox { position: relative; min-width: 134px; border-radius: 5px; overflow: hidden; background: var(--slab-2); box-shadow: inset 0 0 0 1px var(--line-2);
  display: grid; grid-template-columns: minmax(var(--tabw, 0px), auto) 1fr; }
.board-panel.timing .dbox .m { display: contents; }
.board-panel.timing .dbox .ml { display: grid; place-items: center; padding: 0 6px; background: var(--block); color: var(--ink-2);
  font: 700 9px/1 var(--ui); letter-spacing: .06em; border-top: 1px solid var(--line-2); }

.board-panel.timing .dbox { --dh: 17px; --dn: 11.5px; }
.board-panel.timing .dbox .m.main { --dh: 24px; --dn: 17px; }
.board-panel.timing .dbox .mv { justify-content: flex-end; padding: calc((var(--dh) - 1px - 1.1 * var(--dn)) / 2) 7px 0 6px; gap: 3px;
  border-top: 1px solid var(--line-2); height: var(--dh); align-items: baseline; }
.board-panel.timing .dbox .m:first-child .ml, .board-panel.timing .dbox .m:first-child .mv { border-top: 0; }
.board-panel.timing .dbox .m:first-child .mv { padding-top: calc((var(--dh) - 1.1 * var(--dn)) / 2); }
.board-panel.timing .dbox .mn { font: 800 var(--dn)/1 var(--mono); letter-spacing: -.03em; }
.board-panel.timing .dbox .m.main .mn { letter-spacing: -.04em; }
.board-panel.timing .dbox .m.main .ml { color: var(--block-ink); }
.board-panel.timing .dbox .mu { font: 700 8px/1 var(--mono); color: var(--ink-3); }
.board-panel.timing[data-size="L"] .dbox { min-width: 152px; }
.board-panel.timing[data-size="L"] .dbox { --dh: 19px; --dn: 12.5px; }
.board-panel.timing[data-size="L"] .dbox .m.main { --dh: 27px; --dn: 19px; }
.board-panel.timing[data-size="S"] .dbox { min-width: 110px; }
.board-panel.timing[data-size="S"] .dbox .ml { padding: 0 4px; font-size: 8px; letter-spacing: 0; }
.board-panel.timing[data-size="S"] .dbox { --dh: 15px; --dn: 10.5px; }
.board-panel.timing[data-size="S"] .dbox .m.main { --dh: 21px; --dn: 15px; }
.board-panel.timing[data-size="S"] .dbox .mv { padding-right: 5px; padding-left: 4px; gap: 2px; }
.board-panel.timing[data-size="S"] .dbox .mu { font-size: 7px; }


.board-panel.neon .gauge { min-width: 112px; }
.board-panel.neon .hr { align-self: start; }
.board-panel.neon.optB .hero { padding-bottom: 17px; }
.board-panel.neon.optB .hl, .board-panel.neon.optB .hr { align-self: center; }
.board-panel.neon .gauge .m.main { flex-direction: column; align-items: center; gap: 3px; }
.board-panel.neon .gauge .m.main .ml { font: 600 8.5px/1 var(--ui); letter-spacing: .24em; color: var(--ink-3); padding-left: .24em; }
.board-panel.neon .gauge .m.main .mn { font: 700 24px/1 var(--mono); letter-spacing: -.03em; color: var(--led); text-shadow: var(--led-glow); }
.board-panel.neon .gauge .segs { display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; width: 74px; height: 3px; margin-top: 3px; }
.board-panel.neon .gauge .segs + .subs { margin-top: 6px; }
.board-panel.neon .gauge .segs i { border-radius: 1px; background: var(--unlit); transition: background .24s, box-shadow .24s; }
.board-motion-reduced .board-panel.neon .gauge .segs i { transition: background .15s, box-shadow .15s; }
.board-panel.neon .gauge .segs i.on { background: var(--mind); box-shadow: 0 0 5px var(--mind); }
.board-panel[data-theme="light"].neon .gauge .segs i.on { box-shadow: none; }
.board-panel.neon .gauge .subs .ml { font: 600 8.5px/1 var(--ui); color: var(--ink-3); letter-spacing: .06em; }
.board-panel.neon .gauge .subs .mn { font: 700 10.5px/1 var(--mono); color: var(--led); letter-spacing: -.02em; }
.board-panel[data-theme="dark"].neon .gauge .subs .mn { text-shadow: 0 0 6px rgba(140,180,255,.45); }
.board-panel.neon .gauge .subs .mu { font: 600 8px/1 var(--mono); color: var(--ink-3); }
.board-panel.neon[data-size="L"] .gauge { min-width: 128px; }
.board-panel.neon[data-size="L"] .gauge .m.main .mn { font-size: 28px; }
.board-panel.neon[data-size="L"] .gauge .segs { width: 84px; }
.board-panel.neon[data-size="L"] .gauge .subs .mn { font-size: 11.5px; }
.board-panel.neon[data-size="S"] .gauge { min-width: 92px; }
.board-panel[data-size="S"] .gauge .subs .ml { margin-right: 3px; } .board-panel[data-size="S"] .gauge .subs .mu { margin-left: 2px; }
.board-panel.neon[data-size="S"] .gauge .m.main .mn { font-size: 21px; }
.board-panel.neon[data-size="S"] .gauge .m.main .ml { font-size: 7.5px; letter-spacing: .18em; }
.board-panel.neon[data-size="S"] .gauge .segs { width: 62px; }
.board-panel.neon[data-size="S"] .gauge .segs + .subs { margin-top: 3px; }
.board-panel.neon[data-size="S"] .gauge .subs { row-gap: 2px; }
.board-panel.neon[data-size="S"] .gauge .subs .mn { font-size: 9.5px; }
.board-panel.neon[data-size="S"] .gauge .subs .ml, .board-panel.neon[data-size="S"] .gauge .subs .mu { font-size: 7.5px; }

.board-panel.rows2:not([data-size="S"]) .group .row { align-content: start; row-gap: 3px; grid-template-rows: 16px auto; padding-top: 4px; }
.board-panel.rows2:not([data-size="S"]) .group .cap { height: 16px; }
.board-panel.rows2:not([data-size="S"]) .group .row > * { grid-row: 1; }
.board-panel.rows2:not([data-size="S"]) .group .row > .bar, .board-panel.rows2:not([data-size="S"]) .group .row > .sweep, .board-panel.rows2:not([data-size="S"]) .group .row > .wipe { grid-row: auto; }
.board-panel.rows2:not([data-size="S"]) .group .name { display: contents; }
.board-panel.rows2:not([data-size="S"]) .group .name b { grid-column: 3; grid-row: 1; align-self: baseline; }
.board-panel.rows2:not([data-size="S"]) .group .name small { grid-column: 3; grid-row: 2; align-self: baseline; }
.board-panel.rows2:not([data-size="S"]) .group .row > .rank, .board-panel.rows2:not([data-size="S"]) .group .row > .badge, .board-panel.rows2:not([data-size="S"]) .group .row > .cap, .board-panel.rows2:not([data-size="S"]) .group .row > .iq,
.board-panel.rows2:not([data-size="S"]) .group .row > .speed, .board-panel.rows2:not([data-size="S"]) .group .row > .gap { align-self: baseline; }
.board-panel.rows2:not([data-size="S"]) .group .row > .badge { align-self: center; transform: translateY(-1px); }

.board-panel.rows2:not([data-size="S"]) .group .row > .cap { align-self: start; }
.board-panel.glass.rows2:not([data-size="S"]) .group .row, .board-panel.neon.rows2:not([data-size="S"]) .group .row { height: calc(var(--row) + 8px); }
.board-panel.glass.rows2:not([data-size="S"]) .group .name small { font-size: 10.5px; }
.board-panel.timing.rows2:not([data-size="S"]) .group .row { height: calc(var(--row) + 8px); padding-top: 4px; }
.board-panel.timing.rows2:not([data-size="S"]) .group .row > .pos, .board-panel.timing.rows2:not([data-size="S"]) .group .row > .stripe { grid-row: 1 / span 2; align-self: center; }
.board-panel.timing.rows2:not([data-size="S"]) .group .pos { height: 26px; }
.board-panel.timing.rows2:not([data-size="S"]) .group .stripe { height: 24px; }

.board-panel .sweep, .board-panel .wipe { position: absolute; inset: 0; border-radius: 10px; pointer-events: none; opacity: 0; }
.board-panel .sweep { background: linear-gradient(100deg, transparent 20%, rgba(255,255,255,.35) 48%, transparent 66%); background-size: 260% 100%; }
.board-panel.neon .sweep { background: linear-gradient(100deg, transparent 20%, color-mix(in oklab, var(--src) 50%, transparent) 44%, rgba(255,255,255,.75) 50%, transparent 58%);
  background-size: 260% 100%; mix-blend-mode: screen; }
.board-panel .wipe { inset: 1px 0; border-radius: 0; background: linear-gradient(90deg, transparent, color-mix(in oklab, var(--src) 55%, transparent) 45%, rgba(255,255,255,.55) 50%, transparent 56%);
  background-size: 300% 100%; }
.board-panel .sweep.go, .board-panel .wipe.go { animation: board-sweep .7s cubic-bezier(.3,.7,.2,1); }
@keyframes board-sweep { 0% { opacity: 1; background-position: 130% 0; } 100% { opacity: 1; background-position: -60% 0; } }
.board-panel .chip { position: absolute; right: 84px; top: 50%; transform: translateY(-50%); opacity: 0; z-index: 2; pointer-events: none; white-space: nowrap;
  font: 700 10px/1 var(--num); color: var(--mint); background: color-mix(in oklab, var(--mint) 16%, transparent); padding: 3px 5px; border-radius: 6px; }
.board-panel.timing .chip { font-family: var(--mono); color: #04130a; background: var(--green); border-radius: 4px; right: 120px; }
.board-panel.neon .chip { font-family: var(--mono); color: #021a10; background: var(--mint); border-radius: 4px; box-shadow: 0 0 12px rgba(52,211,153,.8); }
.board-panel .chip.go { animation: board-chip 1.6s cubic-bezier(.2,.8,.2,1); }
@keyframes board-chip { 0% { opacity: 0; transform: translate(6px,-50%) scale(.6); } 14%, 75% { opacity: 1; transform: translate(0,-50%); } 100% { opacity: 0; } }
#board-surface{position:relative;width:100%;height:100%;padding:40px;background:transparent;overflow:hidden;isolation:isolate;pointer-events:none;--board-side:340px}
#board-surface .board-panel{pointer-events:auto;width:var(--board-side);height:var(--board-side);overflow:visible;clip-path:inset(-40px round 0);--heat:#7c8798;--heat-soft:transparent;--maxc:#fb923c;--topa:#e879f9;--topb:#facc15;--heat-amount:0}
#board-surface[data-click-through=true] .board-panel{pointer-events:none}
.board-panel .hero,.board-panel .hero *{-webkit-app-region:drag}
.board-panel :is(button,a,input,select,[tabindex]),.board-panel :is(button,a,input,select,[tabindex]) *{-webkit-app-region:no-drag}
.board-panel .board{overflow:auto;scrollbar-width:none;overscroll-behavior:contain;contain:layout style}
.board-panel .board::-webkit-scrollbar{display:none}
.board-panel .board-rows{position:relative;min-height:100%;isolation:isolate}
.board-panel .board-fx{position:absolute;inset:-40px;width:calc(100% + 80px);height:calc(100% + 80px);z-index:1;pointer-events:none;clip-path:inset(0 round 38px)}
.board-panel .aurora{overflow:hidden;clip-path:inset(0 round 40%)}
.board-panel .item{will-change:auto;transition:transform .45s cubic-bezier(.2,.8,.2,1),opacity .3s ease}
.board-panel.timing .item{transition:transform .45s cubic-bezier(.3,1.3,.4,1),opacity .3s ease}
.board-panel .item.board-enter{opacity:0;translate:0 10px}
.board-panel .item .row{cursor:default;outline-offset:-1px;transition:background .15s,color .2s}
.board-panel .item.group .row{cursor:pointer}
.board-panel .item .row:hover,.board-panel .item .row:focus-visible{background:var(--fill-2,var(--fill))}
.board-panel .row:focus-visible{outline:2px solid var(--heat);outline-offset:1px;z-index:3}
.board-panel .iq>span{position:relative;display:inline-block;line-height:1.2}
.board-panel .board-proof{text-decoration-line:underline;text-decoration-style:dotted;text-decoration-thickness:max(1px,.1em);text-underline-offset:.22em;text-decoration-color:color-mix(in srgb,currentColor 70%,transparent)}
.board-panel .m.resting .mn{color:var(--ink-3)!important;text-shadow:none!important}
.board-panel .gauge.board-resting :is(.arc,.tip),.board-panel .gauge.board-resting .segs i.on{opacity:.35;filter:none;box-shadow:none}
.board-panel .gauge.board-proof-shape .tip{fill:none;stroke:var(--pearl-b);stroke-width:.92}
.board-panel .gauge.board-proof-shape .segs i.on{background:none;box-shadow:inset 0 0 0 1px var(--mind)}
.board-panel .board-iq-hit{position:relative;outline-offset:2px}
.board-panel .board-coverage{position:absolute;left:var(--pad);right:var(--pad);top:2px;z-index:10;font:500 8px/1.2 var(--ui);color:var(--ink-2);pointer-events:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.board-panel .board-peak{position:absolute;left:0;top:-15px;font:700 9px/1 var(--ui);padding:3px 6px;color:#b07800;border-radius:6px;background:#facc1530;opacity:0;white-space:nowrap;pointer-events:none}
.board-panel[data-theme=dark] .board-peak{color:#ffe58a}.board-panel .board-peak.board-pop{animation:board-peak-pop 2.2s ease both}
.board-panel .board-number-punch{animation:board-punch .4s cubic-bezier(.2,.8,.2,1)}
.board-panel .board-number-flash{animation:board-flash .8s ease-out}
.board-panel .board-number-dim{animation:board-dim .5s ease-out}
.board-panel .board-new-leader{position:absolute;left:0;right:0;top:0;z-index:5;pointer-events:none;text-align:center;font:800 10px/20px var(--mono);letter-spacing:.16em;color:#241a00;background:linear-gradient(90deg,transparent,#facc15,transparent);opacity:0}
.board-panel .board-new-leader.board-pop{animation:board-leader-banner 2.2s ease both}
.board-panel.rows2:not([data-size=S]) .group .name small{grid-column:3 / -3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.board-panel.rows2:not([data-size=S]):not(.cap-on) .group .name small{grid-column:3 / -2}
.board-panel.rows2:not([data-size=S]) .group .row>:is(.iq,.speed,.gap){grid-row:1 / span 2;align-self:center;line-height:1;transform:translateY(-1px)}
.board-panel.rows2:not([data-size=S]) .group .row>.iq>span{font-size:13px}
.board-panel.rows2:not([data-size=S]) .group .row>.speed{font-size:15px}
.board-panel.rows2:not([data-size=S]){--iqw:25px;--speedw:50px}
.board-panel.rows2[data-size=L]{--iqw:27px;--speedw:50px}
.board-panel.rows2:not([data-size=S]) .row,.board-panel.rows2:not([data-size=S]) .cols{grid-template-columns:16px 10px minmax(0,1fr) var(--capw,auto) var(--iqw) var(--speedw);column-gap:8px}
.board-panel.rows2:not([data-size=S]):not(.cap-on) .row{grid-template-columns:16px 10px minmax(0,1fr) var(--capw,auto) var(--speedw)}
.board-panel.timing.rows2:not([data-size=S]){--iqw:27px;--speedw:48px}
.board-panel.timing.rows2[data-size=L]{--iqw:29px}
.board-panel.timing.rows2:not([data-size=S]) .row,.board-panel.timing.rows2:not([data-size=S]) .cols{grid-template-columns:24px 3px minmax(0,1fr) var(--capw,auto) 34px var(--iqw) var(--speedw);column-gap:7px}
.board-panel.timing.rows2:not([data-size=S]):not(.cap-on) .row{grid-template-columns:24px 3px minmax(0,1fr) var(--capw,auto) 38px var(--speedw)}
.board-panel.rows2:not([data-size=S]) .sub .speed{font-size:11.5px}.board-panel.timing.rows2:not([data-size=S]) .sub .speed,.board-panel.neon.rows2:not([data-size=S]) .sub .speed{font-size:11px}
.board-panel .probe{position:absolute!important;visibility:hidden!important;white-space:pre!important;display:inline-block!important;width:auto!important;min-width:0!important;pointer-events:none}
.board-panel .board-empty{position:absolute;inset:14px 12px;display:grid;place-items:center;color:var(--ink-3);font:500 11px/1.5 var(--ui);text-align:center}
.board-panel .board-scroll-hint{position:absolute;right:3px;bottom:1px;font:600 8px/1 var(--ui);color:var(--ink-3);pointer-events:none}
#board-settings{margin-top:24px}.board-settings-heading{display:flex;gap:12px;align-items:center;margin:0 0 8px}.board-settings-heading h3{font-size:14px;font-weight:600;flex:1;margin:0}.board-settings-count{font-size:12px;color:var(--secondary)}
.board-settings-list{padding:4px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
.board-settings-row{display:grid;grid-template-columns:44px minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:6px;border:1px solid transparent;border-radius:6px;min-height:58px;cursor:pointer}
.board-settings-row[aria-selected=true]{background:var(--subtle);border-color:var(--accent-fill)}.board-settings-row:hover{background:var(--hover)}
.board-settings-preview{width:44px;height:44px;position:relative;overflow:hidden;border-radius:8px;pointer-events:none;--preview-ink:#eaf2ff;background:#05060c;border:1px solid #818cf880}
.board-settings-preview[data-style=glass]{border-radius:9px;background:linear-gradient(135deg,#2dd4bf33,#818cf833),#171a28;border-color:#ffffff40}
.board-settings-preview[data-style=timing]{border-radius:6px;background:repeating-linear-gradient(135deg,#ffffff08 0 2px,transparent 2px 7px),#0c0e14;border-color:#ffffff20}
body[data-appearance=light] .board-settings-preview{background-color:#f7f8fc;--preview-ink:#141a33;border-color:#818cf8}
.board-settings-preview>i{position:absolute;height:2px;left:6px;right:6px;background:#38bdf8;border-radius:1px;opacity:.7}
.board-settings-preview>i:nth-of-type(1){top:21px;right:12px}.board-settings-preview>i:nth-of-type(2){top:28px;right:16px;opacity:.5}.board-settings-preview>i:nth-of-type(3){top:35px;right:20px;opacity:.35}
.board-settings-preview>span{position:absolute;top:5px;left:6px;font:700 8px/1 var(--mono,monospace);color:var(--preview-ink)}
.board-settings-row-copy{min-width:0}.board-settings-row-copy strong,.board-settings-row-copy small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.board-settings-row-copy strong{font-size:13px;font-weight:600}.board-settings-row-copy small{font-size:11px;color:var(--secondary);margin-top:3px}
.board-settings-toggle{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--secondary)}.board-settings-toggle input{accent-color:var(--accent-fill)}.board-settings-remove{padding:0 7px;min-height:28px;background:transparent;border-color:transparent;color:var(--secondary)}
.board-settings-editor{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.board-settings-editor>label{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--secondary)}.board-settings-editor select{max-width:none;width:100%}
.board-settings-editor fieldset{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:10px 20px;margin:0;border:1px solid var(--line);padding:10px 12px;border-radius:6px;font-size:12px}.board-settings-editor legend{padding:0 4px;color:var(--secondary)}.board-settings-editor fieldset label{display:flex;align-items:center;gap:6px}.board-settings-hint,.board-settings-empty{font-size:11px;color:var(--secondary);line-height:1.6;margin:8px 0}.board-settings-editor .board-settings-hint{grid-column:1/-1;margin:0}.board-settings-error{font-size:12px;color:var(--warning);min-height:18px;line-height:18px}
.board-tooltip{position:fixed;z-index:110;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;padding:10px 12px;border:1px solid var(--control-line);border-radius:12px;background:var(--popup);color:var(--secondary);box-shadow:var(--shadow);font:11.5px/1.6 'Segoe UI Variable Text','Segoe UI',sans-serif;white-space:pre-line;pointer-events:none}
.board-motion-reduced .board-panel .item{transition:opacity .15s}.board-motion-reduced .board-panel :is(.ch.in,.board-number-punch,.board-number-flash,.board-number-dim,.sweep.go,.wipe.go,.chip.go){animation:none!important}
#board-surface[data-paused=true] .board-panel *,#board-surface[data-paused=true] .board-panel::after{animation-play-state:paused!important;transition:none!important}
#board-surface[data-effects=off] .board-panel :is(.aurora,.board-fx){display:none}#board-surface[data-effects=off] .board-panel *,#board-surface[data-effects=off] .board-panel::after{animation:none!important}
#board-surface[data-idle=true] .board-panel :is(.aurora i,.live i,.badge i,.stripe),#board-surface[data-idle=true] .board-panel::after{animation:none!important}
@keyframes board-punch{0%,100%{scale:1}35%{scale:1.06}}@keyframes board-flash{0%{filter:brightness(1.8)}100%{filter:brightness(1)}}@keyframes board-dim{0%{opacity:.55}100%{opacity:1}}@keyframes board-peak-pop{0%,100%{opacity:0;translate:0 3px}12%,82%{opacity:1;translate:0 0}}@keyframes board-leader-banner{0%,100%{opacity:0;translate:-20px 0}12%,80%{opacity:1;translate:0 0}}
@media(prefers-contrast:more){#board-surface .board-panel{--ink-3:var(--ink-2);backdrop-filter:none;box-shadow:none;outline:1px solid var(--ink);background:var(--slab,var(--deck,#171a28))}.board-panel *,.board-panel::after{filter:none!important;text-shadow:none!important;box-shadow:none!important}.board-panel .board-proof{text-decoration-color:currentColor;text-decoration-thickness:max(1.5px,.1em)}.board-panel .mn[data-ghost]::before,.board-fx,.board-panel .aurora{display:none}.board-panel .gauge .arc{stroke:var(--ink)!important}.board-panel .gauge .tip{fill:var(--ink);filter:none}.board-panel .gauge .segs i.on{background:var(--ink)}}
@media(forced-colors:active){#board-surface .board-panel{forced-color-adjust:none;background:Canvas!important;color:CanvasText;--ink:CanvasText;--ink-2:CanvasText;--ink-3:GrayText;--heat:Highlight;--line:GrayText;--line-2:GrayText;--unlit:GrayText;--mind:Highlight;--led:CanvasText;border:1px solid CanvasText;box-shadow:none!important;backdrop-filter:none}.board-panel *,.board-panel::after{filter:none!important;box-shadow:none!important;text-shadow:none!important;background:none!important}.board-panel .mn[data-ghost]::before,.board-fx,.board-panel .aurora{display:none}.board-panel .gauge .arc{stroke:Highlight!important}.board-panel .gauge .tip{fill:Highlight;stroke:Highlight}.board-panel .gauge .segs i.on{background:Highlight!important}.board-panel .rank,.board-panel .speed,.board-panel .num,.board-panel .iq{color:CanvasText!important;-webkit-text-fill-color:CanvasText}.board-panel .board-proof{text-decoration-color:CanvasText}.board-settings-row[aria-selected=true]{outline:1px solid Highlight}.board-settings-preview{border-color:CanvasText}}
@media(max-width:520px){.board-settings-editor{grid-template-columns:1fr}.board-settings-row{gap:8px}.board-settings-toggle span{display:none}}
.board-panel .board-ambient{position:absolute;inset:0;z-index:0;overflow:hidden;border-radius:inherit;pointer-events:none;isolation:isolate}
.board-panel .mn.board-proof{overflow:visible;text-decoration:none}
.board-panel .mn.board-proof::after{content:"";position:absolute;left:0;right:0;bottom:-.12em;border-bottom:max(1px,.1em) dotted currentColor;opacity:.7;pointer-events:none}
#board-surface[data-paused=true] .board-panel *::before,#board-surface[data-paused=true] .board-panel *::after{animation-play-state:paused!important}
#board-surface[data-idle=true] .board-panel .badge::before{animation:none!important}
#board-settings .board-settings-preview::after{content:attr(data-metrics);position:absolute;top:7px;right:4px;max-width:20px;font:600 4px/1.5 var(--mono,monospace);color:var(--preview-ink);white-space:pre;text-align:right;opacity:.7}
#board-announcement{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap;border:0}
.board-panel.neon[data-redline=true] .num{text-shadow:-1px 0 rgba(255,80,160,.45),1px 0 rgba(80,200,255,.45)}
.board-panel .board-contrast-segment{position:absolute;inset:0;width:100%;height:100%;display:none;z-index:8;pointer-events:none;color:var(--ink)}
@media(prefers-contrast:more),(forced-colors:active){.board-panel .board-contrast-segment{display:block}.board-panel .board-contrast-segment rect{animation:board-contrast-comet calc(7s - 5.4s * var(--heat-amount,0)) linear infinite}}
@media(prefers-contrast:more){.board-panel.glass[data-theme=light]{background:#fcfcff!important}.board-panel.glass[data-theme=dark]{background:#141621!important}}
@media(forced-colors:active){.board-panel .board-contrast-segment{color:Highlight}}
#board-surface[data-effects=off] .board-contrast-segment{display:none}#board-surface[data-idle=true] .board-contrast-segment rect{animation:none}
@keyframes board-contrast-comet{to{stroke-dashoffset:-1000}}

`;

export const MONITOR_BOARD_MARKUP = String.raw`
<section id="board-surface" hidden aria-label="Leaderboard" data-paused="true"><div id="board-panel-host"></div><span id="board-announcement" class="sr-only" role="status" aria-live="polite"></span></section>
<section id="board-settings" aria-labelledby="board-settings-title">
  <div class="board-settings-heading"><h3 id="board-settings-title"></h3><span id="board-settings-count" class="board-settings-count"></span><button id="board-add" type="button"></button></div>
  <div id="board-settings-list" class="board-settings-list" role="listbox"></div><p id="board-settings-empty" class="board-settings-empty"></p>
  <div id="board-settings-editor" class="board-settings-editor" hidden>
    <label><span id="board-style-label"></span><select id="board-style"><option value="glass"></option><option value="timing"></option><option value="neon"></option></select></label>
    <label><span id="board-size-label"></span><select id="board-size"><option value="small">S · 280 × 280</option><option value="medium">M · 340 × 340</option><option value="large">L · 420 × 420</option></select></label>
    <label><span id="board-scope-label"></span><select id="board-scope"></select></label>
    <fieldset><legend id="board-readouts-label"></legend><label><input id="board-showTaskScore" type="checkbox"><span id="board-iq-label"></span></label><label><input id="board-showThinking" type="checkbox"><span id="board-thinking-label"></span></label><label><input id="board-showCost" type="checkbox"><span id="board-cost-label"></span></label></fieldset>
    <p id="board-readouts-hint" class="board-settings-hint"></p>
    <fieldset><legend id="board-window-label"></legend><label><input id="board-pinned" type="checkbox"><span id="board-pin-label"></span></label><label><input id="board-clickThrough" type="checkbox"><span id="board-clickthrough-label"></span></label></fieldset>
  </div><p id="board-settings-error" class="board-settings-error" role="status"></p>
</section>
<div id="board-tooltip" class="board-tooltip" hidden role="tooltip"></div>
`;

export const MONITOR_BOARD_SCRIPT =
  MONITOR_BOARD_MODEL_SCRIPT + MONITOR_BOARD_EFFECTS_SCRIPT + MONITOR_BOARD_RENDERER_SCRIPT;

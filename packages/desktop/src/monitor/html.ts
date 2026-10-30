import { MONITOR_ORB_CSS, MONITOR_VISUALS_SCRIPT } from "./visuals.js";
import { MONITOR_RENDERER_SCRIPT } from "./renderer.js";
import { MONITOR_SELECT_PICKER_SCRIPT } from "./select-picker.js";
import { MONITOR_UI_CSS } from "./ui-styles.js";
import { MONITOR_UI_MARKUP } from "./ui-markup.js";
import { AGENT_SPEED_ATTRIBUTION, AGENT_SPEED_LICENSE } from "./attribution.js";
import { MONITOR_PERF_CSS, MONITOR_PERF_MARKUP } from "./performance-ui.js";
import { MONITOR_BOARD_CSS, MONITOR_BOARD_MARKUP } from "./board-ui.js";

// A static, sandboxed document: no renderer Node or network capability.
// Agent Speed v1.6.0's MIT-licensed original Windows design is adapted in ui-*.
// External labels and numeric log facts enter only through renderer textContent.
export const MONITOR_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-omp-local-monitor-v1'; style-src 'nonce-omp-local-monitor-v1'; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'">
<title>OMP · Agent Speed</title>
<style nonce="omp-local-monitor-v1">${MONITOR_UI_CSS}
${MONITOR_ORB_CSS}
${MONITOR_PERF_CSS}
${MONITOR_BOARD_CSS}</style></head>
<body data-surface="orb" data-appearance="light">
${MONITOR_UI_MARKUP}
${MONITOR_PERF_MARKUP}
${MONITOR_BOARD_MARKUP}
<script nonce="omp-local-monitor-v1">'use strict';
const monitorAttribution = ${JSON.stringify(AGENT_SPEED_ATTRIBUTION).replace(/</g, "\\u003c")};
const monitorLicense = ${JSON.stringify(AGENT_SPEED_LICENSE).replace(/</g, "\\u003c")};
${MONITOR_VISUALS_SCRIPT}
${MONITOR_SELECT_PICKER_SCRIPT}
${MONITOR_RENDERER_SCRIPT}
startMonitor();
</script></body></html>`;

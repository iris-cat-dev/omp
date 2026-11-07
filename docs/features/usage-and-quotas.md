# Usage, quotas, and account resets

Read native OMP totals separately from provider quotas and account credits. Configure accounts in [Models and providers](models-and-providers.md).

## Contents

- [Native OMP statistics](#native-omp-statistics)
- [Local OMP performance monitor](#local-omp-performance-monitor)
- [Zhipu Coding Plan](#zhipu-coding-plan)
- [Claude official accounts](#claude-official-accounts)
- [Codex accounts](#codex-accounts)

For the selected host, **Settings → Usage** includes native OMP `/stats`, provider quotas/balances, Codex reset cards, and Claude limit-reset controls beside the affected account. Native totals and provider quotas are never added together. Reset actions require confirmation; changing account login or order remains in **Providers**.

## Native OMP statistics

The Usage view reads OMP's native `stats.db` for the resolved host/profile, across projects rather than only Desktop-created agents. In the bundled SDK-only backend, Desktop reads an existing index: opening Usage does not build a missing index, and **Refresh** invalidates the host's cached ranges and reads the index again without invoking an OMP CLI or synchronizing transcripts. The index must already have been generated or updated by OMP's native statistics tooling. Desktop receives numeric aggregates and never exposes prompts, transcript paths, credentials, CLI output, or raw database errors. Labels/explanations follow the interface language, including Chinese.

Ranges are 1 hour, 24 hours, 7 days, 30 days, 90 days, and all indexed time. Counts, failures, input/output/cache tokens, native total tokens, and API-equivalent USD costs include provider, model, and agent-type breakdowns.

The overview uses four compact cards (requests with failures, total tokens, API-equivalent cost, and indexed transcripts), followed by the four token categories. Large headline counts are abbreviated in the interface language and headline costs use two decimal places, preserving recorded sub-cent amounts; hover, keyboard focus, or a touch tap reveals the full recorded value. The provider/model/agent selector shows one aligned breakdown at a time with exact counts and costs; narrow layouts stack the columns without hiding metrics. **Statistics & index details** is collapsed by default and contains the measurement notes and both full index timestamps. The local-monitor shortcut and separate plan-usage cards follow the overview.

**Cache hit rate** is token-weighted: `cacheRead / (uncachedInput + cacheRead + cacheWrite)`. It excludes output and provider orchestration tokens, and shows `—` when there are no input tokens rather than inventing a 0% rate. The token panel displays uncached input, output, cache read, cache write, and cache hit rate as peer columns, with labels above values; narrow layouts wrap the columns. Hover/focus or tap the rate to see its formula.

Cache-write counts preserve the native index; they are not inferred from cache hits or misses. In [OMP v18.11.3's Responses usage accounting](https://github.com/can1357/oh-my-pi/blob/v18.11.3/packages/ai/src/providers/openai-shared.ts#L494-L509), absent write counters default to zero, and DeepSeek cache misses remain uncached input rather than cache writes. A zero write count therefore does not mean caching is disabled. The cache-write label has a compact explanation; selecting **All time** can reveal historical write counts even when the current range contains none.

Interpret these values carefully:

- Native total tokens are authoritative. Provider orchestration tokens can make them differ from the four displayed conversation-token buckets.
- Indexed transcript counts are not Desktop conversation counts.
- API-equivalent USD costs are not subscription bills.
- Unpriced requests remain unknown; recorded zero cost remains zero.
- Provider quotas and current-session usage are separate.

For an explicitly configured standalone CLI backend, before an uncached read or refresh Desktop runs that configured OMP's `stats --summary` to synchronize its local index, using the same environment and profile. This performs native transcript indexing, not model requests. Refresh then invalidates the host's cached ranges. Concurrent requests share a synchronization only when their scope and invocation match. Only direct OMP commands with no prefix arguments other than `--profile` are eligible; ambiguous wrappers or other flags return scope unavailable instead of executing a possible model request. These CLI synchronization rules do not apply to the SDK-only read path.

Latest indexed-request time and index-read time are shown separately. Missing, unsupported, unreadable, failed-refresh, and timed-out sources are not shown as zero use. For the standalone CLI backend, native synchronization has a 40-second deadline with up to 2 seconds waiting for process-tree cleanup; if cleanup cannot finish, the failed flight remains reserved until the writer exits rather than starting another writer. Only a successful CLI synchronization proceeds to its numeric SQLite scan, which runs in a short-lived child with a 15-second deadline, not on the daemon event loop. SDK-only reads do not run that CLI synchronization.

## Local OMP performance monitor

On Desktop, open **OMP Local Monitor** from the system tray or **Settings → local host → Usage → Open monitor**. A real transparent floating orb has separate dashboard, history, and settings panels inside the existing Desktop runtime: no second .NET application or remote-host dashboard. Monitor counters are never added to native `/stats` or provider quotas.

The visual port follows [Agent Speed v1.6.1](https://github.com/zoefix/agent-speed/tree/384ce020cc655133e95aaad5cc085f3985f0ed99). The existing host Usage page, native `/stats`, provider quota cards, and their overall layout are unchanged.

- Five original instruments: the 36-LED gauge, needle tachometer, liquid energy, reactor, and minimal ring, with the original three sizes and dark smoked-glass/light porcelain appearances. LED/liquid retain the original effects equations; the other instruments use Canvas 2D. SVG readouts use the original alphabetic baselines, fitted tabular cells and changed-digit motion. Supplementary lines recenter the main stack only while they are actually visible.
- Static settings style previews reuse one window-lifetime thumbnail GPU pool without adopting the compact thumbnail layout: the original 64-pixel instruments, readout labels, and shaders are retained. Hidden previews stop drawing and release their per-instance leases, but the idle context/program cache survives tab switches and is disposed after the visual instances on renderer teardown. First preview creation is deferred across a paint boundary; live-orb effects and rendering quality are unchanged.
- Nine Chinese/English title ladders: vehicles, animals, Beaufort scale, cosmos, cultivation, martial arts, arcane ranks, game ranks, and engineer career. The dashboard uses the original vehicle vectors and title badges. The original editor copies/renames a ladder, changes its base, edits its fourteen labels, and supports reset/delete with eight-second undo; up to eight custom ladders persist. Output and Total have separate redlines, with the original logarithmic control and two-significant-digit rounding; redlines never cap measured numbers.
- Off/Soft/Standard/Max effects. Hidden art pauses; reduced motion retains stationary/crossfade feedback instead of moving effects. As in the original, Off disables response effects but does not suppress the independently qualified new-peak text notice.
- Up to eight independently project/profile-scoped orbs share one collector and three reusable panel types. Closing a panel leaves its orb visible. The settings orb list also manages hidden and click-through orbs.
- Windows Settings and History use standard native captions, frames, dragging and close buttons, not a second CSS title bar. Settings opens at 900 × 680 DIP (minimum 680 × 480); History at 920 × 680 (minimum 720 × 540). The pinned runtime cannot supply the original full-client Mica, so these pages use the original opaque solid fallback rather than a simulated transparent backdrop. Ordinary labels do not select text during pointer movement; licenses and text-editing controls retain selection.
- Settings keep the heading and navigation fixed while their viewport-bounded content area scrolls independently. The full martial-arts title-card caption and lower Orb controls remain reachable without shrinking the original typography or scrolling the whole window.
- Monitor and History selectors keep their original controls, options and saved values. Shared in-document lists retain the original opening/closing motion and keyboard cancellation; currency selection keeps search and current-row positioning inside the panel. History uses the original month/year/decade calendar presentation and inclusive date selection.
- Scoped live snapshots are published as one batch before window updates, avoiding a full-window broadcast for every sibling orb. Settings retain unchanged filters, currency choices and title ladders, and refresh the Cost/Data panes only when shown; incoming numeric and public-data state still stays current.
- Per-orb style, size, opacity, pinning, click-through, idle fade and nameplates. Global title themes and redlines can be inherited or explicitly overridden per orb, and clearing an override restores inheritance without copying a stale global value. The orb list supports the original scoped duplicate/show/hide/remove/merge actions and undo. Safe preferences and per-display-arrangement positions persist; project labels contain a shortened cwd hash rather than raw paths.
- Main, subagent, and advisor phases; native request duration/TTFT; 1/2/5-minute live chart ranges; today's usage; and 90-day, year and all-available-log History ranges with explicit scan/coverage limits. Output/Total token rates are selectable. Orb and dashboard money/s choices are independent and derive from the same timed requests, never daily totals divided by elapsed time.
- Full-scope or selected-inclusive-date CSV export uses an owned native save dialog, includes filter/coverage/price/rate provenance and native model/mode breakdowns, and neutralizes spreadsheet formulas in metadata. Date-range exports contain only the selected daily rows.
- CPU and memory cover identifiable native OMP executables owned by the local user/session. Node/Bun wrappers are not inferred. CPU is a percentage of total logical capacity and is unknown on the first sample; summed working sets are not unique physical memory. These counters remain machine-wide when a project filter is selected.
- Up to four local main/subagent ranking boards, with the original Glass, Timing and Neon styles and three sizes. Each board follows an existing orb's project/profile scope; groups sum their members' own live throughput, not recent reference speeds. Hiding a board preserves its configuration; removal requires confirmation. Transparent effect margins and rounded corners remain native passthrough areas.
  Exterior light follows the original finite, rounded, heat-colored bloom and fades out before the transparent window edge, rather than adding an offset black page-demo shadow. The original perimeter highlights remain; no coverage/scanning banner is added above the board.
- Original v1.6 performance scores replace task IQ. The seven weighted components are output throughput, first-content latency, action pace, thinking throughput, cache hits, tool time and tool success. Missing measurements are omitted rather than scored as zero. The geometric score has a 1,000-point reference and no upper cap.
  Each agent uses its newest 20 fully timed requests within 30 minutes; fewer than three remain unknown and three to nine are provisional. A group displays its highest live score, otherwise its highest resting score, never an average. Hover a scored row, or focus it and press Space, to open the original seven-component analysis card. Escape dismisses it without reopening on stationary hover.
  Current samples share the numeric collector's tail-first read of complete native rows, including byte-ordered tool calls/results and same-request corrections. Growing files and an unfinished trailing row no longer hide completed timed requests while full historical scans continue; historical aggregates still require their complete source scan and are never reconstructed from a partial live window.
  The analysis card is a separate native popup with a 320-DIP card, aligned to the source row beside the whole host panel. It prefers the right even when the left has more room; it switches to the left only if the right cannot fit and the left can. If neither side fits, it stays within the screen work-area inset. It uses natural content height, does not activate or accept focus, passes mouse input through natively, and has no scrolling. Only screen work-area height triggers compaction: omit component explanations first, then the bottom footnote; the shorter board never clips the card. Original appearance, crossfade and dismissal timing are retained.
- Performance history and model comparison share the selected date range and scope. Additive per-model/day statistics produce pooled component values and daily trends; pooled scores require 20 timed responses. “Vs usual” compares the same source and raw model with the 14 local days before today, excluding today.
- Thinking throughput uses reported native reasoning-token counts, not thought-text length; reasoning is a subset of output, not additional usage or cost. Unknown counters are not zero. Known zero folds after the original three-second hold.
- Original Fast/Ultrafast capsules distinguish selected service-tier evidence from recorded response evidence. Request effort comes only from supported native selected/recorded facts, with explicit unknown values and branch inheritance; unknown providers, tiers and effort are never guessed.
- Performance and thinking readouts have independent saved orb switches; performance is initially off. Disabled SVG lines are actually hidden, so a disabled score cannot overlap the remaining thinking line; enabling both retains the original two-line spacing. The needle keeps its thinking unit on the dial rather than duplicating it inside the hub. Boards have their own performance/thinking/cost switches. Existing saved score visibility is migrated without restoring the retired task analysis or prediction models.
- Performance rows retain keyboard selection, sorting and their contextual copy menu, including focus restoration on Escape. The explicit twenty-second effects preview animates the original presentation without creating usage, response or peak records.

On Windows, passthrough applies to the orb's current-process native window, not just a CSS or SDK ignore flag. It does not install a global mouse hook or a helper application. A native input failure closes the affected orb rather than leaving an input-blocking transparent rectangle.

### Measurement and coverage

The gauge and chart show **summed concurrent throughput** in the selected metric, with measured and estimated parts separate. **Output** counts output tokens only; **Total** counts `input + cacheRead + cacheWrite + output`. Reported reasoning is already a subset of output and is never added again. The provider's orchestration-inclusive `usage.totalTokens` is not substituted into this four-bucket Total rate; native `/stats` keeps its separate authoritative accounting.

The measured part uses completed OMP JSONL token counts and native request duration, distributes them over the recorded request interval, and averages the last three seconds; it is not a per-token streaming measurement. Request-average output speed is measured output divided by summed request durations, including TTFT but excluding tool execution. OMP writes completed messages, so in-flight speed is estimated from recent measurements. Like the original, speed readouts have **no approximation prefix**; chart styling, the estimate legend, and hover/accessibility explanations distinguish estimates. Missing native duration stays unknown; failed/aborted partial usage contributes to totals but not measured speed, and side calls contribute to usage only. Estimates stop in tools/idle phases, and completed output leaves the live window within three seconds. Response/peak effects require fresh qualifying output completions, even when Total is selected; loading, scope changes, replay/backfill, input-only peaks and estimated-only spikes do not celebrate. The measured-peak time and completion time used for event freshness are separate.

The recent-agent window is ten minutes of business activity, not transcript-file modification time. Internal eval-state snapshots, session exits and passive metadata/settings records do not refresh it. Exit records still stop generation and clear tool state; user input, tool execution and waiting for the next model output remain visible even at zero throughput. A board's “more recent groups” row counts omitted root-session groups and their summed live speed, not additional running agents.

Discovery reads only OMP's default/environment-selected session root and named profiles. It skips links, hidden staging files, and other applications. New/active files take priority over historical backfill. For a recently modified file larger than one per-file poll allowance, the collector probes the normal session header and reads a bounded one-MiB tail window first, then follows appends; a disjoint cursor continues the older prefix under the same total poll budgets. The split is at a complete line boundary, requests remain deduplicated across revisions, and prefix backfill cannot roll back current agent activity or tool state. The initial tail is catchup, not a new live response: its numeric facts can immediately show measured throughput, but only subsequent actual appends qualify for response feedback. Already-read live facts remain available with **partial coverage** while older files catch up; a pending history scan does not hide measured/estimated tok/s or claim complete totals. Limits are explicit: 20,000 files, 100,000 numeric candidates, 256 displayed agents, 32-MiB lines/pending fragments, and bounded per-poll work; files over 256 MiB retain the existing limited 64-MiB tail policy instead of expanding to a full history scan. Very large/incomplete individual lines remain subject to those bounds, not invented measurements. Scanning/partial coverage is always reported. Missing or failed sources show unknown metrics rather than successful zero use. An existing empty directory can correctly report zero.

This is not a persistent billing ledger: deleted, rotated, compressed, inaccessible, or out-of-scope logs are not reconstructed. Native `/stats` retains its separate indexed-history role. Copied/replayed requests are deduplicated; replacements, title rewrites, tool gaps, stale activity, and local-day boundaries are handled without retaining conversation text.

During split scans, bounded hashed tool identities and physical line positions reconcile results found before their prefix calls; an older prefix cannot override a newer phase. A response line that finishes beyond the original EOF is a real append even when the prefix cursor completes it. Replaying the same completion facts preserves their original feedback eligibility rather than creating a response/peak event; genuine completion revisions remain distinguishable from replay or billing-only corrections. None of this reconciliation retains message text.

Performance history uses an independent bounded ordered reader for completion and tool-call timing, rather than applying the numeric tail-first fast path to out-of-order actions. Its fair scan covers the same available local sources and calendar dates. Scanning and coverage limits remain explicit. Cached records contain only whitelisted numeric sufficient statistics, safe model labels and opaque source ownership, not prompts, commands, file contents or raw action identifiers.

### Public prices, currency conversion, and privacy

Recorded OMP USD amounts and **current-catalog API-list estimates** are separate. Unknown models/tiers remain unpriced; known zero remains zero. Catalog updates may reprice the available-log history at current public pricing rules, not historical invoice prices. Currency conversion never overwrites either USD value.

The monitor bundles Agent Speed's v3 public catalog dated 2026-10-28, including GPT-6.1 Terra and the MiMo-V2.6 variants, and 38 CC0 fallback currencies. Optional anonymous HTTPS GET updates use the same fixed resources for every user: Agent Speed's GitHub raw price table (jsDelivr fallback), and USD-based public exchange rates from ExchangeRate-API, currency-api mirrors, and Frankfurter. No model names, chosen currency, logs, credentials, or usage are included in requests; the public servers still see the usual IP address and request time. ExchangeRate-API attribution is displayed when used.

The global **Allow public-data updates** permission applies to manual and scheduled requests; automatic synchronization is a separate saved choice. Disabling permission aborts in-flight downloads, while disabling automatic synchronization still permits an explicit update when network permission is enabled. Slow FX requests do not block settings commands. Launch delays, daily synchronization, failure backoff, strict HTTPS/no-redirect policy, body/schema limits, monotonic version/date checks, and per-currency rate provenance protect cached data. Errors keep last-good values with their real dates. Corrupt permission/source settings fail closed. Safe preferences and public data are cached under Desktop user data's `local-monitor` directory.

The renderer is sandboxed with no network or Node access. Only numeric facts and safe metadata reach it; prompts, message bodies, credentials, and raw transcript paths do not. Performance collection extracts native request/tool timing, counts and fixed outcome flags, discarding raw log lines without task-text grading. Opening is restricted to registered application main frames, and each surface's IPC requires its exact authenticated main frame. Only Settings selects another existing orb; each board can edit only its own configuration. The collector starts on demand, polls less often when every surface is hidden/minimized, and stops when no monitor surfaces remain. No other-app adapters, unpriced-diagnostics feature, usage telemetry/WebSocket reporting, online rankings, device accounts, privileged traffic service, or taskbar hooks are included. Agent Speed and Ashima Arts / Stefan Gustavson MIT notices and the full license are available in About.

Settings exposes the original source enable/folder/reset controls; explicitly injected roots never fall back to a user's default transcripts. Settings close flushes title drafts before allowing the native close, and closing the last orb, closing all surfaces, quitting or installing an update waits for acknowledged queued settings writes and worker shutdown. A failed durable save vetoes that transition and retains the editor/worker for explicit recovery, rather than reporting success or destroying unsaved input. Corrupt-setting recovery preserves an exclusive evidence copy before atomic replacement.

## Zhipu Coding Plan

Built-in `zhipu-coding-plan` reuses keys saved through OMP sign-in. Each enabled stored key has its own labeled usage entry, so a rejected key cannot hide another key's quota. No `models.yml` entry is needed for built-in usage.

For a custom China Zhipu provider, configure `baseUrl` (for example `https://open.bigmodel.cn/api/coding/paas/v4`) and `apiKey` in OMP's `models.yml`; Desktop retains its custom name. The sidebar, active-model context tooltip, and Host Settings Usage display reported five-hour, weekly (when present), and MCP/tool-call windows. Both `TOKENS_LIMIT` and `CREDIT_LIMIT` responses are supported.

Zhipu percentages mean **used quota**. Missing percentages stay unknown, not unused, and reset times appear only when returned by the service. Desktop sends the raw API key only to the China service's official-plugin monitor endpoint on `https://open.bigmodel.cn`, without following redirects. This does not support the separate `api.z.ai` service or arbitrary OpenAI-compatible `/v1/usage` endpoints. Lookup failures neither change model availability nor interrupt inference.

## Claude official accounts

OMP's built-in `anthropic` sign-ins have individual entries under **Host Settings → Model providers → Signed-in providers** and host **Usage**. **Claude usage** in the mobile/desktop composer opens the sheet even before context-token data exists. Reopening it or choosing **Refresh** requests fresh server usage.

When a session identifies its selected credential, usage is isolated to that account. Otherwise the sheet explains the missing session account and lists signed-in accounts with their own labels/quotas. It never guesses the active account or merges percentages; account names, notes, and order are unchanged.

### Quota windows and failure states

Five-hour and overall weekly percentages mean **remaining quota**. Model-specific weekly windows appear only when Anthropic reports them; unknown names retain their original identifier rather than guessed Opus/Sonnet labels. Reset dates include timezones. Compact countdown deadlines request new server usage instead of declaring a local reset. Missing percentages/dates remain unknown.

The five-hour row stays visible when usage is unavailable or only a reached flag is known, with no fabricated progress bar. Authentication, network, timeout, invalid-response, and HTTP failures are distinct. An OAuth usage-query retry deadline is not a quota reset.

The daemon retains model-request restrictions for the actual enabled OAuth account across sessions and failed usage reads:

- A generic model 429 is an unknown-window restriction. Five-hour attribution needs explicit native window evidence or a fresh exhausted five-hour observation for the same account.
- Older in-flight reads cannot clear newer restrictions. Deadlines trigger server rechecks, not local recovery claims.
- Fresh matching quota data may confirm recovery of a known window. Unknown-window throttling requires a successful model response for that account.
- Desktop never sends a model request or redeems a reset automatically to probe recovery.

These observations are daemon-local memory, not billing records; restart requires fresh server evidence.

### Extra usage and request privacy

Account and Usage views display read-only **extra usage** status, reported spending, and monthly cap when supplied. OAuth amounts reported in USD cents are converted to dollars. Missing spending is not zero; missing cap is not unlimited. Explicit non-USD or unknown currencies are not labeled USD.

Extra usage is [billed separately from subscription](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) and managed at [Claude Settings → Usage](https://claude.ai/settings/usage), not purchased or enabled in Desktop.

Quota reads use Anthropic's undocumented OAuth `/api/oauth/usage?cedar_ember=1`, including reset inventory, and optionally `/api/oauth/profile` for plan metadata. Requests reuse OMP's proxy, bound both request and response-body read, and never follow redirects. Profile failure does not discard retrieved usage. Authorization/service errors expose no credentials, refresh no tokens, and do not modify saved accounts.

### Official limit resets

Claude's [official limit resets](https://support.claude.com/en/articles/17007452-what-is-a-limit-reset), occasionally granted to eligible plans, are distinct from paid extra usage and Codex reset cards. Signed-in provider settings show each account's reported grants, remaining uses, start/expiry, cleared windows, and eligibility. Held uses do not imply redeemability: expired, future, paused, exhausted, cooldown-blocked, or otherwise unusable grants cannot be consumed. Unknown inventory is not zero.

Redemption requires explicit irreversible confirmation naming account, grant, and affected windows. The daemon checks fresh inventory, binds the request to the enabled Claude OAuth account and organization, serializes concurrent redemption per account, and sends one native `POST /api/organizations/{organizationUuid}/reset_rate_limits`. This OAuth contract and client-identification header were checked against first-party Claude CLI **2.1.296**; these endpoints are not a stable public API.

After an attempted redemption, quota and inventory refresh. HTTP 200 alone is not success; non-reset and uncertain outcomes remain distinct. Mutations are not automatically retried. An explicit retry of an uncertain request reuses its native-valid redemption ID rather than creating another intent. Hosts lacking `ompClaudeLimitResets` disable redemption and show update guidance. Grants neither enable paid extra usage nor refund prior spending.

Claude accounts do not show Codex reset actions or subscription-expiry controls. Desktop does not infer a subscription end date from token expiry, subscription creation, grant expiry, or quota reset.

## Codex accounts

### Quota and credits

**Host Settings → Model providers → Signed-in providers** shows each Codex account's five-hour and weekly windows. Windows are identified by reported duration; missing durations retain legacy plan/window mapping. A five-hour window appears only if usage or reset time is reported, including for Pro.

Percentages mean **remaining quota**; unknown is not 100% remaining. Context tooltips list labeled accounts instead of guessing from provider namespace. Settings/sidebar show live compact countdowns such as `3d21h` and `2h12min`; deadlines trigger server refresh and an awaiting-refresh state, never assumed recovery.

**Credits** in host Usage and provider account details preserve the authenticated API's exact decimal balance string without rounding or interpreting it as currency, or display the reported unlimited/disabled state. Missing balances are unavailable, not zero. Credits, five-hour/weekly quota, and banked reset cards are separate. Desktop neither infers a currency nor scrapes ChatGPT browser cookies.

### Failed refreshes and recovery

When a Codex usage query fails, Desktop keeps the last successful usage for that actual account and labels it **Last query result** with the successful observation time and the latest refresh failure. Retained percentages use muted bars; an old exhausted observation is not presented as freshly confirmed exhaustion. Accounts without a successful observation stay unknown. Authentication failures show a login warning and clear retained usage.

Network errors, timeouts, query HTTP 429, authentication, other HTTP failures, and malformed responses have distinct messages. A usage-query 429 is separate from an actual returned exhausted quota; its Retry-After deadline is not a quota reset. Credit balances and reset-card inventories are always from the current attempt, never restored from usage history.

Visible quota views share at most two accelerated recovery checks: after 30 seconds, then 60 seconds. Continued failures return to the normal five-minute polling interval; successful recovery rearms the short checks for a later failure. Server Retry-After deadlines take precedence. **Refresh** in host Usage or provider settings requests new data without waiting for the cache to expire. The 750-ms cold-start follow-up applies only when account quota has not arrived, not to an already classified query failure.

Successful usage is daemon-local memory and is lost on restart. History is isolated by database/profile, provider, credential and actual account identity, survives token renewal when identity is known, and is invalidated by credential removal/replacement or a confirmed reset. Superseded in-flight reads cannot restore pre-reset usage.

### Reset cards

Each account lists banked cards, server-reported available count, status, and timezone-qualified grant/expiry timestamps. **Use reset card** requires confirmation of account, card, and applicable windows. Only available, unexpired `codex_rate_limits` cards can be submitted.

The daemon rechecks with OpenAI before consumption and preserves the redemption request ID so duplicate submissions do not intentionally spend another card. A confirmed server result refreshes both cards and quota. Errors and already-redeemed/nothing-to-reset outcomes are not reported as successful resets. Older daemons cannot consume cards.

**Automatically use reset cards** controls the native `codexResets.autoRedeem` policy for all Codex accounts in the selected host profile. The switch writes `yes` or `no` to that profile's global OMP configuration, not an account or Desktop preference. Existing native project, overlay, and runtime overrides retain their precedence over the global value.

- **Enabled (`yes`)**: eligible automatic redemptions do not require confirmation.
- **Disabled (`no`)**: no automatic spending, including expiring cards; manual **Use reset card** remains available.
- **Not configured (`unset`)**: retains native consent behavior. Without a prompt UI, cards expiring within five minutes may still be spent; explicitly turn the switch off to disable that path too.

Saving or loading errors remain visible; the switch does not report success before the host acknowledges persistence. Older hosts show the control disabled. Running Node SDK sessions watch configuration changes and recheck the policy after pending consent and immediately before automatic redemption. Disabling cannot recall a redemption already sent to OpenAI.

### Account metadata

Desktop retains the reported plan name, quotas, reset countdowns, credits, and reset cards, but does not display or query subscription expiry or remaining subscription duration. The current official sign-in does not provide a reliable subscription-date API; the dedicated token-claim parser and account lookup have been removed ([#73](https://github.com/iris-cat-dev/omp/issues/73)).

Quota refresh requests only usage and reset-card inventory. Subscription dates are not inferred from OAuth expiration, quota reset times, subscription creation, or local estimates. This removal neither changes login state nor treats an unknown expiry as an absent or expired subscription. Check ChatGPT billing settings for billing dates.

For wire compatibility, new daemons omit the retired optional `quota.subscription` field, which older clients already accept as absent. New clients ignore that field from older daemons under the existing unknown-key stripping rules, without discarding quota or reset-card data.

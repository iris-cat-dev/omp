# Usage, quotas, and account resets

Read native OMP totals separately from provider quotas and account credits. Configure accounts in [Models and providers](models-and-providers.md).

## Contents

- [Current conversation](#current-conversation)
- [Native OMP statistics](#native-omp-statistics)
- [Agent Speed local monitor](https://github.com/iris-cat-dev/omp-plugins/blob/main/agent-speed/README.md)
- [Custom provider balances](#custom-provider-balances)
- [Cursor accounts](#cursor-accounts)
- [Zhipu Coding Plan](#zhipu-coding-plan)
- [Claude official accounts](#claude-official-accounts)
- [Codex accounts](#codex-accounts)

For the selected host, **Settings → Usage** includes native OMP `/stats`, provider quotas/balances, Codex reset cards, and Claude limit-reset controls beside the affected account. Native totals and provider quotas are never added together. Reset actions require confirmation; changing account login or order remains in **Providers**.

## Current conversation

Open the percentage ring in the composer to see three things at a glance: how full the context window is, how often this session reused cached input, and how much quota the account has left. The gauge, cache, and wallet icons distinguish these readings. Select **Session cache** to see exact token reads and writes, the reported session cost, and compaction rounds. Select an account heading with a chevron for its additional quota windows, reset times, and full credit balance when available. Quota warnings stay visible without expanding anything. Claude's usage sheet uses the same summaries.

For example, 250 tokens read from cache, 50 written, and 100 uncached input tokens give a hit rate of **62.5%** (`250 / 400`). Output tokens do not enter the calculation. A reported zero is shown as zero; a missing counter or a rate with no input is shown as `—`. If the host reports neither cache counter, the cache breakdown is omitted. The figures follow the SDK's restored session state, so switching branches or compacting can change them. They do not come from the last turn or the host-wide Usage page.

Cache writes require the updated backend and renderer; restart previously loaded session hosts to pick up the backend. No new SDK build is required for cache reporting.

The session's **compaction rounds** count persisted compaction records on the current native branch, including older compacted history, and restore on resume. Automatic and manual compactions count equally; loading, canceled, failed, and skipped attempts do not add a round. A new session reports zero, while hosts that do not provide the counter omit it. Rebuild the SDK, backend, and renderer, then restart the backend and session hosts to enable compaction reporting. Reloading only the renderer does not recover a counter omitted from an older backend's session snapshot.

## Native OMP statistics

The Usage view synchronizes OMP's native `stats.db` for the resolved host/profile before reading totals, across projects rather than only Desktop-created agents. The bundled SDK backend runs its native statistics activity worker in a short-lived Node child: opening Usage builds a missing index, and **Refresh** invalidates cached ranges, ingests new or appended session logs, then reads the index. It does not invoke an external OMP CLI or make model requests. Desktop receives numeric aggregates and never exposes prompts, transcript paths, credentials, worker/CLI output, or raw database errors. Labels/explanations follow the interface language, including Chinese.

An explicitly selected default profile stays isolated from another profile's legacy `PI_PROFILE`/`PI_CODING_AGENT_DIR` values in `.env`. Default-profile custom agent directories and migrated XDG locations retain their native scope.

Ranges are 1 hour, 24 hours, 7 days, 30 days, 90 days, and all indexed time. Counts, failures, input/output/cache tokens, native total tokens, and API-equivalent USD costs include provider, model, and agent-type breakdowns.

The overview uses four compact cards (requests with failures, total tokens, API-equivalent cost, and indexed transcripts), followed by the four token categories. Large headline counts are abbreviated in the interface language and headline costs use two decimal places, preserving recorded sub-cent amounts; hover, keyboard focus, or a touch tap reveals the full recorded value. The provider/model/agent selector shows one aligned breakdown at a time with exact counts and costs; narrow layouts stack the columns without hiding metrics. **Statistics & index details** is collapsed by default and contains the measurement notes and both full index timestamps. Separate plan-usage cards follow the overview.

**Cache hit rate** is token-weighted: `cacheRead / (uncachedInput + cacheRead + cacheWrite)`. It excludes output and provider orchestration tokens, and shows `—` when there are no input tokens rather than inventing a 0% rate. The token panel displays uncached input, output, cache read, cache write, and cache hit rate as peer columns, with labels above values; narrow layouts wrap the columns. Hover/focus or tap the rate to see its formula.

Cache-write counts preserve the native index; they are not inferred from cache hits or misses. In [OMP v18.11.3's Responses usage accounting](https://github.com/can1357/oh-my-pi/blob/v18.11.3/packages/ai/src/providers/openai-shared.ts#L494-L509), absent write counters default to zero, and DeepSeek cache misses remain uncached input rather than cache writes. A zero write count therefore does not mean caching is disabled. The cache-write label has a compact explanation; selecting **All time** can reveal historical write counts even when the current range contains none.

Interpret these values carefully:

- Native total tokens are authoritative. Provider orchestration tokens can make them differ from the four displayed conversation-token buckets.
- Indexed transcript counts are not Desktop conversation counts.
- API-equivalent USD costs are not subscription bills.
- Unpriced requests remain unknown; recorded zero cost remains zero.
- Provider quotas and current-session usage are separate.

For an explicitly configured standalone CLI backend, before an uncached read or refresh Desktop runs that configured OMP's `stats --summary` to synchronize its local index, using the same environment and profile. This performs native transcript indexing, not model requests. Concurrent requests share a synchronization only when their scope and invocation match, for both SDK and CLI backends. Only direct OMP CLI commands with no prefix arguments other than `--profile` are eligible; ambiguous wrappers or other flags return scope unavailable instead of executing a possible model request.

Latest indexed-request time and index-read time are shown separately. Missing, unsupported, unreadable, failed-refresh, and timed-out sources are not shown as zero use. Native synchronization has a 40-second deadline with up to 2 seconds waiting for process-tree cleanup; if cleanup cannot finish, the failed flight remains reserved until the writer exits rather than starting another writer. SDK synchronization requires the worker's explicit completion message and confirmed worker exit; an early clean exit is still a failed refresh. Only successful synchronization proceeds to the numeric SQLite scan, which runs in a short-lived child with a 15-second deadline, not on the daemon event loop.

## Local OMP performance monitor

The optional monitor's installation, floating orbs, dashboard, history, measurements, pricing, privacy, settings, and storage lifecycle are maintained in the [Agent Speed plugin guide](https://github.com/iris-cat-dev/omp-plugins/blob/main/agent-speed/README.md). Platform-specific checks and their qualification limits are in [native regression instructions](https://github.com/iris-cat-dev/omp-plugins/blob/main/agent-speed/native-regression.md).

## Custom provider balances

Expand the sidebar's provider details to see balances from custom `/v1/usage` providers, including Sub2API services such as MintCat. The first request shows a loading message immediately. Background refreshes keep the existing balance visible with a **Refreshing** message; request failures also remain visible.

Balance queries share a five-minute frontend cache per host and provider, including across new conversations. Refreshing is on demand, not periodic polling; opening a new conversation within the cache period reuses the existing result, while explicit **Refresh** bypasses both client and server five-minute caches and OMP login/logout or daemon configuration updates invalidate cached quota results.

The official `https://api.openai.com` API does not provide a stable public balance
query using an ordinary model-call API key. Desktop skips `/v1/usage` for that
origin and shows **Balance query unsupported** in the sidebar, context tooltip,
and Usage card, with links to [OpenAI billing](https://platform.openai.com/settings/organization/billing/overview)
and [OpenAI usage](https://platform.openai.com/usage). This is neither a zero
balance nor an invalid-key/model-availability result. Organization Usage and
Costs APIs require separate Admin credentials; consumed cost is not remaining
balance. Do not put an Admin key in the model-key field. Third-party providers
that implement the existing `/v1/usage` contract still return balances normally,
and genuine request failures remain distinct and credential-redacted.

## Cursor accounts

Cursor quota lookups discover credentials read-only from `CURSOR_ACCESS_TOKEN`/`CURSOR_TOKEN`, OMP's `agent.db` (`provider = 'cursor'`, trying non-expired tokens first and labeling multi-account entries individually), readable desktop `state.vscdb` tokens, and `~/.config/cursor/auth.json`. Encrypted Electron `safeStorage` payloads prefixed with `cursor-safe-` are ignored without triggering Keychain prompts or sending invalid Bearer requests, and read-only quota checks never rotate refresh tokens or write to `agent.db`.

When a Cursor JWT provides a user subject, Desktop queries `https://cursor.com/api/usage-summary` first (supplemented by `GetPlanInfo` for unified weekly plans), falling back through `GetCurrentPeriodUsage`, `GetTeams`/`GetTeamSpend` (with `GetMe` email resolution), and `/auth/usage` when needed. When no usable token is available, the sidebar shows empty-state guidance instead of a generic load error.

## Zhipu Coding Plan

Built-in `zhipu-coding-plan` reuses keys saved through OMP sign-in. Each enabled stored key has its own labeled usage entry, so a rejected key cannot hide another key's quota. No `models.yml` entry is needed for built-in usage.

For a custom China Zhipu provider, configure `baseUrl` (for example `https://open.bigmodel.cn/api/coding/paas/v4`) and `apiKey` in OMP's `models.yml`; Desktop retains its custom name. The sidebar, active-model context tooltip, and Host Settings Usage display reported five-hour, weekly (when present), and MCP/tool-call windows. Both `TOKENS_LIMIT` and `CREDIT_LIMIT` responses are supported.

Zhipu percentages mean **used quota**. Missing percentages stay unknown, not unused, and reset times appear only when returned by the service. Desktop sends the raw API key only to the China service's official-plugin monitor endpoint on `https://open.bigmodel.cn`, without following redirects. This does not support the separate `api.z.ai` service or arbitrary OpenAI-compatible `/v1/usage` endpoints. Lookup failures neither change model availability nor interrupt inference.

## Claude official accounts

Under **Host Settings → Model connections**, open **Manage** on the Anthropic connection to see its individual sign-in accounts. The host **Usage** page also lists them. **Claude usage** in the mobile/desktop composer opens the sheet even before context-token data exists. Reopening it or choosing **Refresh** requests fresh server usage.

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

Open the account's usage details to see its five-hour and weekly windows. In **Host Settings → Model connections**, use **Manage** on the Codex connection to find its accounts. Windows are identified by reported duration; missing durations retain legacy plan/window mapping. A five-hour window appears only if usage or reset time is reported, including for Pro.

Percentages mean **remaining quota**; unknown is not 100% remaining. Context tooltips list labeled accounts instead of guessing from provider namespace. Settings/sidebar show live compact countdowns such as `3d21h` and `2h12min`; deadlines trigger server refresh and an awaiting-refresh state, never assumed recovery.

In **Automatic** mode, the active conversation's account label and associated
quota follow the credential reported by each actual model request, including
tool-use continuations after automatic rotation. While a new request's identity
is unknown, Desktop shows **Determining the account for this response…** rather
than retaining the previous account or its quota. This display does not change
automatic selection or manual pin policy; older snapshots and late messages
cannot replace newer request identity. Load the updated backend and renderer
and restart loaded session hosts to apply the fix; no SDK update or history
deletion is required.

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

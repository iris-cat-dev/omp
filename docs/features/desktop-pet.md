# Desktop pet

Show a local companion, follow task status, and create or import validated custom pets. This feature is available only in the Electron app; for wallpaper and theme settings see [Appearance](appearance.md).

## Contents

- [Enable and interact](#enable-and-interact)
- [Task status and freshness](#task-status-and-freshness)
- [Iris animation](#iris-animation)
- [Create and import pets](#create-and-import-pets)
- [Independent custom bubbles](#independent-custom-bubbles)

## Enable and interact

Open **Settings → Plugins → Desktop pet** to configure Iris, the built-in pink fluffy kitten. Enable the installation to show it in a separate transparent always-on-top window; it is off by default. Size, library, import/refresh, and creation settings remain available while disabled. Disabling preserves configuration, the creation draft, and model selection.

Pet packages, selection, visibility, size, and position are local to this computer. A phone/tablet connected to its daemon receives neither pet assets nor overlay state. The authoring conversation is an ordinary OMP conversation, not an asset-sync channel.

On macOS, enabling does not activate the pet window or steal keyboard focus. It remains visible across Spaces, including fullscreen apps. On launch, an enabled pet waits for initial service startup and restoration of main-interface appearance, saved layout, and navigation. Offline, disabled-daemon-management, and startup-error screens also satisfy readiness. Pre-readiness changes use the latest settings; disabling prevents a startup flash.

- **Drag** the kitten to move it; dragging starts at 4 logical screen pixels of movement. Position, size, selection, and visibility persist locally. Transparent space passes mouse input through to other apps.
- **Click** the kitten to pet it, showing a happy pose, soft squash/rebound, and floating hearts. Dragging does not pet it.
- **Click the status bubble** to restore OMP and open the task needing attention, or simply open the app when nothing is pending.
- **Right-click** to hide or reset position. Minimizing OMP does not hide it. Quitting detaches only after in-flight activity publications settle, then follows existing desktop/daemon shutdown settings.

The status bubble stays near the upper-left and scales with the pet. Its nearest corner stays anchored as captions/counts change; long captions grow left and ellipsize within available space. Main-window zoom does not scale the pet. Viewport changes refresh layout and pointer hit bounds.

## Task status and freshness

Only main conversations contribute status, counts, menus, and click targets. Subagents are excluded even with missing parents or different workspaces; independent main conversations sharing one workspace remain separate tasks.

Task names follow workspace tabs: primary conversations use renamed workspace titles, while other independent conversations retain their own names. Renames refresh immediately without new activity. Native context menus shorten names after 20 displayed characters and add an ellipsis without splitting composed characters or altering the full title/click target.

Connected hosts supply real task state. Permissions outrank errors, unread completions, and running work. Neither task state nor animation triggers model calls.

On daemons supporting directory revisions, completed directory reads determine freshness, not window arrival order. Older reports cannot restore acknowledged/archived tasks. Identity is host plus conversation, not a shared workspace entry. Closing a publishing window does not discard known pending work while another window remains connected to that host.

## Iris animation

While the highest-priority task runs, Iris displays a random five-second work caption every 30–60 seconds:

- `智商变高了！`
- `不想上班...`
- `大佬！`
- `wooo！wow！`
- `Tibo什么时候重置...`

The two complaints use a wistful working face, the other three a happy face, without changing task status. Captions stop as soon as work ends, a higher-priority task needs attention, the host disconnects, or the pet is dragged/petted. Idle/non-running tasks never cause captions. Custom pets are unchanged. Reduced motion keeps the selected expression static.

Iris has six registered 24-frame, 12-fps action sequences with continuous local breathing/sway. Idle actions run two seconds and rest six; waiting/completed/blocked states also pause quietly. Working/carried loops continue outside temporary reactions. Only the working face remains wistful; others are relaxed/happy. Blinks use short tapered eyelids. System reduced-motion preference keeps the pose static.

## Create and import pets

**Create with OMP** opens an independent local authoring workspace and normal OMP conversation with selected model, Thinking, and approval mode. Model/mode/thinking/feature selections are local to authoring, not defaults for ordinary conversations. Describe the pet in Settings or attach references in chat.

The bundled `hatch-pet` skill uses the [configured image-generation tool](tools-and-plugins.md#image-generation-with-references), creates a coherent transparent animation atlas, a complete per-pet bubble profile, and `pet.json`, then runs its generated install helper. The helper rejects new image-based authoring without that complete profile before conversion. Windows uses bundled Electron, not global Node. The headless converter does not perform GUI quit cleanup or stop an existing daemon. Creation uses your configured image model; ordinary animation and dialogue do not.

After installation, **Refresh** and select the new pet. **Import folder** accepts completed packages. Imports contain only a validated manifest and transparent PNG data, never executable scripts or HTML. Images are limited to **20 MiB** and **4096 × 4096** pixels. Built-in Iris and existing custom packages are not replaced.

The skill's default 1536 × 1024 atlas uses 128 × 128 cells and twelve frames per action; the built-in 3840 × 960 atlas instead uses 160 × 160 cells and twenty-four frames. Both are supported. The actual image and manifest must describe the same grid. The installer converts image format/background but does not resize, retile, or invent frames; contact-sheet and motion-preview inspection remain necessary to catch visual fragments or inconsistent poses.

## Independent custom bubbles

Each newly authored pet supplies its own `bubble.appearance` and all eight `bubble.states`: `idle`, `offline`, `running`, `needs_input`, `ready`, `blocked`, `dragging`, and `petted`. See the [hatch-pet manifest example](../../skills/hatch-pet/SKILL.md) for the full schema.

- Appearance controls colors, speech/rounded/thought shape, typography, padding, corner radius, maximum width, and fade/pop/no entry animation. Layout stays within the companion viewport; reduced-motion preferences disable entry motion.
- Each state owns plain-text messages, initial delay, visible duration, and delay before repetition. An empty message list explicitly means silence; it never falls back to Iris's dialogue.
- Duration zero persists until a real state/event change. Repeat delay zero means no repetition. Petting is a one-shot event and cannot repeat; a timed response can outlast the physical gesture. Dragging and relevant task changes interrupt stale responses.
- Unchanged activity snapshots, task renames, and secondary-task updates do not restart the current message clock. The real highest-priority task still controls attention and click targets; persona text does not change task status.

Profiles are bounded, strictly validated data: hex colors and enumerated style choices, not executable CSS, HTML, scripts, or model-call instructions. Runtime dialogue is local and makes no API requests. Built-in Iris and existing imported version-1 packages without profiles retain their prior behavior without rewriting stored packages. Existing authoring workspaces keep their copied skill; open a new **Create with OMP** workspace to use the updated instructions.

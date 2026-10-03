# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Project Overview

`@dsh-external/dsh-vibe-island` (DSH VibeIsland) is an external plugin for DeepSeek Harness (DSH). It provides a real-time status bar ("Dynamic Island") at the top of the interface, displaying agent thinking states, tool calls, and subagent progress across macOS (physical notch fitting) and Windows (Fluent acrylic pill).

## Development & Verification Commands

This repository does not use a build step or bundling pipeline; code is written in vanilla ES modules directly consumed by the DeepSeek Harness runtime.

- **Syntax check**:
  ```bash
  node -c lib/index.js lib/client.js
  ```
- **Run the test suite** (pure Node, no dependencies — it reads `lib/client.js` as text and executes the ModuleLoader factory against a stubbed DOM):
  ```bash
  node test/run.mjs all              # all Node suites (112 assertions)
  node test/run.mjs parse            # parseActivityFromEvents state machine + cursor isolation
  node test/run.mjs apply            # apply() mount, slot registration, error tolerance
  node test/run.mjs subagent         # countActiveSubagents + dead-config regression
  node test/run.mjs perf             # cursor cache hit vs miss
  node test/run.mjs degradation      # long-session scaling + O(1) proof (group E)
  ```
  `test/harness.mjs` is the shared bootstrap: it stubs `window.__ModuleLoader__` and `document`, executes `client.js`, and exposes the factory result as `globalThis.__mod`. `test-apply.mjs` and `test-subagent.mjs` are self-contained and do not need it.
- **Browser rendering verification** (drives the installed Edge/Chrome over CDP; asserts real computed styles and writes screenshots to `test/.tmp/`):
  ```bash
  node test/render-verify.mjs
  ```
  It extracts the live `CSS_STYLES` out of `lib/client.js`, loads it in a real browser together with a component tree that mirrors the production `h()` calls, then asserts computed geometry, border radii, `backdrop-filter`, state colours and the subagent badge. This is the only way to catch CSS-level regressions — the Node suites stub the DOM and cannot see styling.
- **Manifest validation**:
  ```bash
  node -e 'JSON.parse(require("fs").readFileSync("dsh.plugin.json")); JSON.parse(require("fs").readFileSync("package.json")); console.log("JSON valid");'
  ```
- **Local dependency resolution caveat**: `@deepseek-ai/schemastery` declares `@deepseek-ai/cosmokit` as a dependency, but the installed package is a fork named `cosmokit` at the top level of `node_modules`. `lib/index.js` therefore cannot be imported directly from this working directory — it only resolves when placed inside a DSH profile. To exercise the server schema locally, create the scope alias first:
  ```bash
  ln -sfn ../cosmokit ~/.dsh/profiles/web/node_modules/@deepseek-ai/cosmokit
  ```
- **Deploy to local DSH profile for manual testing**:
  ```bash
  # Desktop profile
  cp -r . ~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-vibe-island
  
  # Web profile
  cp -r . ~/.dsh/profiles/web/node_modules/@dsh-external/dsh-vibe-island
  ```
- **Package plugin archive**:
  ```bash
  zip -r dsh-vibe-island.zip . -x ".*" -x "__MACOSX"
  ```

## Architecture & Code Structure

The plugin operates across two runtimes within DeepSeek Harness:

```text
deepisland/
├── dsh.plugin.json          # DSH plugin manifest (id: dsh-vibe-island, main: ./lib/index.js)
├── cordis.patch.yml         # Cordis plugin stack insertion patch
├── package.json             # ES module exports, dsh bundle patch & client inject metadata
├── lib/
│   ├── index.js             # Server-side Cordis plugin (settings namespace registration)
│   └── client.js            # Client-side bundle (DOM injection, UI components, event parser)
├── test/                    # Dependency-free Node test suite (see Commands above)
└── README.md                # Project documentation and import instructions
```

### 1. Server Plugin (`lib/index.js`)
- Runs in the DSH Cordis host environment.
- Injects `settings` service and registers the `dsh-vibe-island` namespace using `@deepseek-ai/schemastery` schema definitions.
- Configurable settings:
  - `enabled` (boolean, default: `true`): Master visibility toggle.
  - `placement` (`'notch'` | `'floating'` | `'top-right'`): Positioning mode.
  - `platformMode` (`'auto'` | `'macos'` | `'windows'`): Visual styling mode.
  - `glowEffect` (boolean, default: `true`): Aura pulse on thinking/tool execution.
  - `expandOnHover` (boolean, default: `true`): Expand HUD console on mouse hover.
  - `showSubagentCount` (boolean, default: `true`): Badge for active subagents.
  - `scale` (number, step 0.05, 0.8-1.3, default: `1.0`): Overall UI scale.

### 2. Client Plugin (`lib/client.js`)
- Registered via `window.__ModuleLoader__.load({ id: "@dsh-external/dsh-vibe-island", factory: ... })`.
- Injected client services: `slots`, `settingsScope`, `sessions`.
- **Global UI Mount**: Injects container `#dsh-vibe-island-root` into `document.body` and renders `VibeIslandApp` via React 18 `createRoot` (with legacy fallback).
- **Slot Injections**:
  - `settings.section`: Registers `VibeIslandSettingsCard` (id: `dsh-vibe-island-settings`, order: 85) for UI configuration.
  - `conversation.session.header.utilities`: Registers `HeaderBtn` (id: `dsh-vibe-island-header-btn`, order: 48) for one-click toggling.
- **Event Parsing Engine (`parseActivityFromEvents`)**:
  - Intended as an incremental cursor scanner: a module-level `const cursorMap = new WeakMap()` keyed on the `session.events` array, holding `lastIdx` plus derived state, so already-processed events are never re-scanned.
  - Event types handled: `turn-start` / `turn/start` / `user-message`, `thinking` / `model/thinking` / `model/delta`, `tool/call` / `tool-call`, `tool/result` / `tool-result`, `turn-end` / `model/done`, `error`.
  - Tool arguments extracted: commands (`bash`), file paths (`read`, `write`, `edit`), patterns (`glob`, `grep`), questions/approvals (`waiting` amber state).
  - Defensive by design: tolerates `null`/non-array input, null entries, events lacking `type`, and both `ev.type`/`ev.event` + `ev.data`/`ev.payload` shapes.
- **Visual Design**:
  - Compact Pill: 34px height, 200-250px width.
  - Expanded HUD: 146px height, 440px width with detailed command code block, duration counter, and tool invocation count.
  - Platform skins: `platform-macos` (bottom corner radius 18px, top 0) vs `platform-windows` (Win 11 Fluent acrylic with backdrop-filter blur and 9999px border-radius).
  - All CSS lives in a single `CSS_STYLES` template string in `client.js`, injected once via `ensureCss()` keyed on `#dsh-vibe-island-styles`. Every class is namespaced `vibe-island-*` / `vibe-*`.

## Design Notes

### Cursor cache is keyed by session id, never by array reference

`VibeIslandApp` polls with `setEvents([...evs])`, which allocates a **new array every 250ms**. The cursor cache must therefore be keyed on a stable identity, not on the array:

```js
const cursorMap = new Map();   // sessionKey -> cursor state
const CURSOR_CACHE_LIMIT = 64; // explicit eviction; Map holds strong refs
parseActivityFromEvents(events, activeSessionId);
```

Using a `WeakMap` keyed on the array (the original approach) silently misses 100% of the time and degrades every poll to a full O(n) rescan. The parser also resets its cursor when `events.length` shrinks, so truncating/replaced arrays cannot leave stale state.

Verified: parsing cost is O(1) — 0.00036ms/round at 64 000 events, flat across sizes (see the E group in `test/degradation.mjs`). The residual per-poll cost is the `[...evs]` copy that React state updates require, which is inherent and unrelated to parsing.

### Subagent state lives in the sessions tree, not in the event stream

The kernel implements subagents as **separate sessions** (`origin === "subagent"`, `parentId` pointing at the parent). The parent session's `tool/result` only carries the subagent's final output; intermediate commands live in the child session's own event stream. So the only correct source for the count is the lineage catalog:

```js
ctx.sessions.list.getSnapshot().subagentsByParent[parentId].entries[]
// entries: { kind: "child", id, label, mode, activity: "running" | ... }
```

`countActiveSubagents(sessionsFace, parentId)` counts `kind === "child" && activity === "running"` and returns 0 on any exception. Do not try to infer subagents from parent-session events. Same conclusion the `dsh-subagent-lens` plugin documents.

### `toolCount` is per-turn

`turn-start` resets `toolCount` to 0, so the HUD's "工具调用" figure is per-turn usage rather than a session cumulative.


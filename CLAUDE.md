# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

An unpacked Chrome extension (Manifest V3) that patches one specific site, `missav.ai`. Two unrelated features: prevent the page from auto-pausing video when the window or tab loses focus, and widen the video layout.

There is no build step, no bundler, no package manager, no linter, and no test suite. The files in this directory *are* the extension — Chrome loads them as-is.

## Development workflow

Load once via `chrome://extensions` → enable Developer mode → "Load unpacked" → select this directory.

After editing:

- **`content.js` / `manifest.json`** — reload the extension at `chrome://extensions`, then reload the page.
- **`anti-pause.js`** — reload the extension **and** reload the page. This script injects at `document_start`; reloading only the extension will not re-run it on an already-open tab, so changes appear to have no effect.

To verify anti-pause is live: open DevTools Console, enable the **Verbose** log level, and switch away from the window. Each suppressed pause logs `[anti-pause] 已阻止一次自動暫停`.

## Architecture

Two content scripts that deliberately run in **different worlds** and at **different times**. This split is the central design constraint:

| File | World | Timing | Can use |
|---|---|---|---|
| `anti-pause.js` | `MAIN` | `document_start` | Page globals (`window.player`), no `chrome.*` APIs |
| `content.js` | isolated (default) | `document_end` | `chrome.*` APIs, DOM only — cannot see `window.player` |

`anti-pause.js` needs both properties and neither is negotiable:

- **`world: "MAIN"`** — the interception target is the page's own `window.player`. An isolated-world content script gets a separate `window` and cannot reach it.
- **`run_at: "document_start"`** — it installs an accessor on `window.player` and must win the race against the page's inline script that assigns it. That assignment lives deep in the page HTML, so `document_start` reliably runs first.

### How anti-pause works

The page registers three handlers that pause playback (`window` blur, `document` blur, `document` visibilitychange), but **all three funnel through `window.player.pause()`**, where `window.player` is a [Plyr](https://plyr.io/) instance. So the extension intercepts that single method rather than blocking any events — the events still fire normally, which is why nothing else on the page breaks.

`Object.defineProperty(window, "player", { get, set })` catches the assignment regardless of whether the page writes `window.player = …` or `var player = …`; in the latter case a global `var` declaration does not overwrite an existing own accessor, so the assignment still routes through the setter. The setter replaces the instance's `pause` with a gated version.

**The gate is a user-gesture heuristic**, not a check on focus state: a `pause()` call within `GESTURE_WINDOW` (700 ms) of a `click`/`keydown`/`touchstart`/`pointerdown` is treated as intentional and passes through; anything else is dropped. This is what keeps the user's own pause button and spacebar working while suppressing focus-driven pauses. Do not "improve" this into a focus check — the site's handlers fire *because* focus was lost, so a focus check cannot distinguish them from a deliberate pause.

A second, independent fallback layer listens for `pause` events in the capture phase on `document` (media events do not bubble, but capture still traverses ancestors) and resumes playback when the window lacks focus and no gesture preceded it. This covers code paths that bypass `window.player` and call `pause()` on the `<video>` element directly. It causes a brief visible stutter, so it is a backstop, not the primary mechanism.

### Site coupling

Both scripts are tightly bound to the target site's internals and will silently stop working if the site changes:

- `anti-pause.js` depends on the global being named `player` and exposing a `pause()` method.
- `content.js` depends on Tailwind/Alpine.js markup — the selectors `div.content-without-search`, `div.content-with-search`, and `div[x-data].flex`. It re-applies styles from a `MutationObserver` on `document.body` because the page swaps this markup in dynamically.

The domain appears in `host_permissions` and in both `content_scripts[].matches`. Changing the target site means updating all three.

### Diagnosing a regression

If auto-pause returns, do not guess at the cause — the mechanism is discoverable from the page. In the Console on a playing video page:

```js
// Which handlers are registered, and what do they do?
for (const [name, tgt] of [['window', window], ['document', document]]) {
  for (const type of ['blur', 'visibilitychange', 'focus']) {
    (getEventListeners(tgt)[type] || []).forEach((l, i) =>
      console.log(`${name}.${type}[${i}] capture=${l.useCapture}`, l.listener.toString().slice(0, 400)));
  }
}

// Who calls pause()? Reproduce after running this, then read the stack.
const origPause = HTMLMediaElement.prototype.pause;
HTMLMediaElement.prototype.pause = function () {
  console.log('pause()', { hidden: document.hidden, focus: document.hasFocus(), stack: new Error().stack });
  return origPause.apply(this, arguments);
};
```

The stack trace identifies whether the pause still routes through Plyr (`wt.pause (plyr.js:…)`) and which page script triggered it. Ignore listeners shaped like `function(h){b.H.stop();g(h);b.dk()&&b.H.start()}` — those are the site's ad/analytics libraries and are unrelated to playback.

## Constraints

- The extension has **no background service worker, no `action`, and no `permissions`** — only `host_permissions`. An earlier version had a `Ctrl+Shift+Q` hotkey backed by `background.js` plus `tabs`/`scripting`/`activeTab`/`windows` permissions; all of it was removed. Adding any `chrome.*` API call back into `content.js` requires restoring the matching permission.
- `world: "MAIN"` requires Chrome 111 or newer.
- `all_frames` is intentionally omitted: the player lives in the top-level frame, so injecting into ad iframes would be pure overhead.

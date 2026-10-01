# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

An unpacked Chrome extension (Manifest V3) that patches one specific site, served from two domains — `missav.ai` and `missav.ws`. Both run the same frontend, so a single set of scripts and selectors covers them. Unrelated features: prevent the page from auto-pausing video when the window or tab loses focus, widen the video layout, add a cover carousel (hero) to the top of the home and list pages, and restyle those pages — the home page into Netflix-style scrolling rows, the list page's filter/sort dropdowns into one-click chips.

There is no build step, no bundler, no package manager, no linter, and no test suite. The files in this directory *are* the extension — Chrome loads them as-is.

## Development workflow

Load once via `chrome://extensions` → enable Developer mode → "Load unpacked" → select this directory.

After editing:

- **`content.js` / `hero.js` / `browse.js` / `browse.css` / `pages.js` / `manifest.json`** — reload the extension at `chrome://extensions`, then reload the page.
- **`anti-pause.js`** — reload the extension **and** reload the page. This script injects at `document_start`; reloading only the extension will not re-run it on an already-open tab, so changes appear to have no effect.

To verify anti-pause is live: open DevTools Console, enable the **Verbose** log level, and switch away from the window. Each suppressed pause logs `[anti-pause] 已阻止一次自動暫停`.

## Architecture

Two content scripts that deliberately run in **different worlds** and at **different times**. This split is the central design constraint:

| File | World | Timing | Can use |
|---|---|---|---|
| `anti-pause.js` | `MAIN` | `document_start` | Page globals (`window.player`), no `chrome.*` APIs |
| `content.js` | isolated (default) | `document_end` | `chrome.*` APIs, DOM only — cannot see `window.player` |
| `pages.js` | isolated (default) | `document_end` | Same entry as `content.js`, loaded first; defines `globalThis.VH` (page detection) |
| `hero.js` | isolated (default) | `document_end` | Same entry; DOM only |
| `browse.js` + `browse.css` | isolated (default) | `document_end` | Same entry; DOM only |

`anti-pause.js` needs both properties and neither is negotiable:

- **`world: "MAIN"`** — the interception target is the page's own `window.player`. An isolated-world content script gets a separate `window` and cannot reach it.
- **`run_at: "document_start"`** — it installs an accessor on `window.player` and must win the race against the page's inline script that assigns it. That assignment lives deep in the page HTML, so `document_start` reliably runs first.

### How anti-pause works

The page registers three handlers that pause playback (`window` blur, `document` blur, `document` visibilitychange), but **all three funnel through `window.player.pause()`**, where `window.player` is a [Plyr](https://plyr.io/) instance. So the extension intercepts that single method rather than blocking any events — the events still fire normally, which is why nothing else on the page breaks.

`Object.defineProperty(window, "player", { get, set })` catches the assignment regardless of whether the page writes `window.player = …` or `var player = …`; in the latter case a global `var` declaration does not overwrite an existing own accessor, so the assignment still routes through the setter. The setter replaces the instance's `pause` with a gated version.

**The gate is a user-gesture heuristic**, not a check on focus state: a `pause()` call within `GESTURE_WINDOW` (700 ms) of a `click`/`keydown`/`touchstart`/`pointerdown` is treated as intentional and passes through; anything else is dropped. This is what keeps the user's own pause button and spacebar working while suppressing focus-driven pauses. Do not "improve" this into a focus check — the site's handlers fire *because* focus was lost, so a focus check cannot distinguish them from a deliberate pause.

A second, independent fallback layer listens for `pause` events in the capture phase on `document` (media events do not bubble, but capture still traverses ancestors) and resumes playback when the window lacks focus and no gesture preceded it. This covers code paths that bypass `window.player` and call `pause()` on the `<video>` element directly. It causes a brief visible stutter, so it is a backstop, not the primary mechanism.

### Cover carousel (`hero.js`)

`hero.js` shares `content.js`'s `content_scripts` entry, so it adds no fourth domain list. It activates on two kinds of page. The home page is recognised by its cards, whose preview video id starts with `preview-home-` — no URL or locale-prefix matching. The pages in `VH.LIST_PAGES` (`pages.js`: `/dm<n>/*`, `/saved`) are recognised by `location.pathname` and collect every `.thumbnail video.preview` on the page. A URL gate is required there because video pages also render recommendation cards as `.thumbnail`; adding a page means adding a regex to `LIST_PAGES`, not a `matches` entry. On the home page the host carries `data-bleed`, which switches the shadow styles to full-bleed (no radius, header height added to height and top padding); the host's actual position is set by `browse.js`.

- **Data comes only from the rendered DOM.** The site sits behind Cloudflare, so fetching index HTML (the approach better-viewing's home page uses) is not reliable. Each card yields `{id, href, title, tags, cover, preview}`: the id is the path segment of the video's `data-src` (so it does not depend on each page's video id format), the CDN base is derived from the video's `data-src` by dropping `/preview.mp4`, and `cover-n.jpg` (800×537, same as `cover.jpg`) is tried before `cover-t.jpg` (330×222, the list thumbnail). `preview.mp4` is the only preview the CDN serves — 320×180, ~8.7 s, H.264; `preview-hd` / `-720p` / `-1080p` / `-n` / `-l` / `-h` all 404 (measured 2026-09-30) — so the hero frame upscales it. Badges are `x-show` anchors, so only those whose inline `display` is not `none` count.
- **Cards are rendered by Alpine after `document_end`**, so a debounced `MutationObserver` re-runs `refresh()`: re-mount the host if it was removed, collect new cards, start on the first arrival. New items are inserted at random positions after `at`, as in better-viewing's `heroAdd()`.
- **Mount point** is the first card's `div.content-*` layout root (prepended), falling back to before its `.grid`. The hero lives in a Shadow DOM with inline CSS, so it neither reads Tailwind nor touches any Alpine-controlled property — see the login-modal note below for why that matters.
- **The progress bar's CSS animation is the clock**: `animationend` advances. `sync()` is the single place that decides pause state: hover/focus inside pauses only the bar (the preview video keeps playing — that is why the user stopped); `document.hidden`, less than half the hero on screen (`intersectionRatio`, not `isIntersecting`), or reduced motion also pause the video. The outgoing slide's video is stopped and its `src` removed only after the fade, which is what actually aborts the download.
- `pause` events from the hero's video do not reach `anti-pause.js`'s capture listener on `document`: they are not composed, so their path ends at the shadow root.

### Home / list restyle (`browse.js`, `browse.css`, `pages.js`)

`pages.js` defines `globalThis.VH` — `LIST_PAGES`, `LAYOUT_ROOT` and `kind()` — which `hero.js` and `browse.js` both read; scripts in one `content_scripts` entry share an isolated world, so it must stay first in that entry's `js` array. `kind()` returns `"home"` when `div.is-home` exists (a server-rendered class on the home layout root), `"list"` for `LIST_PAGES`, otherwise `null`.

`browse.js` adds `vh-home` / `vh-list` to `<html>`, and **every rule in `browse.css` is scoped under those classes** — `content_scripts.css` injects on every page of the domain, including video pages, so an unscoped rule would leak there. The split is: CSS does all the layout; JS only marks elements, inserts its own nodes, and measures.

- **Never write `display` on anything Alpine toggles with `x-show`** (the login-modal lesson below). Rows hide the `x-show` placeholder card simply by not touching its inline `display: none`. The original list toolbar (`div.flex.justify-between.mb-6`) is hidden with a class because it carries no `x-show` itself.
- **Home width**: `content.js` skips `.is-home` roots (no 150vh cap), and `browse.css` drops `sm:container`'s `max-width` inside the home root in favour of `--vh-gutter` side padding, so the rows start near the left edge like Netflix instead of being centred.
- **Rows**: each `div.grid` in the home root gets `data-vh-row` and its parent `data-vh-section`, except the random section, recognised by its `button.button-primary` (好手氣). Rows are flex + `scroll-snap`; `--per` (1.8 / 2.6 / 3.4 / 4.4 by width) sets how many cards fit, the fraction being the deliberate peek. A horizontal scroller clips vertically too, so `--lift` / `--lead` padding with matching negative margins leave room for the hover scale (`--vh-zoom`, 1.3×, mirrored by `ZOOM` in `browse.js`). That is not enough horizontally, so a `pointerover` handler sets each card's `transform-origin` to its left or right edge when the scaled card would cross the row's (or viewport's) edge. The `--lift` overlap covers the bottom of each section's title row, so the title row and the load-more link sit at `z-index: 5`, a hovered card at 6, and the arrows at 7 so an enlarged edge card cannot cover them. The right side bleeds to the viewport edge via `--vh-bleed`, and the arrows use `--vh-edge` / `--vh-pad`; all three are **measured in `layoutRows()`, not `100vw`**, because `100vw` includes the scrollbar and would add a horizontal scrollbar on Windows. Arrows are the extension's own buttons appended to the section, positioned to the row's `offsetTop` / `offsetHeight`.
- **Keyboard**: `tidyCards()` sets `tabindex=-1` on every card link except the title (`.my-2 a`), so Tab stops once per card; ←/→ inside a row moves between cards. The list page already binds ←/→ to page turns (`@keyup.arrow-right.window`), so row keys exist only on the home page.
- **List grid** is widened from the site's 2 / 3 / 4 columns to 1 / 2 / 3 (`grid-template-columns` override, the grid itself has no `x-show`).
- **List toolbar** is rebuilt from the original dropdowns' links: one `role="group"` of chips per dropdown, the active one matched by the text after the label's colon and marked `aria-current`. Page `N / M` comes from the pagination's non-link number and its `/ M` span. Any structural mismatch leaves the original toolbar visible.
- **Hero bleed**: `placeHero()` resets the host's inline margins, measures, then pulls it to the document's left edge and top (under the fixed, gradient header). `--vh-header` is the header's height from a `ResizeObserver`; the sticky list toolbar uses it too.
- **Ads**: in-flow banners are `.pt-16.pb-4.px-4:has(iframe)` and the corner one `.fixed.right-2.bottom-2:has(iframe)`; matched by structure, not ad domain. Hidden only on `vh-home` / `vh-list`. Hiding them has a side effect: each recommendation section's「載入更多」(`div.absolute.w-full.text-center[x-show]`, the section's next sibling) was absolutely positioned over the following ad wrapper's `pt-16` gap, so without the ad it sat under the next section and could not be clicked. `browse.css` puts it back in flow by changing only `position` — its `display` belongs to `x-show`.
- **Home search block** (root's `div.flex-col` containing `div > form`) is hidden; the header's search toggle remains. That container has only a `:class` binding (`pb-8`), no `x-show`.
- One debounced `MutationObserver` on the layout root (not `body`) re-runs `refresh()`: recommendation cards and the hero arrive after `document_end`.

### Site coupling

All three scripts are tightly bound to the target site's internals and will silently stop working if the site changes:

- `anti-pause.js` depends on the global being named `player` and exposing a `pause()` method.
- `hero.js` depends on cards being `.thumbnail` containing `video.preview` whose `data-src` is `<cdn>/<id>/preview.mp4` (on the home page the video id must also start with `preview-home-`), and the title in `.my-2 a`.
- `browse.js` depends on: home root `div.is-home`; sections being the grid's parent with the title row as first child; the random section's `button.button-primary`; the list toolbar `div.flex.justify-between.mb-6` holding `.relative > a > span` labels (`名稱: 值`) and menu `div a[href]`; the fixed header `div.fixed.z-max.w-full`; the pagination inside `nav`.
- `content.js` depends on Tailwind/Alpine.js markup — it finds the layout roots `div.content-without-search` / `div.content-with-search`, then queries `div[x-data].flex` *within* them. It re-applies styles from a `MutationObserver` on `document.body` because the page swaps this markup in dynamically.

**Do not widen the `div[x-data].flex` selector back to a document-wide query.** `x-data` marks every Alpine component root on the page, and Alpine's `x-show` toggles elements by writing inline `display`. A global query therefore fights Alpine for the same property on components that have nothing to do with the video layout, and the `MutationObserver` re-fights it on every DOM change. The observed symptom was the login modal (opened by the favourite button) failing to appear at all. Two guards prevent this and both matter:

- the query runs **inside** the `div.content-*` layout roots, not on `document`;
- elements carrying `x-show`, or computing to `position: fixed`, are skipped — those are Alpine-controlled or overlays.

Note the failure mode is not "the element gets forced visible", which is what fighting over `display` naively suggests. Bisect against the live page rather than reasoning about it; disabling one content script in `manifest.json`, then one block within `content.js`, localises it in two reload cycles.

The target domains are listed in three separate places in `manifest.json`: `host_permissions`, and the `matches` array of each of the two `content_scripts` entries. Adding, removing, or changing a domain means editing all three lists — miss one and the extension half-loads, which looks like a site-side regression rather than a config error.

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

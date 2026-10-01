# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

An unpacked Chrome extension (Manifest V3) that patches one specific site, served from two domains — `missav.ai` and `missav.ws`. Both run the same frontend, so a single set of scripts and selectors covers them. Two unrelated concerns: prevent the page from auto-pausing video when the window or tab loses focus, and restyle the site — edge-to-edge layout on every page, a cover carousel (hero) on the home and list pages, Netflix-style scrolling rows on the home page, one-click filter/sort chips on list pages, and a theater-style video page with recommendation rows right under the player.

There is no build step, no bundler, no package manager, no linter, and no test suite. The files in this directory *are* the extension — Chrome loads them as-is.

## Development workflow

Load once via `chrome://extensions` → enable Developer mode → "Load unpacked" → select this directory.

After editing:

- **`pages.js` / `hero.js` / `browse.js` / `browse.css` / `manifest.json`** — reload the extension at `chrome://extensions`, then reload the page.
- **`anti-pause.js`** — reload the extension **and** reload the page. This script injects at `document_start`; reloading only the extension will not re-run it on an already-open tab, so changes appear to have no effect.

To verify anti-pause is live: open DevTools Console, enable the **Verbose** log level, and switch away from the window. Each suppressed pause logs `[anti-pause] 已阻止一次自動暫停`.

## Architecture

Two `content_scripts` entries that deliberately run in **different worlds** and at **different times**. This split is the central design constraint:

| File | World | Timing | Can use |
|---|---|---|---|
| `anti-pause.js` | `MAIN` | `document_start` | Page globals (`window.player`), no `chrome.*` APIs |
| `pages.js` | isolated (default) | `document_end` | Second entry, loaded first; defines `globalThis.VH` (page detection). DOM only — cannot see `window.player` |
| `hero.js` | isolated (default) | `document_end` | Same entry; DOM only |
| `browse.js` + `browse.css` | isolated (default) | `document_end` | Same entry; DOM only |

There used to be a `content.js` in the second entry that capped the layout root at an inline `max-width: 150vh` and turned the video page's `div.flex[x-data]` into a column. It was removed in 1.4: `browse.css` now owns both jobs with plain CSS (see below), which also dropped a `MutationObserver` on `document.body`.

`anti-pause.js` needs both properties and neither is negotiable:

- **`world: "MAIN"`** — the interception target is the page's own `window.player`. An isolated-world content script gets a separate `window` and cannot reach it.
- **`run_at: "document_start"`** — it installs an accessor on `window.player` and must win the race against the page's inline script that assigns it. That assignment lives deep in the page HTML, so `document_start` reliably runs first.

### How anti-pause works

The page registers three handlers that pause playback (`window` blur, `document` blur, `document` visibilitychange), but **all three funnel through `window.player.pause()`**, where `window.player` is a [Plyr](https://plyr.io/) instance. So the extension intercepts that single method rather than blocking any events — the events still fire normally, which is why nothing else on the page breaks.

`Object.defineProperty(window, "player", { get, set })` catches the assignment regardless of whether the page writes `window.player = …` or `var player = …`; in the latter case a global `var` declaration does not overwrite an existing own accessor, so the assignment still routes through the setter. The setter replaces the instance's `pause` with a gated version.

**The gate is a user-gesture heuristic**, not a check on focus state: a `pause()` call within `GESTURE_WINDOW` (700 ms) of a `click`/`keydown`/`touchstart`/`pointerdown` is treated as intentional and passes through; anything else is dropped. This is what keeps the user's own pause button and spacebar working while suppressing focus-driven pauses. Do not "improve" this into a focus check — the site's handlers fire *because* focus was lost, so a focus check cannot distinguish them from a deliberate pause.

A second, independent fallback layer listens for `pause` events in the capture phase on `document` (media events do not bubble, but capture still traverses ancestors) and resumes playback when the window lacks focus and no gesture preceded it. This covers code paths that bypass `window.player` and call `pause()` on the `<video>` element directly. It causes a brief visible stutter, so it is a backstop, not the primary mechanism.

### Cover carousel (`hero.js`)

`hero.js` shares the second `content_scripts` entry with `browse.js`, so it adds no extra domain list. It activates on two kinds of page. The home page is recognised by its cards, whose preview video id starts with `preview-home-` — no URL or locale-prefix matching. The pages in `VH.LIST_PAGES` (`pages.js`: `/dm<n>/*`, `/saved`) are recognised by `location.pathname` and collect every `.thumbnail video.preview` on the page. A URL gate is required there because video pages also render recommendation cards as `.thumbnail`; adding a page means adding a regex to `LIST_PAGES`, not a `matches` entry. On the home page the host carries `data-bleed`, which switches the shadow styles to full-bleed (no radius, header height added to height and top padding); the host's actual position is set by `browse.js`.

- **Data comes only from the rendered DOM.** The site sits behind Cloudflare, so fetching index HTML (the approach better-viewing's home page uses) is not reliable. Each card yields `{id, href, title, tags, cover, preview}`: the id is the path segment of the video's `data-src` (so it does not depend on each page's video id format), the CDN base is derived from the video's `data-src` by dropping `/preview.mp4`, and `cover-n.jpg` (800×537, same as `cover.jpg`) is tried before `cover-t.jpg` (330×222, the list thumbnail). `preview.mp4` is the only preview the CDN serves — 320×180, ~8.7 s, H.264; `preview-hd` / `-720p` / `-1080p` / `-n` / `-l` / `-h` all 404 (measured 2026-09-30) — so the hero frame upscales it. Badges are `x-show` anchors, so only those whose inline `display` is not `none` count.
- **Cards are rendered by Alpine after `document_end`**, so a debounced `MutationObserver` re-runs `refresh()`: re-mount the host if it was removed, collect new cards, start on the first arrival. New items are inserted at random positions after `at`, as in better-viewing's `heroAdd()`.
- **Mount point** is the first card's `div.content-*` layout root (prepended), falling back to before its `.grid`. The hero lives in a Shadow DOM with inline CSS, so it neither reads Tailwind nor touches any Alpine-controlled property — see the login-modal note below for why that matters.
- **The progress bar's CSS animation is the clock**: `animationend` advances. `sync()` is the single place that decides pause state: hover/focus inside pauses only the bar (the preview video keeps playing — that is why the user stopped); `document.hidden`, less than half the hero on screen (`intersectionRatio`, not `isIntersecting`), or reduced motion also pause the video. The outgoing slide's video is stopped and its `src` removed only after the fade, which is what actually aborts the download.
- **Slide transitions are picked at random** from `FX` (parallax / zoom / flip) on every switch, all over `SWAP_MS` (800 ms, passed to CSS as `--swap`). `show(step)` writes the same `data-fx` and `--dir` (1 for next, −1 for previous) on the incoming and outgoing slides; CSS keys the start state on `[data-fx]:not([data-on])`, the end states on `data-on="1"` / `"0"`. Parallax moves background, frame and text at different speeds; zoom scales the old slide towards the viewer (on top, `z-index: 1`) while the new one rises from behind; flip turns the frame like a card in 3D while the slides cross-fade. Movement uses the individual `translate` property rather than `transform`, because `.bg`'s `transform` belongs to the `drift` animation and the two would override each other. The first slide has no `data-fx`, so it appears without a transition. The old slide is removed after `SWAP_MS + 100`. Under reduced motion every transition is off and the swap is instant.
- `pause` events from the hero's video do not reach `anti-pause.js`'s capture listener on `document`: they are not composed, so their path ends at the shadow root.

### Home / list restyle (`browse.js`, `browse.css`, `pages.js`)

`pages.js` defines `globalThis.VH` — `LIST_PAGES`, `LAYOUT_ROOT` and `kind()` — which `hero.js` and `browse.js` both read; scripts in one `content_scripts` entry share an isolated world, so it must stay first in that entry's `js` array. `kind()` returns `"home"` when `div.is-home` exists (a server-rendered class on the home layout root), `"list"` for `LIST_PAGES`, otherwise `null`.

`kind()` also returns `"video"` when a layout root contains `video.player` (server-rendered). `browse.js` adds `vh-wide` to `<html>` on every page that has a layout root, then `vh-home` / `vh-list` / `vh-video` by kind, and **every rule in `browse.css` is scoped under those classes** — `content_scripts.css` injects on every page of the domain, so an unscoped rule would leak everywhere. The split is: CSS does all the layout; JS only marks elements, inserts its own nodes, and measures.

- **Never write `display` on anything Alpine toggles with `x-show`** (the login-modal lesson below). Rows hide the `x-show` placeholder card simply by not touching its inline `display: none`. The original list toolbar (`div.flex.justify-between.mb-6`) is hidden with a class because it carries no `x-show` itself.
- **Edge-to-edge layout** (`vh-wide`, all pages): non-home layout roots lose `sm:container`'s `max-width` and centring in favour of `--vh-gutter` side padding. The home root has no `sm:container`; there the same padding goes on each section (`.is-home .sm:container`), which is why the root rule excludes `.is-home`. No `!important` is needed because nothing writes an inline width any more.
- **Rows**: each `div.grid` in the home root gets `data-vh-row` and its parent `data-vh-section`, except the random section, recognised by its `button.button-primary` (好手氣). Rows are flex + `scroll-snap`; `--per` (1.8 / 2.6 / 3.4 / 4.4 by width) sets how many cards fit, the fraction being the deliberate peek. A horizontal scroller clips vertically too, so `--lift` / `--lead` padding with matching negative margins leave room for the hover scale (`--vh-zoom`, 1.3×, mirrored by `ZOOM` in `browse.js`). That is not enough horizontally, so a `pointerover` handler sets each card's `transform-origin` to its left or right edge when the scaled card would cross the row's (or viewport's) edge. The `--lift` overlap covers the bottom of each section's title row, so the title row and the load-more link sit at `z-index: 5`, a hovered card at 6, and the arrows at 7 so an enlarged edge card cannot cover them. The right side bleeds to the viewport edge via `--vh-bleed`, and the arrows use `--vh-edge` / `--vh-pad`; all three are **measured in `layoutRows()`, not `100vw`**, because `100vw` includes the scrollbar and would add a horizontal scrollbar on Windows. Arrows are the extension's own buttons appended to the section, positioned to the row's `offsetTop` / `offsetHeight`.
- **Keyboard**: `tidyCards()` sets `tabindex=-1` on every card link except the title (`.my-2 a`), so Tab stops once per card; ←/→ inside a row moves between cards. The list page already binds ←/→ to page turns (`@keyup.arrow-right.window`), so row keys exist only on the home page.
- **List grid** is widened from the site's 2 / 3 / 4 columns to 1 / 2 / 3 (`grid-template-columns` override, the grid itself has no `x-show`).
- **List toolbar** is rebuilt from the original dropdowns' links: one `role="group"` of chips per dropdown, the active one matched by the text after the label's colon and marked `aria-current`. Page `N / M` comes from the pagination's non-link number and its `/ M` span. Any structural mismatch leaves the original toolbar visible.
- **Hero bleed**: `placeHero()` resets the host's inline margins, measures, then pulls it to the document's left edge and top (under the fixed, gradient header). `--vh-header` is the header's height from a `ResizeObserver`; the sticky list toolbar uses it too.
- **Ads**: in-flow banners are `.pt-16.pb-4.px-4:has(iframe)` and the corner one `.fixed.right-2.bottom-2:has(iframe)`; matched by structure, not ad domain. Hidden only on `vh-home` / `vh-list`. Hiding them has a side effect: each recommendation section's「載入更多」(`div.absolute.w-full.text-center[x-show]`, the section's next sibling) was absolutely positioned over the following ad wrapper's `pt-16` gap, so without the ad it sat under the next section and could not be clicked. `browse.css` puts it back in flow by changing only `position` — its `display` belongs to `x-show`.
- **Home search block** (root's `div.flex-col` containing `div > form`) is hidden; the header's search toggle remains. That container has only a `:class` binding (`pb-8`), no `x-show`.
- One debounced `MutationObserver` on the layout root (not `body`) re-runs `refresh()`: recommendation cards and the hero arrive after `document_end`.

### Video page (`vh-video`)

The page's `div.flex[x-data]` holds the sidebar (`div.order-last`, server-rendered inline `max/min-width: 300px`) and the main column (`div.flex-1.order-first`), whose children are: the player block (first `div[x-data]`), `div.mt-4` (h1 + 收藏/片單/分享), the share and playlist panels (`x-show`), `div.under_player` (ad), `div.mb-8` (詳情/磁力下載 tabs) and `div.relative.overflow-hidden` (related grid, with an ad iframe above it).

- **Grid with `display: contents`**: `div.flex[x-data]` becomes a one-column grid and the main column `display: contents`, so the sidebar and the main column's children are siblings that `order` can interleave without moving DOM. Neither element has `x-show`. The share/playlist panels do, so they only get `order`.
- **Order**: player → 接著看 (the sidebar) → title/buttons → panels → details → 相關影片. The text blocks are capped at 1280px wide.
- **Both recommendation blocks are one list**: the sidebar renders `recommendItems.slice(0, 13)` and the related grid `slice(13, 29)` on desktop, so they never overlap and the sidebar holds the higher-ranked half — which is why it, not the related grid, sits under the player. They are separate Alpine `x-for` containers, so they stay two rows; nodes are not moved into one (moving `x-for` output risks Alpine's later re-renders). On non-desktop the site slices both from 0 and they duplicate, so the sidebar keeps Tailwind's `hidden lg:flex` below 1024px and is set to `display: block` only above it.
- **Sidebar as a row**: its inner `div` is a row (`rowGrids()` returns it plus the related grid). Each `div.flex.mb-6` item becomes a column card; the thumbnail and title wrappers carry server-rendered inline widths (165px / 119px, not Alpine-bound), overridden with `!important`. Its title link sits outside `.thumbnail`, so `cardTitle()` looks in the item's `div.flex-1`, and `refresh()` runs `initRows()` before `tidyCards()` on this page. The sidebar's ad `div.space-y-6` is hidden.
- **Theater band**: the player block is stretched to the viewport with negative `--vh-gutter` margins; its children are capped at `--vh-player-w` = `(100vh − player top − 12px gap) × 16/9` (min 480px) and centred, so the picture ends just above the bottom of the window; the loop bar sits below the fold. The player top (`--vh-player-top`) is measured by `browse.js` (`measurePlayer()`, on refresh and resize), because the header height alone misses the layout root's top padding and the picture got cut off by the window's bottom edge. The layout root's own top padding (site CSS: 80px, 56px when narrow) is replaced on this page by header height + 8px, so the gap above the player is small. Plyr fullscreen uses its own container and is unaffected.
- **Ambient light**: `browse.js` writes the video's cover (`og:image`, falling back to `video.player[data-poster]`, both server-rendered `cover-n.jpg`) to `--vh-cover` on `<html>`, and three blurred copies of it replace the black band: a full-page `position: fixed` wash (`body::before`, z −3) with a vignette (`body::after`, z −2), a top glow on the player block's `::before` (z −1, fades out by mask over 150vh), and a halo behind the player wrapper's `::before` that slowly breathes (off under reduced motion). The site's dark gradient is a `body` background with none on `html`, so it propagates to the canvas and negative-z pseudo-elements paint above it and below all content. The player block must therefore **not** be a stacking context: `isolation` there would turn the top glow into a normal layer painted over the title and details. It clips horizontally (`overflow-x: clip`) because the scaled halo would otherwise add a horizontal scrollbar; the loop bar sits at `z-index: 1` above the halo's spill. The action buttons and the details tab box are glass panels (translucent + `backdrop-filter`). The wash and vignette also apply on `vh-home` / `vh-list`, where `hero.js` sets `--vh-cover` to the current slide's cover on every slide change; Chrome cross-fades the `background-image` transition, so the page tint drifts with the carousel. There the full-bleed hero has a transparent ground and masks its `.bg` and overlay to transparent at the bottom, so it fades into the tinted page instead of ending in a hard edge.
- **Details**: the promo `ul.list-none` is hidden; each `div.space-y-2 > div.text-secondary` row is a wrapping flex with a hanging-indent label, and `font-size: 0` on the row (reset on children) hides the bare-text commas between links. That is why the indent is `--vh-label-w` in px: an `em` on the row resolves to 0 while the label's own `em` is 14px, which pushed the labels out of the column.
- `browse.js` removes the sidebar's inline width (CSS cannot beat it; Alpine does not manage it) and inserts the「接著看」/「相關影片」headings before each row; the related section's `overflow-hidden` is overridden so the bleed and hover scale are not clipped. In sidebar cards the hover scale applies to the cover only, since the title is outside `.thumbnail`.
- Row ←/→ only act when focus is on a card, so Plyr's own arrow-key seeking is unaffected.
- Ads hidden: `.under_player`, the iframe above the related grid, the sidebar's `div.space-y-6` with iframes, and the corner ad.

### Site coupling

Every script is tightly bound to the target site's internals and will silently stop working if the site changes:

- `anti-pause.js` depends on the global being named `player` and exposing a `pause()` method.
- `hero.js` depends on cards being `.thumbnail` containing `video.preview` whose `data-src` is `<cdn>/<id>/preview.mp4` (on the home page the video id must also start with `preview-home-`), and the title in `.my-2 a`.
- `browse.css` / `browse.js` depend on: the video page structure listed under *Video page*; home root `div.is-home`; sections being the grid's parent with the title row as first child; the random section's `button.button-primary`; the list toolbar `div.flex.justify-between.mb-6` holding `.relative > a > span` labels (`名稱: 值`) and menu `div a[href]`; the fixed header `div.fixed.z-max.w-full`; the pagination inside `nav`.

**Why nothing writes `display` on `x-show` elements.** Alpine's `x-show` toggles elements by writing inline `display`. The removed `content.js` once queried `div[x-data].flex` across the whole document and forced `display: flex` on matches; `x-data` marks every Alpine component root, so it fought Alpine for that property on unrelated components, and its `MutationObserver` re-fought it on every DOM change. The observed symptom was the login modal (opened by the favourite button) failing to appear at all — not, as fighting over `display` naively suggests, the element getting forced visible. The rule that came out of it: scope every selector to a layout root or a specific known element, and leave `display` on `x-show` elements to Alpine. When something like this recurs, bisect against the live page rather than reasoning about it — disable one `content_scripts` entry in `manifest.json`, then one block of `browse.css`, and it localises in a couple of reload cycles.

The target domains are listed in three separate places in `manifest.json`: `host_permissions`, and the `matches` array of each of the two `content_scripts` entries (`anti-pause.js`, and `pages.js` / `hero.js` / `browse.js`). Adding, removing, or changing a domain means editing all three lists — miss one and the extension half-loads, which looks like a site-side regression rather than a config error.

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

- The extension has **no background service worker, no `action`, and no `permissions`** — only `host_permissions`. An earlier version had a `Ctrl+Shift+Q` hotkey backed by `background.js` plus `tabs`/`scripting`/`activeTab`/`windows` permissions; all of it was removed. Adding any `chrome.*` API call to a content script requires restoring the matching permission.
- `world: "MAIN"` requires Chrome 111 or newer.
- `all_frames` is intentionally omitted: the player lives in the top-level frame, so injecting into ad iframes would be pure overhead.

# Video Helper

A Manifest V3 Chrome extension that stops a video page from auto-pausing playback when the browser window or tab loses focus, and restyles the site for easier browsing.

## Why

Some video pages register handlers on `window` `blur` and `document` `visibilitychange` that call `pause()` as soon as you switch to another tab or another application. Chrome itself does not do this — a background tab keeps playing `<video>` normally — so the behaviour is entirely site-side JavaScript, and it can be intercepted.

## Features

- **Anti auto-pause** — playback survives `Alt+Tab`, `Ctrl+Tab`, and clicking into another window. Pausing yourself (the player button, spacebar) still works normally.
- **Cover carousel** — a full-screen hero at the top of the home page, `/dm<n>/*` and `/saved` rotates through that page's own video cards: blurred cover backdrop, a cover frame that crossfades into the muted preview clip, title, prev/next, a progress bar, and a randomly chosen transition (parallax, zoom or 3D flip) on each switch. Pauses when the tab is hidden or the hero is scrolled mostly out of view; hovering does not pause it. The page background is tinted by the current cover.
- **Home rows** — the home page's sections become Netflix-style horizontal rows (scroll-snap, a peek of the next card, hover arrows, ←/→ between cards, cards enlarge on hover). The random section stays a grid. In-page ads are hidden on the home and list pages.
- **List toolbar** — the filter and sort dropdowns become always-visible chips (one click instead of two), sticky under the header, with a mini pager (‹ editable page number ›).
- **List pagination** — large previous/next buttons, page numbers centred on the current page, a jump-to-page box, and ←/→ to change pages.
- **Scroll reveal** — video cards fade up one after another as they scroll into view (once per card).
- **Edge-to-edge layout** — every page drops the centred container in favour of a small side gutter.
- **Theater video page** — the player sits in a full-width band sized to fit the window height, lit by a blurred, slowly breathing glow from the video's own cover that tints the whole page; the up-next list becomes a scrolling row right under it, followed by title, actions, details and a second row of related videos. Ads and promo links are hidden.

## Install

No build step — the repository *is* the extension.

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this directory

Requires Chrome 111 or newer (for `world: "MAIN"` content scripts).

## How it works

The page's pause handlers all funnel through a single call — `window.player.pause()`, where `window.player` is a [Plyr](https://plyr.io/) instance. Rather than blocking the `blur` and `visibilitychange` events (which would break unrelated page features that legitimately listen for them), the extension intercepts just that one method.

`anti-pause.js` installs an accessor on `window.player` at `document_start`, before the page's own script assigns it, and wraps the instance's `pause` on the way through. The wrapper allows a pause only if a `click`, `keydown`, `touchstart`, or `pointerdown` happened within the last 700 ms — so a deliberate pause passes and a focus-driven one is dropped. Events still fire as normal; nothing else on the page changes behaviour.

This requires the script to run in the **main world**, since an isolated-world content script gets its own `window` and cannot see the page's `player` global.

A second fallback layer watches for `pause` events in the capture phase and resumes playback if the window has no focus and no gesture preceded it. This covers code that calls `pause()` on the `<video>` element directly, bypassing Plyr.

## Files

| File | World | Timing | Purpose |
|---|---|---|---|
| `anti-pause.js` | `MAIN` | `document_start` | Intercepts `window.player.pause()` |
| `pages.js` | isolated | `document_end` | Shared page detection (home / list) |
| `hero.js` | isolated | `document_end` | Cover carousel on the home page, `/dm<n>/*`, `/saved` |
| `browse.js` + `browse.css` | isolated | `document_end` | Home rows and list toolbar |

## Limitations

Every script is coupled to the target site's internals. If the site renames its `player` global or changes the markup that `browse.css` / `browse.js` select, the extension stops having an effect — silently, since there is nothing to error on. `CLAUDE.md` documents a Console-based procedure for re-identifying the pause mechanism when that happens.

The target domains are listed in three places in `manifest.json` — `host_permissions`, and the `matches` array of each of the two `content_scripts` entries. Pointing the extension elsewhere, or adding another domain, means editing all three; miss one and the extension half-loads, which looks like a site-side regression rather than a config error.

## License

[MIT](LICENSE)

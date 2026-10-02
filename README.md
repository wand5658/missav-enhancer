# MissAV Enhancer

**English** | [繁體中文](README.zh-TW.md)

An unofficial Chrome extension (Manifest V3) for **missav.ai** and **missav.ws**. It stops videos from pausing when you switch to another tab or window, and restyles the site for easier browsing. Every feature can be switched and tuned from a toolbar popup.

Not affiliated with the site. No data collection, no remote requests — see [Privacy](#privacy).

<!-- Screenshots: docs/screenshots/*.png (covers blurred) -->

## Features

- **No auto-pause**: playback keeps going through `Alt+Tab`, `Ctrl+Tab`, and clicks into another window. Pausing it yourself (the player button, spacebar) still works.
- **Cover carousel**: a full-screen hero at the top of the home page, `/dm<n>/*` and `/saved` that cycles through that page's own videos. Each slide shows a blurred cover backdrop, a cover that crossfades into the muted preview clip, the title, prev/next buttons, a progress bar, and a random transition (parallax, zoom or 3D flip). The page background takes its tint from the current cover.
- **Home rows**: the home page's sections become Netflix-style horizontal rows, with scroll-snap, a peek of the next card, arrows, ←/→ between cards, and cards that enlarge on hover.
- **List toolbar**: the filter and sort dropdowns become always-visible chips (one click instead of two), sticky under the header, with a mini pager.
- **List pagination**: large prev/next buttons, page numbers centred on the current page, a jump-to-page box, and ←/→ to change pages.
- **Theater video page**: the player fills a full-width band sized to the window height, lit by a blurred glow from the video's own cover. The up-next list becomes a scrolling row right under it.
- **Edge-to-edge layout, scroll reveal, ad hiding.**

## Install

Chrome 111 or newer (Edge and other Chromium browsers work too).

1. Download the latest `missav-enhancer-*.zip` from [Releases](../../releases) and unzip it somewhere permanent. Chrome loads the extension from that folder, so don't delete it afterwards.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).

Or clone this repository and load its directory instead. There is no build step.

### Updating

An extension loaded this way does **not** update itself. To update, download the new release, replace the folder's contents, then click the reload icon on the extension's card in `chrome://extensions` and reload any open tabs. Your settings are kept.

## Settings

Click the toolbar icon (pin it from the puzzle-piece menu first). The popup is in Traditional Chinese or English, following the browser's language. Each group (anti auto-pause, cover carousel, home page, list pages, video page, look and motion, ads) has a master switch and its own options. Changes apply to open tabs immediately; the few that restructure a page are marked and offer a reload. Settings sync across browsers signed in to the same account, and can be reset, exported and imported as JSON.

## Privacy

- The only permission is `storage`, used for your settings (`chrome.storage.sync`).
- Host access is limited to `missav.ai` and `missav.ws`.
- There is no background script, and the extension makes no network requests of its own. The carousel is built from video cards already on the page.
- No analytics or tracking.

## Other domains

The site moves between domains. To add one, edit `manifest.json` in **three** places: `host_permissions`, and the `matches` of both `content_scripts` entries. Then reload the extension. Missing one makes the extension half-work. Optionally, also add the domain to the `SITE` regex in `popup.js`; it only drives the popup's "on this site" indicator.

If a new official domain shows up, an issue or PR is welcome.

## When it stops working

The extension depends on the site's internal markup and its `player` global. When the site changes either, features stop working silently. Please [open an issue](../../issues/new/choose) with the domain, the page type (home / list / video) and your Chrome version.

## How it works

The site's pause handlers (`window` blur, `document` blur, `visibilitychange`) all call `window.player.pause()`, where `window.player` is a [Plyr](https://plyr.io/) instance. Instead of blocking those events, which would break unrelated page features, `anti-pause.js` runs in the page's main world at `document_start`, installs an accessor on `window.player` before the page assigns it, and wraps that instance's `pause`. A pause is allowed only if a click, key press or touch happened within the last 700 ms (adjustable), so your own pauses pass and focus-driven ones are dropped. A fallback resumes playback if something calls `pause()` on the `<video>` directly.

The restyle is plain CSS scoped under classes on `<html>`, plus scripts that mark elements, insert their own nodes and measure. They never write `display` on elements Alpine.js controls. [`CLAUDE.md`](CLAUDE.md) has the full architecture notes and a Console procedure for diagnosing regressions.

| File | World | Timing | Purpose |
|---|---|---|---|
| `anti-pause.js` | `MAIN` | `document_start` | Intercepts `window.player.pause()` |
| `settings.js` | isolated | `document_end` | Settings from `chrome.storage.sync` (shared with the popup) |
| `pages.js` | isolated | `document_end` | Page detection (home / list / video) |
| `hero.js` | isolated | `document_end` | Cover carousel |
| `browse.js` + `browse.css` | isolated | `document_end` | Layout, rows, list toolbar and pagination, video page, scroll reveal |
| `popup.html` / `.css` / `.js` | — | — | Settings popup |

## License

[MIT](LICENSE)

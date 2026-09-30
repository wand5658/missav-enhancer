# Video Helper

A Manifest V3 Chrome extension that stops a video page from auto-pausing playback when the browser window or tab loses focus, and widens the player layout to use more of the screen.

## Why

Some video pages register handlers on `window` `blur` and `document` `visibilitychange` that call `pause()` as soon as you switch to another tab or another application. Chrome itself does not do this — a background tab keeps playing `<video>` normally — so the behaviour is entirely site-side JavaScript, and it can be intercepted.

## Features

- **Anti auto-pause** — playback survives `Alt+Tab`, `Ctrl+Tab`, and clicking into another window. Pausing yourself (the player button, spacebar) still works normally.
- **Cover carousel** — a hero at the top of the home page, `/dm635/*` and `/saved` rotates through that page's own video cards: dimmed cover backdrop, a cover frame that crossfades into the muted preview clip, title, prev/next, and a progress bar. Pauses on hover, when the tab is hidden, or when scrolled mostly out of view.
- **Wide layout** — removes the horizontal padding around the player container and centres it at `max-width: 150vh`, re-applying on DOM changes so it survives client-side navigation.

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
| `content.js` | isolated | `document_end` | Layout adjustments via `MutationObserver` |
| `hero.js` | isolated | `document_end` | Cover carousel on the home page, `/dm635/*`, `/saved` |

## Limitations

Both scripts are coupled to the target site's internals. If the site renames its `player` global or changes the markup that `content.js` selects, the extension stops having an effect — silently, since there is nothing to error on. `CLAUDE.md` documents a Console-based procedure for re-identifying the pause mechanism when that happens.

The target domains are listed in three places in `manifest.json` — `host_permissions`, and the `matches` array of each of the two `content_scripts` entries. Pointing the extension elsewhere, or adding another domain, means editing all three; miss one and the extension half-loads, which looks like a site-side regression rather than a config error.

## License

[MIT](LICENSE)

// 阻止網頁在視窗失焦 / 切換分頁時自動暫停播放。
//
// 網頁在三個地方註冊了暫停邏輯（window blur、document blur、visibilitychange），
// 但三者都是呼叫 window.player.pause()，所以只要包住這個方法就全部失效，
// 不必攔截任何事件，頁面其他功能不受影響。
//
// 必須以 world: "MAIN" + run_at: "document_start" 注入：
//   - MAIN world 才碰得到網頁自己的 window.player
//   - document_start 才能搶在網頁的 inline script 賦值之前定義 setter
(function () {
    "use strict";

    // 設定由 browse.js 寫在 <html data-vh-anti-pause='{"on":…,"gestureMs":…,"fallback":…}'>：
    // MAIN world 用不了 chrome.storage，所以每次要判斷時才讀這個屬性。
    // 還沒寫入（設定還在讀）就用預設值，setter 照樣在 document_start 先裝好
    const DEFAULTS = { on: true, gestureMs: 700, fallback: true };
    let cfgRaw = null;
    let cfg = DEFAULTS;
    function config() {
        const raw = document.documentElement?.dataset.vhAntiPause ?? null;
        if (raw !== cfgRaw) {
            cfgRaw = raw;
            try { cfg = { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) }; } catch { cfg = DEFAULTS; }
        }
        return cfg;
    }

    // ── 使用者操作 ──
    // 頁面內的手勢：click / keydown / touchstart / pointerdown。
    // 單按修飾鍵不算：Alt+Tab、Win 鍵、Ctrl+T 的修飾鍵 keydown 會先送進頁面，
    // 接著視窗就失焦，以前會被當成「剛按了鍵」而放行網站的自動暫停
    const MODIFIERS = new Set(["Alt", "AltGraph", "Control", "Meta", "OS", "Shift", "Super", "Hyper", "Fn"]);
    let lastGesture = 0;
    ["click", "keydown", "touchstart", "pointerdown"].forEach(type => {
        window.addEventListener(type, e => {
            if (type === "keydown" && MODIFIERS.has(e.key)) return;
            lastGesture = performance.now();
        }, true);
    });

    // 頁面外的操作：鍵盤媒體鍵、Chrome 全域媒體控制、Windows 媒體浮窗、子母畫面的按鈕，
    // 都走 Media Session action，頁面收不到任何 click / keydown，而且頁面通常沒有焦點
    let lastExternal = 0;
    const EXTERNAL_MS = 1500;
    const external = () => performance.now() - lastExternal < EXTERNAL_MS;

    // 正在失焦 / 切走的事件裡呼叫的 pause() 一律是自動暫停（網站的 handler 是同步呼叫的話，
    // window.event 就是那個事件）
    const AUTO_EVENTS = new Set(["blur", "focusout", "visibilitychange", "pagehide", "freeze"]);
    const focused = () => document.hasFocus() && !document.hidden;

    // 放行條件：頁面外的媒體操作；或頁面內剛有手勢、而且頁面此刻仍有焦點且看得見。
    // 光看手勢時間窗不夠：點回視窗（pointerdown）後馬上點到別的視窗、或按 Alt+Tab，
    // 網站的 blur handler 都會在時間窗內呼叫 pause()，但那時頁面已經沒有焦點
    function allowPause() {
        if (!config().on) return true;
        if (external()) return true;
        if (AUTO_EVENTS.has(window.event?.type)) return false;
        return performance.now() - lastGesture < config().gestureMs && focused();
    }

    // ── 主要防線：攔住 Plyr 實例的 pause() ──
    let instance;

    function patch(player) {
        if (!player || typeof player.pause !== "function" || player.__antiPausePatched) {
            return player;
        }
        const origPause = player.pause.bind(player);
        player.pause = function () {
            if (allowPause()) return origPause();
            console.debug("[anti-pause] 已阻止一次自動暫停");
        };
        player.__antiPausePatched = true;
        return player;
    }

    Object.defineProperty(window, "player", {
        configurable: true,
        enumerable: true,
        get: () => instance,
        set: value => {
            instance = patch(value);
            // 給 health.js 檢查：攔到了、而且包住了 pause()（站台改版改掉 player 或 pause 時會是 no-pause）
            if (value) document.documentElement.dataset.vhAp = instance?.__antiPausePatched ? "hooked" : "no-pause";
        }
    });

    // ── Media Session：認出頁面外的暫停 / 播放 ──
    // 頁面沒設 handler 時，Chrome 直接對 <video> 呼叫 pause()，分不出是誰按的，
    // 所以先裝一組預設 handler（標記為使用者操作再照常暫停 / 播放）。
    // 網站之後自己設 handler 時也包一層標記，清掉（null）時換回預設的
    let lastMedia = null;   // 最近一個有聲音在播的 media，媒體鍵要控制的就是它
    // 影片可能先靜音自動播放、之後才開聲音，所以 volumechange 也要記
    for (const type of ["playing", "volumechange"]) {
        document.addEventListener(type, e => {
            const m = e.target;
            if (m instanceof HTMLMediaElement && !m.muted && !m.paused) lastMedia = m;
        }, true);
    }

    const ms = navigator.mediaSession;
    if (ms && typeof ms.setActionHandler === "function") {
        const target = () => {
            if (lastMedia?.isConnected) return lastMedia;
            // Plyr 的 media 就是主影片
            if (instance?.media instanceof HTMLMediaElement && instance.media.isConnected) return instance.media;
            const all = [...document.querySelectorAll("video, audio")];
            return all.find(m => !m.paused && !m.muted) || all.find(m => !m.paused) || null;
        };
        const DEFAULT_HANDLERS = {
            play: () => { lastExternal = performance.now(); target()?.play().catch(() => {}); },
            pause: () => { lastExternal = performance.now(); target()?.pause(); },
            stop: () => { lastExternal = performance.now(); target()?.pause(); },
        };
        const origSet = ms.setActionHandler.bind(ms);
        const install = (action, handler) => {
            try { origSet(action, handler); } catch { /* 不支援的 action */ }
        };
        ms.setActionHandler = function (action, handler) {
            if (!(action in DEFAULT_HANDLERS)) return origSet(action, handler);
            if (handler == null) return install(action, DEFAULT_HANDLERS[action]);
            return install(action, function () {
                lastExternal = performance.now();
                return handler.apply(this, arguments);
            });
        };
        for (const [action, handler] of Object.entries(DEFAULT_HANDLERS)) install(action, handler);
    }

    // ── 保底防線 ──
    // 萬一有程式繞過 window.player 直接對 <video> 呼叫 pause()，
    // 就在「頁面沒有焦點、不是頁面外的媒體操作、也不在子母畫面」時自動續播。
    // 這裡不看頁面內手勢：頁面有焦點時本來就不續播，沒焦點時剛有的 keydown 多半是 Alt+Tab 的 Alt。
    // media 事件不會冒泡，但 capture 階段仍會經過 document。
    document.addEventListener("pause", event => {
        const video = event.target;
        if (!(video instanceof HTMLMediaElement)) return;
        if (!config().on || !config().fallback) return;
        if (video.ended || video.seeking) return;
        if (focused() || external()) return;
        if (document.pictureInPictureElement === video) return;
        // 分頁隱藏時 Chrome 會自己暫停沒聲音的影片省電、切回來再自己續播，不要每秒跟它搶
        if (document.hidden && (video.muted || video.volume === 0)) return;

        video.play().catch(() => { /* 被 autoplay policy 擋下就算了 */ });
    }, true);
})();

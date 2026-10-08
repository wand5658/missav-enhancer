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
    let lastGesture = 0;

    ["click", "keydown", "touchstart", "pointerdown"].forEach(type => {
        window.addEventListener(type, () => { lastGesture = performance.now(); }, true);
    });

    // 這段時間（預設 700 ms）內的 pause 視為使用者主動操作
    const byUser = () => performance.now() - lastGesture < config().gestureMs;

    // 主要防線：攔住 Plyr 實例的 pause()
    let instance;

    function patch(player) {
        if (!player || typeof player.pause !== "function" || player.__antiPausePatched) {
            return player;
        }
        const origPause = player.pause.bind(player);
        player.pause = function () {
            if (!config().on || byUser()) {
                return origPause();
            }
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

    // 保底防線：萬一有程式繞過 window.player 直接對 <video> 呼叫 pause()，
    // 就在「視窗沒有焦點且非使用者操作」的情況下自動續播。
    // media 事件不會冒泡，但 capture 階段仍會經過 document。
    document.addEventListener("pause", event => {
        const video = event.target;
        if (!(video instanceof HTMLMediaElement)) return;
        if (!config().on || !config().fallback) return;
        if (video.ended || video.seeking) return;
        if (byUser() || document.hasFocus()) return;

        video.play().catch(() => { /* 被 autoplay policy 擋下就算了 */ });
    }, true);
})();

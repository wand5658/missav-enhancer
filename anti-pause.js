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

    const GESTURE_WINDOW = 700;   // ms，這段時間內的 pause 視為使用者主動操作
    let lastGesture = 0;

    ["click", "keydown", "touchstart", "pointerdown"].forEach(type => {
        window.addEventListener(type, () => { lastGesture = performance.now(); }, true);
    });

    const byUser = () => performance.now() - lastGesture < GESTURE_WINDOW;

    // 主要防線：攔住 Plyr 實例的 pause()
    let instance;

    function patch(player) {
        if (!player || typeof player.pause !== "function" || player.__antiPausePatched) {
            return player;
        }
        const origPause = player.pause.bind(player);
        player.pause = function () {
            if (byUser()) {
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
        set: value => { instance = patch(value); }
    });

    // 保底防線：萬一有程式繞過 window.player 直接對 <video> 呼叫 pause()，
    // 就在「視窗沒有焦點且非使用者操作」的情況下自動續播。
    // media 事件不會冒泡，但 capture 階段仍會經過 document。
    document.addEventListener("pause", event => {
        const video = event.target;
        if (!(video instanceof HTMLMediaElement)) return;
        if (video.ended || video.seeking) return;
        if (byUser() || document.hasFocus()) return;

        video.play().catch(() => { /* 被 autoplay policy 擋下就算了 */ });
    }, true);
})();

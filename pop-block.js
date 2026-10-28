// 擋掉影片頁點一下播放就跳出的廣告分頁（popunder）。
//
// 這是站台自己寫的：播放器外框 div.aspect-w-16 掛著 @click="pop()" 和 @keyup.space.window="pop()"，
// pop() 每頁第一次觸發時 window.open('/pop?url=<廣告網址>', '_blank')，
// 再每 300 ms 看那個視窗關了沒，關了（或根本沒開成）就 window.player.play()。
// 所以只要包住 window.open，遇到同網域的 /pop 就回 null —— 跟被瀏覽器擋下彈出視窗一樣，
// 站台會直接 play()，也就是你按播放本來要的結果。其他 window.open 一律照常。
//
// 必須以 world: "MAIN" + run_at: "document_start" 注入：
//   - MAIN world 才換得掉網頁自己的 window.open
//   - document_start 先換好，網頁任何腳本拿到的都是包過的那個
(function () {
    "use strict";

    // 開關由 browse.js 寫在 <html data-vh-pop="block|allow">；還沒寫入（設定還在讀）就當成擋
    const on = () => document.documentElement?.dataset.vhPop !== "allow";

    function isPop(url) {
        try {
            const u = new URL(String(url), location.href);
            return u.origin === location.origin && u.pathname.replace(/\/+$/, "") === "/pop";
        } catch {
            return false;
        }
    }

    // 空白鍵那條掛在 window 上，在搜尋框打字也會觸發。回 null 的話站台會馬上 play()，
    // 影片就在打字時自己播起來；這種情況改回一個永遠「還開著」的假視窗，站台就一直等、不會播
    function typing() {
        const e = window.event;
        const t = e?.target;
        return Boolean(e?.type?.startsWith("key") && t
            && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
    }
    const STILL_OPEN = Object.freeze({ closed: false, close() {}, focus() {}, blur() {} });

    const open = window.open;
    window.open = function (url, ...rest) {
        if (on() && isPop(url)) {
            console.debug("[pop-block] 已擋下一個廣告分頁", String(url).slice(0, 120));
            return typing() ? STILL_OPEN : null;
        }
        return open.call(this, url, ...rest);
    };
})();

// 設定（popup 和 content script 共用）。存在 chrome.storage.sync，跨裝置同步。
// 預設值 = 沒有設定時的行為；storage 裡只存使用者改過的。
// content script 這邊排在第二個 content_scripts 條目的最前面，hero.js / browse.js 等 VHS.ready 再啟動。
globalThis.VHS = (() => {
    const DEFAULTS = {
        lang: "auto",               // auto / zh / en（只影響 popup）
        motion: "system",           // system / full / reduce

        antiPause: true,
        gestureMs: 700,
        fallbackResume: true,

        hero: true,
        heroHome: true,
        heroList: true,
        heroHeight: "full",         // full / short
        heroSeconds: 12,
        heroFx: ["parallax", "zoom", "flip"],   // 可再加 push
        heroSpeed: 800,
        heroPreview: true,
        heroHD: true,               // 高畫質預覽（hd.js）：拿不到就用原本的 preview.mp4
        heroHDQuality: "auto",      // auto / 480p / 720p / 1080p
        heroHDPick: "smart",        // smart（看拖曳預覽圖挑）/ middle（片長一半）
        heroTint: true,

        home: true,
        homeRows: true,
        homePer: "auto",            // auto / 3 / 4 / 5 / 6
        homeZoom: 1.3,
        homeHideSearch: true,

        list: true,
        listChips: true,
        listPager: true,
        listCols: "3",              // site / 2 / 3 / 4

        video: true,
        videoTheater: true,
        videoGap: 12,
        videoHidePromo: true,

        look: true,
        ambient: true,
        ambientAlpha: 0.85,
        breathe: true,
        washAlpha: 0.55,
        glass: true,
        reveal: true,
        revealGap: 150,
        revealMs: 800,

        ads: true,
        hideAds: true,
    };

    // 項目 → 所屬的總開關。總開關關掉，底下的項目一律當成關
    const GROUPS = {
        antiPause: ["gestureMs", "fallbackResume"],
        hero: ["heroHome", "heroList", "heroHeight", "heroSeconds", "heroFx", "heroSpeed", "heroPreview", "heroHD", "heroHDQuality", "heroHDPick", "heroTint"],
        home: ["homeRows", "homePer", "homeZoom", "homeHideSearch"],
        list: ["listChips", "listPager", "listCols"],
        video: ["videoTheater", "videoGap", "videoHidePromo"],
        look: ["ambient", "ambientAlpha", "breathe", "washAlpha", "glass", "reveal", "revealGap", "revealMs"],
        ads: ["hideAds"],
    };
    const MASTER = {};
    for (const [m, keys] of Object.entries(GROUPS)) keys.forEach(k => { MASTER[k] = m; });

    // 會改 DOM 結構的設定：content script 只在載入時讀一次，改了要重新整理分頁
    const RELOAD = new Set(["home", "homeRows", "list", "listChips", "listPager", "video"]);

    const store = globalThis.chrome?.storage?.sync;
    let cur = { ...DEFAULTS };
    const subs = new Set();

    // 型別跟預設值不同的（舊版或手改的資料）一律丟掉
    function clean(obj) {
        const out = {};
        for (const [k, v] of Object.entries(obj || {})) {
            if (!(k in DEFAULTS)) continue;
            const d = DEFAULTS[k];
            if (Array.isArray(d) ? Array.isArray(v) : typeof v === typeof d) out[k] = v;
        }
        return out;
    }

    const ready = new Promise(resolve => {
        if (!store) { resolve(); return; }
        store.get(null, data => {
            cur = { ...DEFAULTS, ...clean(data) };
            resolve();
        });
    });

    globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
        if (area !== "sync") return;
        const keys = Object.keys(changes).filter(k => k in DEFAULTS);
        if (!keys.length) return;
        for (const k of keys) {
            const v = clean({ [k]: changes[k].newValue })[k];
            cur[k] = v === undefined ? DEFAULTS[k] : v;
        }
        subs.forEach(fn => fn(keys));
    });

    const sysReduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    sysReduce?.addEventListener("change", () => subs.forEach(fn => fn(["motion"])));

    return {
        DEFAULTS, GROUPS, MASTER, RELOAD, ready, clean,
        get: k => cur[k],
        all: () => ({ ...cur }),
        // 開關型設定的有效值：自己和總開關都要開
        on(k) {
            const m = MASTER[k];
            return Boolean(cur[k]) && (!m || Boolean(cur[m]));
        },
        reduced() {
            if (cur.motion === "reduce") return true;
            if (cur.motion === "full") return false;
            return Boolean(sysReduce?.matches);
        },
        subscribe(fn) { subs.add(fn); },
        set(patch) { return store ? store.set(clean(patch)) : Promise.resolve(); },
        reset() { return store ? store.clear() : Promise.resolve(); },
    };
})();

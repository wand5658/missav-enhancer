// 站台改版偵測。所有功能都綁著站台的 DOM 結構，站台一改就靜默失效，使用者又是手動更新，常常很久才發現。
// 這裡不在各個 init 當下判斷（卡片是 Alpine 之後才渲染的），而是事後檢查「結果」：
// 設定開著、頁面上也有該有的原料，卻沒看到擴充功能做出來的東西，就記一筆。
// 載入後 6 秒在 Console 印一次；popup 開啟時用 tabs.sendMessage 來要報告（不需要額外權限），
// 顯示在 popup 上，並可複製診斷資訊或直接開 GitHub issue。
(async () => {
    await VHS.ready;
    const html = document.documentElement;
    const kind = VH.kind();
    const has = s => Boolean(document.querySelector(s));
    const count = s => document.querySelectorAll(s).length;
    const shown = el => el.getClientRects().length > 0;

    function audit() {
        const miss = [];                    // { code, detail }
        const add = (code, detail = "") => miss.push({ code, detail });
        const root = document.querySelector(kind === "home" ? "div.is-home" : VH.LAYOUT_ROOT);
        const listUrl = VH.LIST_PAGES.some(re => re.test(location.pathname));

        if (listUrl && !root) add("root", "layout root not found");
        if (kind && root && !html.classList.contains("vh-ready")) add("ready", "browse.js did not finish");

        if (kind === "home" || kind === "list") {
            const heroOn = VH.hero() && VHS.on("hero") && VHS.on(kind === "home" ? "heroHome" : "heroList");
            const cards = count(".thumbnail");
            const cardVideos = count(kind === "home" ? 'video.preview[id^="preview-home-"]' : ".thumbnail video.preview");
            if (heroOn && cards && !has('[data-video-helper="hero"]'))
                add("hero", `${cards} cards, ${cardVideos} with preview video`);
        }
        if (kind === "home" && VHS.on("home") && VHS.on("homeRows") && !has("[data-vh-row]"))
            add("rows", `${count("div.is-home div.grid")} grids`);
        if (kind === "list" && root && VHS.on("list")) {
            // 下拉選單的標籤是「名稱: 值」；有這種標籤卻沒換成按鈕
            const labels = [...root.querySelectorAll(".relative > a > span")].filter(s => /[:：]/.test(s.textContent));
            if (VHS.on("listChips") && labels.length && !has(".vh-groups")) add("chips", `${labels.length} dropdowns`);
            const paged = [...root.querySelectorAll("nav a[href*='page=']")].some(a => !a.closest(".vh-pager, .vh-mini"));
            if (VHS.on("listPager") && paged && !has("nav.vh-pager")) add("pager");
        }
        if (kind === "video") {
            if (VHS.on("antiPause") && html.dataset.vhAp !== "hooked") add("antiPause", html.dataset.vhAp || "player not seen");
            if (VHS.on("video")) {
                if (!has(".order-last[data-vh-section]")) add("sidebar");
                if (VHS.on("videoTheater") && !html.style.getPropertyValue("--vh-player-top")) add("player");
            }
            if (VHS.on("look") && VHS.on("ambient") && !html.style.getPropertyValue("--vh-cover")) add("cover");
        }
        if (kind && VH.hero()) {
            // tidyCards 找不到標題（.my-2 a）的卡片不會被標記。片單頁（NO_HERO）的標題本來就不在卡片裡，不算
            const untidy = [...document.querySelectorAll(".thumbnail:not([data-vh-tidy])")].filter(shown).length;
            if (untidy) add("cardTitle", `${untidy} cards`);
        }
        const hd = globalThis.VHD?.stats;
        if (VHS.on("heroHD") && hd && hd.blocked >= 4 && !hd.ok) add("hdBlocked", `${hd.blocked} blocked`);
        return miss;
    }

    // 網址裡的番號、女優名、搜尋字不放進報告，只留頁面形狀
    const KEEP = new Set(["saved", "actresses", "ranking", "history", "search", "genres", "makers", "playlists", "new", "release"]);
    function pathShape() {
        if (kind === "home") return "/";
        if (kind === "video") return "/<video>";
        return location.pathname.split("/").map(s =>
            !s ? s : /^dm\d+$/.test(s) ? "dm<n>" : /^[a-z]{2}(-[a-z]+)?$/i.test(s) && s.length <= 5 ? s :
                KEEP.has(s) ? s : "<…>").join("/");
    }

    function report(miss) {
        const m = chrome.runtime.getManifest();
        const chrome_ = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] || "?";
        const os = navigator.userAgentData?.platform || navigator.platform;
        const changed = Object.entries(VHS.all())
            .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(VHS.DEFAULTS[k]))
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
        const hd = globalThis.VHD?.stats;
        return [
            `${m.name} ${m.version} · Chrome ${chrome_} · ${os}`,
            `Page: ${location.host} ${kind || "unknown"} ${pathShape()} · ${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
            `Checks: ${miss.length ? miss.map(x => x.detail ? `${x.code} (${x.detail})` : x.code).join("; ") : "all ok"}`,
            `Changed settings: ${changed.join(", ") || "none"}`,
            hd ? `HD: ok ${hd.ok} / blocked ${hd.blocked} / cached ${hd.cached}` : "",
        ].filter(Boolean).join("\n");
    }

    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
        if (msg?.type !== "vh:health") return;
        const miss = audit();
        reply({ kind, miss, report: report(miss) });
    });

    // 等 Alpine 渲染、hero 掛上、anti-pause 攔到 player
    setTimeout(() => {
        const miss = audit();
        if (!miss.length) return;
        console.warn(`[MissAV Enhancer] 此頁有 ${miss.length} 項功能沒有套用，可能是網站改版了。` +
            "點工具列的擴充功能圖示 →「回報問題」即可附上下面的診斷資訊。\n\n" + report(miss));
    }, 6000);
})();

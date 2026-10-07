(async function () {
    // 全站左右留白、首頁 Netflix 式橫列、列表頁把過濾／排序攤開成按鈕、影片頁劇院式版面。
    //
    // 排版全部在 browse.css：vh-wide 掛在所有有 layout root 的頁面（只管左右留白），
    // 改版規則掛在 html.vh-home / vh-list / vh-video 底下（該組設定開著才加），
    // 可以即時開關的掛在 applySettings() 寫的 class / CSS 變數底下。
    // 這裡只做 CSS 做不到的事：標記哪些網格要變橫列、插自己的節點、量尺寸。
    // 不寫任何 Alpine 會用 x-show 控制的 display —— 見 CLAUDE.md 登入 modal 那段。
    const html = document.documentElement;
    await VHS.ready;

    // 防暫停的設定：anti-pause.js 在 MAIN world 讀不到 chrome.storage，從 <html> 的 data 屬性讀。
    // 影片頁才用得到，但每一頁都寫，不依賴下面的頁面判斷
    function applyAntiPause() {
        html.dataset.vhAntiPause = JSON.stringify({
            on: VHS.get("antiPause"),
            gestureMs: VHS.get("gestureMs"),
            fallback: VHS.get("fallbackResume"),
        });
    }
    applyAntiPause();
    VHS.subscribe(applyAntiPause);

    // 廣告：browse.css 裡不分頁面種類的那幾條（右下角、直播小窗、頁尾上方 300×250）每一頁都要收，
    // 不能等下面的頁面判斷——認不得的頁面會在那裡就 return
    const applyAds = () => html.classList.toggle("vh-hide-ads", VHS.on("hideAds"));
    applyAds();
    VHS.subscribe(applyAds);

    // 網站的 primary 色（粉）：啟用中的按鈕（已收藏等）用它。量一個帶 text-primary 的元素；
    // 量到的跟 body 一樣表示站台沒有這個 class，留 browse.css 的預設值
    const probe = document.createElement("span");
    probe.className = "text-primary";
    probe.hidden = true;
    document.body.append(probe);
    const primary = getComputedStyle(probe).color;
    probe.remove();
    if (primary && primary !== getComputedStyle(document.body).color) html.style.setProperty("--vh-primary", primary);

    const kind = VH.kind();
    const root = document.querySelector(kind === "home" ? "div.is-home" : VH.LAYOUT_ROOT);
    if (!root) return;
    html.classList.add("vh-wide");
    if (!kind) return;
    html.dataset.vhKind = kind;         // 廣告這類跟改版開關無關的規則用它認頁面

    // 會改 DOM 結構的設定只在載入時讀一次，popup 改了要重新整理（settings.js 的 RELOAD）
    const restyle = VHS.on(kind);       // 設定 key 剛好就是 home / list / video
    if (restyle) html.classList.add(`vh-${kind}`);
    const ROWS = restyle && (kind === "video" || VHS.on("homeRows"));
    const CHIPS = kind === "list" && restyle && VHS.on("listChips");
    const PAGER = kind === "list" && restyle && VHS.on("listPager");
    // 沒有影片卡（也就不會有 hero）的格子頁，每一格是一個進場單位：
    // 女優頭像網格（收藏的女優、女優一覽、女優排行）、片單列表（/playlists）、類型／發行商一覽
    const PEOPLE = kind === "list" && Boolean(root.querySelector(":scope > div > ul.grid img"));
    const LISTS = kind === "list" && !root.querySelector(".thumbnail") &&
        Boolean(root.querySelector(':scope > div[x-data] ul[role="list"] > li > a[href*="/playlists/"]'));
    const TAGS = kind === "list" && Boolean(root.querySelector(":scope > div > div.grid > div > p > a"));
    const TILES = PEOPLE ? ":scope > div > ul.grid > li" :
        LISTS ? ':scope > div[x-data] ul[role="list"] > li' :
        TAGS ? ":scope > div > div.grid > div" : null;
    // 自己的收藏、片單格子少，一載入就整頁一個一個演；女優一覽（24）、排行（100）、類型（36）照捲動演，
    // 不然最下面那格要等十幾秒
    const SHEET = TILES && /^\/(saved|playlists)(\/|$)/.test(location.pathname) ? TILES : null;

    const reduced = () => VHS.reduced();
    const heroOn = () => VH.hero() && VHS.on("hero") && VHS.on(kind === "home" ? "heroHome" : "heroList");

    // ── 頁首高度 ──────────────────────────────────────────────
    // 頁首是 fixed 的；sticky 工具列要停在它下面，首頁 hero 要往上鑽到它底下
    const header = document.querySelector("div.fixed.z-max.w-full");
    function measureHeader() {
        const h = header ? header.getBoundingClientRect().height : 0;
        document.documentElement.style.setProperty("--vh-header", `${Math.round(h)}px`);
    }
    measureHeader();
    if (header) new ResizeObserver(measureHeader).observe(header);

    // ── 首頁、列表頁：hero 滿版 ───────────────────────────────
    // 用量的而不是 100vw：100vw 含捲軸寬度，Windows 上會多出橫向捲軸
    function placeHero() {
        const host = root.querySelector(':scope > [data-video-helper="hero"]');
        if (!host) return;
        host.style.marginLeft = host.style.marginTop = host.style.width = "";
        const r = host.getBoundingClientRect();
        host.style.marginLeft = `${-r.left}px`;
        host.style.width = `${document.documentElement.clientWidth}px`;
        host.style.marginTop = `${-(r.top + scrollY)}px`;     // 拉到文件頂端，讓頁首疊在上面
    }

    // ── 橫列（首頁各區塊、影片頁的接著看與相關影片）───────────
    const rows = [];

    function rowGrids() {
        // 影片頁：側欄（接著看，推薦清單前 13 部）和最下面的相關影片（第 14～29 部）
        if (kind === "video") return [
            ...root.querySelectorAll(":scope > div.flex[x-data] > div.order-last > div"),
            ...root.querySelectorAll("div.relative.overflow-hidden > div.grid"),
        ];
        // 首頁：隨機區（標題列有「好手氣」按鈕）維持網格
        return [...root.querySelectorAll("div.grid")].filter(grid =>
            grid.parentElement && !grid.parentElement.querySelector(":scope > div button.button-primary"));
    }

    function initRows() {
        rowGrids().forEach(grid => {
            if (grid.hasAttribute("data-vh-row")) return;
            const section = grid.parentElement;

            grid.setAttribute("data-vh-row", "");
            section.setAttribute("data-vh-section", "");
            if (kind === "video") {
                // 影片頁這兩區原本沒有標題（側欄的「接著看」也是自己加的）
                const h = document.createElement("h2");
                h.className = "vh-row-title";
                h.textContent = section.matches(".order-last") ? "接著看" : "相關影片";
                grid.before(h);
            }

            const prev = arrow("prev", "上一組", "M15 5l-7 7 7 7");
            const next = arrow("next", "下一組", "M9 5l7 7-7 7");
            section.append(prev, next);
            const row = { grid, section, prev, next };
            rows.push(row);

            const step = dir => grid.scrollBy({
                left: dir * grid.clientWidth * 0.9,
                behavior: reduced() ? "auto" : "smooth",
            });
            prev.addEventListener("click", () => step(-1));
            next.addEventListener("click", () => step(1));

            let ticking = false;
            grid.addEventListener("scroll", () => {
                if (ticking) return;
                ticking = true;
                requestAnimationFrame(() => { ticking = false; syncArrows(row); });
            }, { passive: true });

            // ←/→ 在同一列的卡片之間移動焦點。只在焦點落在卡片上時攔截，播放器的方向鍵快轉不受影響
            grid.addEventListener("keydown", e => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                const cards = visibleCards(grid);
                const i = cards.findIndex(c => c.contains(document.activeElement));
                if (i < 0) return;
                const to = cards[i + (e.key === "ArrowRight" ? 1 : -1)];
                if (!to) return;
                e.preventDefault();
                const a = cardTitle(to) || to.querySelector("a[href]");
                a?.focus({ preventScroll: true });
                to.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reduced() ? "auto" : "smooth" });
            });
        });
        layoutRows();
    }

    function arrow(cls, label, d) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `vh-arrow ${cls}`;
        b.setAttribute("aria-label", label);
        b.tabIndex = -1;            // 鍵盤用 ←/→，箭頭只給滑鼠
        b.hidden = true;
        b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
        return b;
    }

    // 橫列裡的每一格。被 x-show 藏起來的 placeholder、<template>、廣告都不算
    function visibleCards(grid) {
        return [...grid.children].filter(c =>
            c.offsetParent !== null && (c.matches(".thumbnail") || c.querySelector(".thumbnail")));
    }

    // 卡片的標題連結：一般卡片在 .thumbnail 裡的 .my-2；影片頁側欄的卡片標題在縮圖旁邊的 div.flex-1
    function cardTitle(el) {
        return el.querySelector(".my-2 a") ||
            el.closest("[data-vh-row] > div.flex")?.querySelector(":scope > div.flex-1 a[href]") || null;
    }

    function syncArrows({ grid, prev, next }) {
        const max = grid.scrollWidth - grid.clientWidth;
        prev.hidden = grid.scrollLeft <= 2;
        next.hidden = grid.scrollLeft >= max - 2;
    }

    // 橫列往右延伸到視窗邊緣（露出下一張），箭頭貼齊橫列的高度
    function layoutRows() {
        const vw = document.documentElement.clientWidth;
        for (const row of rows) {
            const { grid, section, prev, next } = row;
            const s = section.getBoundingClientRect();
            const padR = parseFloat(getComputedStyle(section).paddingRight) || 0;
            // --vh-bleed：橫列內容右緣到視窗右緣；--vh-edge：區塊外框右緣到視窗右緣（給箭頭）
            section.style.setProperty("--vh-bleed", `${Math.max(0, vw - s.right + padR)}px`);
            section.style.setProperty("--vh-edge", `${Math.max(0, vw - s.right)}px`);
            section.style.setProperty("--vh-pad", `${parseFloat(getComputedStyle(section).paddingLeft) || 0}px`);
            const top = `${grid.offsetTop}px`;
            const height = `${grid.offsetHeight}px`;
            for (const b of [prev, next]) { b.style.top = top; b.style.height = height; }
            syncArrows(row);
        }
    }

    // ── 列表頁：工具列 ────────────────────────────────────────
    function initToolbar() {
        // 女優一覽的排序下拉在靠右的 div.flex.justify-end.mb-3 裡
        const old = root.querySelector(":scope > div.flex.justify-between.mb-6, :scope > div.flex.justify-end.mb-3");
        if (!old || old.classList.contains("vh-gone")) return;

        // 只轉「名稱: 值」的下拉。其他的（收藏女優頁的「我的帳戶」，選項是登出、刪除帳號，
        // 有的靠 @click 而不是 href）留在原本的工具列裡
        const boxes = [...old.querySelectorAll(":scope > .relative")];
        const groups = boxes.map(box => {
            const label = box.querySelector(":scope > a > span")?.textContent.trim() || "";
            if (!/[:：]/.test(label)) return null;
            const [name, current = ""] = label.split(/[:：]/).map(t => t.trim());
            const options = [...box.querySelectorAll(":scope > div a[href]")]
                .map(a => ({ text: a.textContent.trim(), href: a.href }))
                .filter(o => o.text);
            return { box, name, current, options };
        }).filter(g => g && g.name && g.options.length);
        if (!groups.length) return;         // 結構跟預期不同就保留原本的下拉

        const bar = document.createElement("div");
        bar.className = "vh-toolbar";
        for (const g of groups) {
            const group = document.createElement("div");
            group.className = "vh-group";
            group.setAttribute("role", "group");
            group.setAttribute("aria-label", g.name);
            const name = document.createElement("span");
            name.className = "vh-group-name";
            name.textContent = g.name;
            const chips = document.createElement("div");
            chips.className = "vh-chips";
            for (const o of g.options) {
                const a = document.createElement("a");
                a.className = "vh-chip";
                a.href = o.href;
                a.textContent = o.text;
                if (o.text === g.current) a.setAttribute("aria-current", "true");
                chips.append(a);
            }
            group.append(name, chips);
            bar.append(group);
        }

        const page = PAGER ? pageInfo() : null;
        if (page) bar.append(miniPager(page));

        old.before(bar);
        // 全部轉完才收整條；有留下來的就只收轉過的那幾格（.relative 沒有 x-show）
        if (groups.length === boxes.length) old.classList.add("vh-gone");
        else groups.forEach(g => g.box.classList.add("vh-gone"));
    }

    // 網站原本的分頁列（不是自己插的 .vh-pager / .vh-mini）
    function siteNav() {
        return root.querySelector("nav:not(.vh-pager, .vh-mini)");
    }

    // { now, total }，都是數字；total 0 表示不知道
    function pageInfo() {
        const nav = siteNav();
        if (!nav) return null;
        // 目前頁是分頁列裡唯一不是連結的數字
        const cur = [...nav.querySelectorAll("span")].find(s =>
            !s.querySelector("*") && /^\d+$/.test(s.textContent.trim()) && !s.closest("a"));
        const now = parseInt(cur ? cur.textContent : new URLSearchParams(location.search).get("page")) || 1;
        // 總頁數：手機版輸入框旁的「/ 2000」；沒有就取頁碼連結裡最大的
        const tot = [...nav.querySelectorAll("span")]
            .map(s => /^\/\s*(\d+)$/.exec(s.textContent.trim()))
            .find(Boolean);
        const linked = [...nav.querySelectorAll("a[href]")]
            .map(a => parseInt(new URL(a.href, location.href).searchParams.get("page")) || 0);
        return { now, total: tot ? parseInt(tot[1]) : Math.max(0, ...linked) };
    }

    function pageUrl(n) {
        const u = new URL(location.href);
        u.searchParams.set("page", n);
        u.hash = "";
        return u.href;
    }

    // 回傳是否真的換頁；超出範圍就夾到頭尾
    function goPage(n, { now, total }) {
        n = parseInt(n);
        if (!n) return false;
        n = Math.max(1, total ? Math.min(total, n) : n);
        if (n === now) return false;
        location.href = pageUrl(n);
        return true;
    }

    const ICON_PREV = "M15 5l-7 7 7 7";
    const ICON_NEXT = "M9 5l7 7-7 7";
    function icon(d) {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
    }

    // 上一頁 / 下一頁：能去就是真的連結（中鍵、Ctrl 點可開新分頁），到頭了換成不能點的 span
    function pageLink(n, ok, cls, label, html) {
        const el = document.createElement(ok ? "a" : "span");
        el.className = cls;
        el.setAttribute("aria-label", label);
        if (ok) el.href = pageUrl(n);
        else el.setAttribute("aria-disabled", "true");
        el.innerHTML = html;
        return el;
    }

    function pageInput(label) {
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "numeric";
        input.maxLength = 5;
        input.setAttribute("aria-label", label);
        return input;
    }

    // ── 列表頁：工具列右側的翻頁器 ‹ 第 [N] / M 頁 › ────────────
    // 工具列黏在頁首下面，捲到一半也能換頁。頁碼點一下全選，Enter 跳頁，Esc / 離開還原
    function miniPager(page) {
        const { now, total } = page;
        const nav = document.createElement("nav");
        nav.className = "vh-mini";
        nav.setAttribute("aria-label", "翻頁");

        const box = document.createElement("label");
        box.className = "vh-mini-box";
        const input = pageInput("頁碼");
        input.value = now;
        input.addEventListener("focus", () => input.select());
        input.addEventListener("keydown", e => {
            if (e.key === "Enter") { if (!goPage(input.value, page)) input.value = now; }
            else if (e.key === "Escape") { input.value = now; input.blur(); }
        });
        input.addEventListener("blur", () => { input.value = now; });
        const pre = document.createElement("span");
        pre.textContent = "第";
        const post = document.createElement("span");
        post.textContent = total ? `/ ${total} 頁` : "頁";
        box.append(pre, input, post);

        nav.append(
            pageLink(now - 1, now > 1, "vh-mini-arrow", "上一頁", icon(ICON_PREV)),
            box,
            pageLink(now + 1, !total || now < total, "vh-mini-arrow", "下一頁", icon(ICON_NEXT)),
        );
        return nav;
    }

    // ── 列表頁：底部分頁列 ────────────────────────────────────
    // 兩端大按鈕；中間頁碼以目前頁為中心（1 … p-2 p-1 [p] p+1 p+2 … M）；最下面跳頁。
    // 原本的分頁列只用 class 藏起來（它沒有 x-show）：它身上綁著網站的 → 換頁，藏起來照樣有效
    function initPager() {
        const nav = siteNav();
        if (!nav || nav.classList.contains("vh-gone")) return;
        const page = pageInfo();
        if (!page || page.total < 2) return;
        const { now, total } = page;

        const bar = document.createElement("nav");
        bar.className = "vh-pager";
        bar.setAttribute("aria-label", "分頁");

        const nums = document.createElement("div");
        nums.className = "vh-nums";
        const show = new Set([1, total]);
        for (let d = -2; d <= 2; d++) if (now + d >= 1 && now + d <= total) show.add(now + d);
        let prev = 0;
        for (const n of [...show].sort((a, b) => a - b)) {
            if (n - prev > 1) {
                const gap = document.createElement("span");
                gap.className = "vh-gap";
                gap.textContent = "…";
                nums.append(gap);
            }
            const el = document.createElement(n === now ? "span" : "a");
            el.className = "vh-num" + (Math.abs(n - now) > 1 ? " vh-far" : "");
            el.textContent = n;
            if (n === now) el.setAttribute("aria-current", "page");
            else { el.href = pageUrl(n); el.setAttribute("aria-label", `第 ${n} 頁`); }
            nums.append(el);
            prev = n;
        }

        const form = document.createElement("form");
        form.className = "vh-jump";
        const input = pageInput("跳到頁碼");
        const go = document.createElement("button");
        go.type = "submit";
        go.textContent = "前往";
        const t1 = document.createElement("span");
        t1.textContent = "跳到第";
        const t2 = document.createElement("span");
        t2.textContent = "頁";
        form.append(t1, input, t2, go);
        form.addEventListener("submit", e => {
            e.preventDefault();
            if (!goPage(input.value, page)) input.value = "";
        });

        bar.append(
            pageLink(now - 1, now > 1, "vh-big prev", "上一頁",
                `${icon(ICON_PREV)}<span class="vh-big-label">上一頁</span><kbd>←</kbd>`),
            nums,
            pageLink(now + 1, now < total, "vh-big next", "下一頁",
                `<kbd>→</kbd><span class="vh-big-label">下一頁</span>${icon(ICON_NEXT)}`),
            form,
        );
        nav.before(bar);
        nav.classList.add("vh-gone");

        // 網站在分頁列上綁 @keyup.arrow-right（第 1 頁沒有 ←）；沒綁的方向自己補，綁了就不重複
        const bound = key => nav.getAttributeNames().some(a => a.startsWith(`@keyup.${key}`));
        for (const [attr, key, to, ok] of [
            ["arrow-left", "ArrowLeft", now - 1, now > 1],
            ["arrow-right", "ArrowRight", now + 1, now < total],
        ]) {
            if (!ok || bound(attr)) continue;
            addEventListener("keyup", e => {
                if (e.key !== key || e.target.tagName === "INPUT") return;
                if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                location.href = pageUrl(to);
            });
        }
    }

    // ── 影片頁：側欄 ──────────────────────────────────────────
    // 伺服器端寫死 inline max/min-width: 300px，CSS 蓋不過 inline，只能拿掉（Alpine 不管這個屬性）。
    // 側欄本身改成播放器下方的「接著看」橫列，由 initRows 處理
    function initSide() {
        const side = root.querySelector(":scope > div.flex[x-data] > div.order-last");
        if (!side || side.dataset.vhSide) return;
        side.dataset.vhSide = "1";
        side.style.maxWidth = side.style.minWidth = "";
    }

    // ── 影片頁：環境光的封面 ──────────────────────────────────
    // og:image 和播放器的 data-poster 都是伺服器端就有的 cover-n.jpg；寫成 CSS 變數給 browse.css 的三層環境光
    function initAmbient() {
        const src = document.querySelector('meta[property="og:image"]')?.content ||
            root.querySelector("video.player")?.dataset.poster || "";
        if (!/^https:\/\/[^"\\\s)]+$/.test(src)) return;
        const value = `url("${src}")`;
        if (document.documentElement.style.getPropertyValue("--vh-cover") !== value)
            document.documentElement.style.setProperty("--vh-cover", value);
    }

    // ── 影片頁：播放器頂端位置 ────────────────────────────────
    // browse.css 用它算播放器寬度，讓影片高度剛好到視窗底線上方。頂端位置跟寬度無關，量一次不會互相影響
    function measurePlayer() {
        const box = root.querySelector(":scope > div.flex[x-data] > div.flex-1 > div[x-data]:first-child > div:first-child");
        if (!box) return;
        const top = Math.round(box.getBoundingClientRect().top + scrollY);
        document.documentElement.style.setProperty("--vh-player-top", `${Math.max(0, top)}px`);
    }

    // ── 卡片：hover 放大的原點 ────────────────────────────────
    // 放大（預設 1.3 倍，設定 homeZoom，CSS 的 --vh-zoom 由 applySettings 寫）時，
    // 靠邊的卡片從中心放大會被橫列（或視窗）切掉一截。
    // 進入卡片時量一次：左邊不夠就從左緣放大、右邊不夠就從右緣。CSS 有 0.3s 延遲，量的時候還沒放大
    // 影片頁接著看放大的是整個項目（標題在 .thumbnail 外面），所以先找項目
    root.addEventListener("pointerover", e => {
        const card = e.target.closest?.(".order-last[data-vh-section] [data-vh-row] > div.flex")
            || e.target.closest?.(".thumbnail");
        if (!card || card.contains(e.relatedTarget)) return;
        const r = card.getBoundingClientRect();
        const row = card.closest("[data-vh-row]");
        const box = row ? row.getBoundingClientRect() : { left: 0, right: Infinity };
        const left = Math.max(box.left, 0);
        const right = Math.min(box.right, document.documentElement.clientWidth);
        const grow = r.width * (VHS.get("homeZoom") - 1) / 2;
        card.style.transformOrigin =
            r.left - grow < left ? "left center" :
            r.right + grow > right ? "right center" : "";
    });

    // ── 卡片：一張只停一次 Tab ────────────────────────────────
    // 每張卡有封面、徽章、片長、標題好幾個連結，全部指向同一頁。只留標題那個
    // （影片頁側欄的標題在 .thumbnail 外面，要等 initRows 標好橫列才找得到，所以 refresh 先跑 initRows）
    function tidyCards() {
        root.querySelectorAll(".thumbnail").forEach(card => {
            if (card.dataset.vhTidy) return;
            const title = cardTitle(card);
            if (!title) return;                 // Alpine 還沒渲染完，下一輪再處理
            card.dataset.vhTidy = "1";
            card.querySelectorAll("a[href]").forEach(a => { if (a !== title) a.tabIndex = -1; });
        });
        // 類型、發行商的卡片：名稱和片數是同一個連結，只留名稱
        if (TAGS) root.querySelectorAll(":scope > div > div.grid > div > p > a").forEach(a => { a.tabIndex = -1; });
    }

    // ── 卡片：捲動進場 ────────────────────────────────────────
    // 卡片進入畫面時淡入上浮一次（browse.css 的 .vh-rv / .vh-in），同一批依畫面順序（上到下、左到右）錯開。
    // 動的是卡片在網格／橫列裡的那一格（可能就是 .thumbnail 本身）；只動 opacity 和 translate，不碰 display。
    // 演完把 class 拿掉，卡片回到原本的樣式，不留多餘的 transition。
    // 間隔、長度來自設定（revealGap / revealMs；長度同時寫成 CSS 的 --vh-rv-ms）
    const revealOn = () => VHS.on("reveal") && !reduced();
    let revealBatch = [];
    const revealIO = new IntersectionObserver(entries => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            revealIO.unobserve(e.target);
            if (!revealBatch.length) requestAnimationFrame(revealFlush);
            revealBatch.push(e.target);
        }
    }, { threshold: 0.15 });

    function revealFlush() {
        const items = revealBatch.map(el => ({ el, r: el.getBoundingClientRect() }));
        revealBatch = [];
        items.sort((a, b) => Math.round(a.r.top - b.r.top) || a.r.left - b.r.left);
        const gap = VHS.get("revealGap");
        // 一般頁面同一批最多錯開 8 個，之後的同時出現。女優頁、片單列表（SHEET）整頁一起演，不設上限：
        // 每個都隔同樣的間隔一個一個浮出，越下面越晚；長度放慢成 1.25 倍（跟著設定走）
        const ms = VHS.get("revealMs") * (SHEET ? 1.25 : 1);
        items.forEach(({ el }, i) => {
            const delay = (SHEET ? i : Math.min(i, 8)) * gap;
            el.style.setProperty("--vh-rv-d", `${delay}ms`);
            if (SHEET) el.style.setProperty("--vh-rv-ms", `${ms}ms`);
            el.classList.add("vh-in");
            setTimeout(() => {
                el.classList.remove("vh-rv", "vh-in");
                el.style.removeProperty("--vh-rv-d");
                el.style.removeProperty("--vh-rv-ms");
            }, delay + ms + 50);
        });
    }

    // 首頁、列表頁的 hero 是之後才插進來的。插進來之前卡片就在第一屏，一觀察就演完了，
    // 等 hero 把它們推到下面，使用者捲下去看到的是已經出現好的卡片。
    // 所以先只標 .vh-rv（藏起來），等 hero 就位（或等不到它）才開始觀察
    let revealReady = kind === "video" || Boolean(TILES) || !heroOn();
    const pending = [];
    if (!revealReady) setTimeout(() => startReveal(), 3000);   // 保險：沒有可輪播的卡片時 hero 不會出現

    function startReveal() {
        if (revealReady) return;
        revealReady = true;
        // 等 placeHero 的版面生效再觀察
        requestAnimationFrame(() => pending.splice(0).forEach(u => revealIO.observe(u)));
    }

    // 設定關掉時：還藏著的卡片立刻出現，之後也不再標
    function clearReveal() {
        pending.length = 0;
        revealBatch = [];
        root.querySelectorAll(".vh-rv").forEach(el => {
            revealIO.unobserve(el);
            el.classList.remove("vh-rv", "vh-in");
            el.style.removeProperty("--vh-rv-d");
        });
    }

    // 標成 .vh-rv（透明）時先關掉 transition：元素可能已經畫在畫面上，帶著 transition 會從可見慢慢淡成透明，
    // 緊接著加上 .vh-in 又轉回可見，看起來就像沒演。整批一起標、只強制算一次樣式
    function hideForReveal(els) {
        if (!els.length) return;
        const prev = els.map(el => el.style.transition);
        for (const el of els) {
            el.style.transition = "none";
            el.classList.add("vh-rv");
        }
        void root.offsetWidth;          // 讓透明狀態先生效，之後的 .vh-in 才有起點
        els.forEach((el, i) => { el.style.transition = prev[i]; });
    }

    function initReveal() {
        if (!revealOn()) return;
        const marked = [];
        root.querySelectorAll(".thumbnail").forEach(card => {
            // 沒有排版框的卡片不標：隨機區的預載卡藏在 .hidden 容器裡，「好手氣」會把它的
            // innerHTML 原封不動複製進網格，標過的 vh-rv（透明）跟著過去卻再也不會被觀察到
            if (!card.getClientRects().length) return;
            // 片單裡的影片：一列是 li（縮圖＋評語表單），整列一起演
            const unit = card.closest('[data-vh-row] > *, div.grid > *, ul[role="list"] > li') || card;
            if (unit.dataset.vhRv) return;
            unit.dataset.vhRv = "1";
            marked.push(unit);
        });
        hideForReveal(marked);
        marked.forEach(unit => {
            if (revealReady) revealIO.observe(unit);
            else pending.push(unit);
        });
        // 沒有 .thumbnail 的格子（TILES）。上面沒有輪播：SHEET 不用等捲到才演，整頁一起進同一批，
        // 依畫面順序錯開；其他的直接觀察
        if (TILES) {
            const tiles = [...root.querySelectorAll(TILES)].filter(t => !t.dataset.vhRv);
            tiles.forEach(t => { t.dataset.vhRv = "1"; });
            hideForReveal(tiles);
            if (SHEET) {
                if (tiles.length && !revealBatch.length) requestAnimationFrame(revealFlush);
                revealBatch.push(...tiles);
            } else tiles.forEach(t => revealIO.observe(t));
        }
        // hero 的 host 一插進來時裡面還是 hidden（第一張封面載完才顯示），高度幾乎是 0；
        // 那個切換發生在 Shadow DOM 裡，上面的 MutationObserver 看不到，所以盯 host 的尺寸
        const host = root.querySelector(':scope > [data-video-helper="hero"]');
        if (!revealReady && host && !host.dataset.vhRvWatch) {
            host.dataset.vhRvWatch = "1";
            const ro = new ResizeObserver(() => {
                if (host.getBoundingClientRect().height < 100) return;
                ro.disconnect();
                placeHero();
                startReveal();
            });
            ro.observe(host);
        }
    }

    // ── 設定：即時套用的部分 ──────────────────────────────────
    // 全部寫成 <html> 的 class / CSS 變數，browse.css 掛在它們底下；popup 改設定時重跑
    function applySettings() {
        const on = k => VHS.on(k);
        const cls = (name, v) => html.classList.toggle(name, Boolean(v));
        const css = (name, v) => html.style.setProperty(name, String(v));

        cls("vh-reduce", reduced());
        cls("vh-hide-ads", on("hideAds"));
        cls("vh-hide-search", on("homeHideSearch"));

        const per = VHS.get("homePer");
        cls("vh-per-fixed", per !== "auto");
        if (per !== "auto") css("--vh-per-n", Number(per) + 0.4);      // 多 0.4 張是故意露出的下一張
        css("--vh-zoom", VHS.get("homeZoom"));
        for (const n of ["2", "3", "4"]) cls(`vh-cols-${n}`, on("list") && VHS.get("listCols") === n);

        const video = kind === "video" && restyle;
        cls("vh-theater", video && on("videoTheater"));
        css("--vh-player-gap", `${VHS.get("videoGap")}px`);
        cls("vh-hide-promo", video && on("videoHidePromo"));
        const ambient = video && on("ambient");
        cls("vh-ambient", ambient);
        cls("vh-breathe", ambient && on("breathe"));
        const a = VHS.get("ambientAlpha");
        css("--vh-halo-a", a);
        css("--vh-top-a", Math.min(1, a + 0.05));
        // 全頁染色：影片頁跟著環境光；首頁、列表頁要輪播開著且選了「背景跟著封面換色」
        cls("vh-tint", on("look") && (kind === "video" ? ambient : heroOn() && on("heroTint")));
        css("--vh-wash-a", VHS.get("washAlpha"));
        cls("vh-glass", video && on("glass"));
        css("--vh-rv-ms", `${VHS.get("revealMs")}ms`);
        if (!revealOn()) clearReveal();
    }

    // ── 啟動 ──────────────────────────────────────────────────
    function refresh() {
        if (kind === "home") {
            if (ROWS) initRows();
            placeHero();
        } else if (kind === "video") {
            if (restyle) {
                initAmbient();
                measurePlayer();
                initSide();
                initRows();
            }
        } else {
            if (CHIPS) initToolbar();
            if (PAGER) initPager();
            placeHero();
        }
        tidyCards();
        initReveal();               // 在 initRows 之後：要先知道哪些網格變成橫列
    }

    applySettings();
    refresh();
    VHS.subscribe(() => {
        applySettings();
        initReveal();                           // 捲動進場剛被打開時，從現在起的卡片開始標
        if (kind !== "video") placeHero();      // 輪播開關、高度會改 hero 的尺寸
        layoutRows();
    });

    // 推薦區、hero 都是之後才渲染進來的。只盯 layout root，不盯整個 body
    let queued = false;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        setTimeout(() => { queued = false; refresh(); }, 200);
    }).observe(root, { childList: true, subtree: true });

    addEventListener("resize", () => {
        if (kind !== "video") placeHero();
        if (kind === "list") return;
        if (kind === "video" && restyle) measurePlayer();
        layoutRows();
    });
})();

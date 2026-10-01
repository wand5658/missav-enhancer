(function () {
    // 全站左右留白、首頁 Netflix 式橫列、列表頁把過濾／排序攤開成按鈕、影片頁劇院式版面。
    //
    // 排版全部在 browse.css：vh-wide 掛在所有有 layout root 的頁面（只管左右留白），
    // 其餘規則掛在 html.vh-home / vh-list / vh-video 底下。
    // 這裡只做 CSS 做不到的事：標記哪些網格要變橫列、插自己的節點、量尺寸。
    // 不寫任何 Alpine 會用 x-show 控制的 display —— 見 CLAUDE.md 登入 modal 那段。
    const kind = VH.kind();
    const root = document.querySelector(kind === "home" ? "div.is-home" : VH.LAYOUT_ROOT);
    if (!root) return;
    document.documentElement.classList.add("vh-wide");
    if (!kind) return;
    document.documentElement.classList.add(`vh-${kind}`);

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");

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
                behavior: reduced.matches ? "auto" : "smooth",
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
                to.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reduced.matches ? "auto" : "smooth" });
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
        const old = root.querySelector(":scope > div.flex.justify-between.mb-6");
        if (!old || old.classList.contains("vh-gone")) return;

        const groups = [...old.querySelectorAll(":scope > .relative")].map(box => {
            const label = box.querySelector(":scope > a > span")?.textContent.trim() || "";
            const [name, current = ""] = label.split(/[:：]/).map(t => t.trim());
            const options = [...box.querySelectorAll(":scope > div a[href]")]
                .map(a => ({ text: a.textContent.trim(), href: a.href }))
                .filter(o => o.text);
            return { name, current, options };
        }).filter(g => g.name && g.options.length);
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

        const page = pageInfo();
        if (page) bar.append(miniPager(page));

        old.before(bar);
        old.classList.add("vh-gone");
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
    // 放大 1.3 倍，靠邊的卡片從中心放大會被橫列（或視窗）切掉一截。
    // 進入卡片時量一次：左邊不夠就從左緣放大、右邊不夠就從右緣。CSS 有 0.3s 延遲，量的時候還沒放大
    const ZOOM = 1.3;               // 跟 browse.css 的 --vh-zoom 一起改
    root.addEventListener("pointerover", e => {
        const card = e.target.closest?.(".thumbnail");
        if (!card || card.contains(e.relatedTarget)) return;
        const r = card.getBoundingClientRect();
        const row = card.closest("[data-vh-row]");
        const box = row ? row.getBoundingClientRect() : { left: 0, right: Infinity };
        const left = Math.max(box.left, 0);
        const right = Math.min(box.right, document.documentElement.clientWidth);
        const grow = r.width * (ZOOM - 1) / 2;
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
    }

    // ── 卡片：捲動進場 ────────────────────────────────────────
    // 卡片進入畫面時淡入上浮一次（browse.css 的 .vh-rv / .vh-in），同一批依畫面順序（上到下、左到右）錯開。
    // 動的是卡片在網格／橫列裡的那一格（可能就是 .thumbnail 本身）；只動 opacity 和 translate，不碰 display。
    // 演完把 class 拿掉，卡片回到原本的樣式，不留多餘的 transition
    const REVEAL_MS = 800;          // 跟 browse.css 的 .vh-rv 一起改
    const REVEAL_GAP = 150;
    let revealBatch = [];
    const revealIO = reduced.matches ? null : new IntersectionObserver(entries => {
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
        items.forEach(({ el }, i) => {
            const delay = Math.min(i, 8) * REVEAL_GAP;
            el.style.setProperty("--vh-rv-d", `${delay}ms`);
            el.classList.add("vh-in");
            setTimeout(() => {
                el.classList.remove("vh-rv", "vh-in");
                el.style.removeProperty("--vh-rv-d");
            }, delay + REVEAL_MS + 50);
        });
    }

    // 首頁、列表頁的 hero 是之後才插進來的。插進來之前卡片就在第一屏，一觀察就演完了，
    // 等 hero 把它們推到下面，使用者捲下去看到的是已經出現好的卡片。
    // 所以先只標 .vh-rv（藏起來），等 hero 就位（或等不到它）才開始觀察
    let revealReady = kind === "video";
    const pending = [];
    if (!revealReady) setTimeout(() => startReveal(), 3000);   // 保險：沒有可輪播的卡片時 hero 不會出現

    function startReveal() {
        if (revealReady) return;
        revealReady = true;
        // 等 placeHero 的版面生效再觀察
        requestAnimationFrame(() => pending.splice(0).forEach(u => revealIO.observe(u)));
    }

    function initReveal() {
        if (!revealIO) return;
        root.querySelectorAll(".thumbnail").forEach(card => {
            const unit = card.closest("[data-vh-row] > *, div.grid > *") || card;
            if (unit.dataset.vhRv) return;
            unit.dataset.vhRv = "1";
            unit.classList.add("vh-rv");
            if (revealReady) revealIO.observe(unit);
            else pending.push(unit);
        });
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

    // ── 啟動 ──────────────────────────────────────────────────
    function refresh() {
        if (kind === "home") {
            initRows();
            placeHero();
        } else if (kind === "video") {
            initAmbient();
            measurePlayer();
            initSide();
            initRows();
        } else {
            initToolbar();
            initPager();
            placeHero();
        }
        tidyCards();
        initReveal();               // 在 initRows 之後：要先知道哪些網格變成橫列
    }

    refresh();

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
        if (kind === "video") measurePlayer();
        layoutRows();
    });
})();

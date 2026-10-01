(function () {
    // 首頁改 Netflix 式橫列、列表頁把過濾／排序攤開成按鈕。
    //
    // 排版全部在 browse.css，規則都掛在 html.vh-home / html.vh-list 底下，影片頁不受影響。
    // 這裡只做 CSS 做不到的事：標記哪些網格要變橫列、插自己的按鈕、量尺寸。
    // 不寫任何 Alpine 會用 x-show 控制的 display —— 見 CLAUDE.md 登入 modal 那段。
    const kind = VH.kind();
    if (!kind) return;
    document.documentElement.classList.add(`vh-${kind}`);

    const root = document.querySelector(kind === "home" ? "div.is-home" : VH.LAYOUT_ROOT);
    if (!root) return;

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

    // ── 首頁：hero 滿版 ───────────────────────────────────────
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

    // ── 首頁：橫列 ────────────────────────────────────────────
    const rows = [];

    function initRows() {
        root.querySelectorAll("div.grid").forEach(grid => {
            if (grid.hasAttribute("data-vh-row")) return;
            const section = grid.parentElement;
            // 隨機區（標題列有「好手氣」按鈕）維持網格
            if (!section || section.querySelector(":scope > div button.button-primary")) return;

            grid.setAttribute("data-vh-row", "");
            section.setAttribute("data-vh-section", "");

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

            // ←/→ 在同一列的卡片之間移動焦點。首頁站台沒有方向鍵處理，不會撞到
            grid.addEventListener("keydown", e => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                const cards = visibleCards(grid);
                const i = cards.findIndex(c => c.contains(document.activeElement));
                if (i < 0) return;
                const to = cards[i + (e.key === "ArrowRight" ? 1 : -1)];
                if (!to) return;
                e.preventDefault();
                const a = to.querySelector(".my-2 a") || to.querySelector("a[href]");
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

    // 被 x-show 藏起來的 placeholder、<template> 都不算
    function visibleCards(grid) {
        return [...grid.querySelectorAll(".thumbnail")].filter(c => c.offsetParent !== null);
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
        if (page) {
            const p = document.createElement("span");
            p.className = "vh-page";
            p.textContent = page.total ? `第 ${page.now} / ${page.total} 頁` : `第 ${page.now} 頁`;
            bar.append(p);
        }

        old.before(bar);
        old.classList.add("vh-gone");
    }

    function pageInfo() {
        const nav = root.querySelector("nav");
        if (!nav) return null;
        // 目前頁是分頁列裡唯一不是連結的數字
        const cur = [...nav.querySelectorAll("span")].find(s =>
            !s.querySelector("*") && /^\d+$/.test(s.textContent.trim()) && !s.closest("a"));
        const now = cur ? cur.textContent.trim() : (new URLSearchParams(location.search).get("page") || "1");
        const tot = [...nav.querySelectorAll("span")]
            .map(s => /^\/\s*(\d+)$/.exec(s.textContent.trim()))
            .find(Boolean);
        return { now, total: tot ? tot[1] : "" };
    }

    // ── 卡片：一張只停一次 Tab ────────────────────────────────
    // 每張卡有封面、徽章、片長、標題好幾個連結，全部指向同一頁。只留標題那個
    function tidyCards() {
        root.querySelectorAll(".thumbnail").forEach(card => {
            if (card.dataset.vhTidy) return;
            const title = card.querySelector(".my-2 a");
            if (!title) return;                 // Alpine 還沒渲染完，下一輪再處理
            card.dataset.vhTidy = "1";
            card.querySelectorAll("a[href]").forEach(a => { if (a !== title) a.tabIndex = -1; });
        });
    }

    // ── 啟動 ──────────────────────────────────────────────────
    function refresh() {
        tidyCards();
        if (kind === "home") {
            initRows();
            placeHero();
        } else {
            initToolbar();
        }
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
        if (kind !== "home") return;
        placeHero();
        layoutRows();
    });
})();

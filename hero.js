(function () {
    // 列表頁頂端的封面輪播。資料完全從當前頁面已經渲染好的卡片讀，不另外 fetch —
    // 站台在 Cloudflare 後面，同源 DOM 是唯一穩定的來源。
    //
    // 首頁靠卡片認：預覽影片 id 是 preview-home-<區塊>-<番號>，不用管網址或語系路徑。
    // 其他要輪播的頁面靠網址認（VH.LIST_PAGES，在 pages.js），收整頁的 .thumbnail，
    // 不依賴那些頁面的 video id 格式。
    const kind = VH.kind();
    const CARD_VIDEO = kind === "list" ? ".thumbnail video.preview" : 'video.preview[id^="preview-home-"]';
    const LAYOUT_ROOT = VH.LAYOUT_ROOT;

    const SLIDE_MS = 12000;         // 每張停多久（進度條的動畫就是時鐘）
    const POOL_MAX = 40;
    const MIN_VISIBLE = 0.5;        // hero 露出不到一半就整個暫停

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");

    const pool = [];                // [{id, href, title, tags, cover, coverLo, preview}]
    const seen = new Set();
    const bad = new Set();          // 封面兩種都載不到的，別再輪到
    let at = -1;
    let busy = false;
    let host = null;
    let ui = null;
    let paused = false;
    let off = false;

    // ── 讀卡片 ────────────────────────────────────────────────
    function readCard(video) {
        const card = video.closest(".thumbnail");
        if (!card) return null;
        // CDN 網址從預覽影片推回去，換 CDN 網域時不用改這裡。
        // Alpine 還沒求值的卡片 data-src 是空的或不是網址，下一輪再收
        const preview = video.getAttribute("data-src") || video.getAttribute("src") || "";
        const m = /^(https?:\/\/[^/]+\/([^/]+))\/preview\.mp4$/.exec(preview);
        if (!m) return null;
        const [, base, id] = m;             // 番號取自網址路徑，每種頁面的 video id 格式都不同
        // 區塊之間常有同一部重複出現
        if (seen.has(id)) return null;

        const link = card.querySelector("a[href]:not([href^='javascript'])");
        const titleEl = card.querySelector(".my-2 a") || card.querySelector("a[x-text]");
        const title = (titleEl?.textContent || id).trim();

        // 徽章是 x-show 控制的，Alpine 求值後沒被藏起來的才算
        const tags = [];
        card.querySelectorAll("a[x-show] > span.absolute").forEach(span => {
            if (span.parentElement.style.display === "none") return;
            const t = span.textContent.replace(/\s+/g, "");
            if (t) tags.push(t);
        });

        return {
            id,
            href: link ? link.href : "",
            title,
            tags,
            cover: `${base}/cover-n.jpg`,       // 大圖；不存在就退回列表用的 cover-t
            coverLo: `${base}/cover-t.jpg`,
            preview,
        };
    }

    function collect() {
        const fresh = [];
        document.querySelectorAll(CARD_VIDEO).forEach(v => {
            if (pool.length + fresh.length >= POOL_MAX) return;
            const item = readCard(v);
            if (!item || !item.href) return;
            seen.add(item.id);
            fresh.push(item);
        });
        // 新來的插在還沒輪到的那段裡的隨機位置，已經看過的不會馬上再出現
        for (const item of fresh) {
            const lo = at + 1;
            pool.splice(lo + Math.floor(Math.random() * (pool.length - lo + 1)), 0, item);
        }
        return fresh.length;
    }

    // ── 掛載 ──────────────────────────────────────────────────
    function mount() {
        if (host?.isConnected) return true;
        const first = document.querySelector(CARD_VIDEO);
        if (!first) return false;

        if (!host) build();
        const root = first.closest(LAYOUT_ROOT);
        if (root) root.prepend(host);
        else (first.closest(".grid") || first.closest(".thumbnail")).before(host);
        return true;
    }

    function build() {
        host = document.createElement("div");
        host.setAttribute("data-video-helper", "hero");
        // 首頁滿版、頂到頁首底下；位置由 browse.js 量，這裡只切換內部樣式
        if (kind === "home") host.setAttribute("data-bleed", "");
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>${CSS}</style>
<section class="hero" hidden>
  <div class="stage"></div>
  <button class="nav prev" type="button" aria-label="上一部">${chevron("M15 5l-7 7 7 7")}</button>
  <button class="nav next" type="button" aria-label="下一部">${chevron("M9 5l7 7-7 7")}</button>
  <div class="ctl"><span class="count"></span></div>
  <div class="track"><div class="bar"></div></div>
</section>`;
        const hero = shadow.querySelector(".hero");
        hero.style.setProperty("--slide", `${SLIDE_MS}ms`);
        ui = {
            hero,
            stage: shadow.querySelector(".stage"),
            bar: shadow.querySelector(".bar"),
            count: shadow.querySelector(".count"),
        };

        ui.bar.addEventListener("animationend", () => show(1));
        shadow.querySelector(".prev").addEventListener("click", () => show(-1));
        shadow.querySelector(".next").addEventListener("click", () => show(1));

        // hover / 鍵盤焦點在裡面：只停進度條，預覽影片照播 —— 停下來就是想看它
        hero.addEventListener("mouseenter", () => setPaused(true));
        hero.addEventListener("mouseleave", () => setPaused(hero.contains(shadow.activeElement)));
        hero.addEventListener("focusin", () => setPaused(true));
        hero.addEventListener("focusout", e => {
            if (!hero.contains(e.relatedTarget)) setPaused(hero.matches(":hover"));
        });
        document.addEventListener("visibilitychange", sync);
        reduced.addEventListener("change", sync);

        // 用 intersectionRatio 判斷，isIntersecting 露出 1px 就是 true
        new IntersectionObserver(([e]) => {
            off = e.intersectionRatio < MIN_VISIBLE;
            sync();
        }, { threshold: [MIN_VISIBLE] }).observe(hero);
    }

    function chevron(d) {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
    }

    // ── 輪播 ──────────────────────────────────────────────────
    function loadImg(src) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img.naturalWidth > 0);
            img.onerror = () => resolve(false);
            img.src = src;
        });
    }

    async function pickCover(item) {
        if (await loadImg(item.cover)) return item.cover;
        if (await loadImg(item.coverLo)) return item.coverLo;
        return null;
    }

    function slide(item, cover) {
        const s = document.createElement("div");
        s.className = "slide";

        const bg = document.createElement("div");
        bg.className = "bg";
        bg.style.backgroundImage = `url("${cover}")`;

        const link = document.createElement("a");
        link.className = "link";
        link.href = item.href;

        const frame = document.createElement("div");
        frame.className = "frame";
        const img = document.createElement("img");
        img.src = cover;
        img.alt = "";
        const video = document.createElement("video");
        video.muted = true;
        video.defaultMuted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = "auto";
        // 真的開始播才蓋上去，載入中那段看到的是封面的推近，不是黑畫面
        video.addEventListener("playing", () => { frame.dataset.live = "1"; });
        frame.append(img, video);

        const text = document.createElement("div");
        text.className = "text";
        const tag = document.createElement("div");
        tag.className = "tag";
        tag.textContent = [item.id.toUpperCase(), ...item.tags].join(" · ");
        const h = document.createElement("div");
        h.className = "title";
        h.textContent = item.title;
        const go = document.createElement("span");
        go.className = "open";
        go.textContent = "前往觀看 →";
        text.append(tag, h, go);

        link.append(frame, text);
        s.append(bg, link);
        s._video = video;
        s._preview = item.preview;
        return s;
    }

    function stopVideo(s) {
        const v = s._video;
        if (!v) return;
        v.pause();
        // 拿掉 src 才會真的中斷下載
        v.removeAttribute("src");
        v.load();
    }

    async function show(step) {
        if (busy || !pool.length) return;
        busy = true;
        try {
            for (let tries = 0; tries < pool.length; tries++) {
                at = (at + step + pool.length) % pool.length;
                const item = pool[at];
                if (bad.has(item.id)) continue;
                const cover = await pickCover(item);
                if (!cover) { bad.add(item.id); continue; }

                const next = slide(item, cover);
                ui.stage.append(next);
                next.getBoundingClientRect();       // 先排版一次，淡入的 transition 才會跑
                const olds = [...ui.stage.children].filter(c => c !== next);
                next.dataset.on = "1";
                olds.forEach(o => {
                    o.dataset.on = "0";
                    // 舊的淡出完再停影片，停在最後一格淡掉而不是跳回封面
                    setTimeout(() => { stopVideo(o); o.remove(); }, 700);
                });

                ui.hero.hidden = false;
                ui.count.textContent = `${at + 1} / ${pool.length}`;
                ui.bar.classList.remove("run");
                void ui.bar.offsetWidth;            // 重播 CSS 動畫
                ui.bar.classList.add("run");
                sync();
                return;
            }
            ui.hero.hidden = true;                  // 整個 pool 都載不到
        } finally {
            busy = false;
        }
    }

    function current() {
        return ui?.stage.querySelector('.slide[data-on="1"]');
    }

    function setPaused(on) {
        paused = on;
        sync();
    }

    // 所有暫停條件集中在這裡算，進度條和預覽影片各看各的
    function sync() {
        if (!ui) return;
        ui.hero.dataset.paused = paused ? "1" : "0";
        ui.hero.dataset.hidden = document.hidden ? "1" : "0";
        ui.hero.dataset.off = off ? "1" : "0";

        const s = current();
        const v = s?._video;
        if (!v) return;
        if (document.hidden || off || reduced.matches) {
            v.pause();
            return;
        }
        if (!v.getAttribute("src")) v.src = s._preview;
        v.play().catch(() => { /* 被瀏覽器擋就停在封面 */ });
    }

    // ── 樣式（Shadow DOM 內，跟站台的 Tailwind 互不影響）────────
    const CSS = `
:host { display: block; margin: 0 0 24px; container-type: inline-size; }
.hero {
    --ground: #1b1e25;
    --ink: #eceff4;
    --ink-dim: rgba(236, 239, 244, .6);
    --focus: #88c0d0;
    --h: clamp(360px, 78vh, 860px);
    position: relative;
    height: var(--h);
    overflow: hidden;
    isolation: isolate;
    border-radius: 8px;
    background: var(--ground);
    color: var(--ink);
    font-variant-numeric: tabular-nums;
}
.hero[hidden] { display: none; }
/* 滿版時頁首（固定、透明漸層）疊在上面：高度和上緣留白都加上頁首高度，--vh-header 由 browse.js 寫在 <html> 上 */
:host([data-bleed]) .hero { border-radius: 0; height: calc(var(--h) + var(--vh-header, 0px)); }
:host([data-bleed]) .link { padding-top: calc(32px + var(--vh-header, 0px)); }
.stage { position: absolute; inset: 0; }
.slide {
    position: absolute;
    inset: 0;
    opacity: 0;
    transition: opacity .6s ease;
}
.slide[data-on="1"] { opacity: 1; }

/* 封面鋪滿當底圖：只輕微模糊，壓暗但看得出是哪張圖 */
.bg {
    position: absolute;
    inset: -16px;                   /* 吃掉 blur 在邊緣留下的透明暈 */
    background: center / cover no-repeat;
    filter: blur(3px) saturate(1.2) brightness(.6);
    animation: drift 14s ease-in-out infinite alternate;
}
@keyframes drift {
    from { transform: scale(1.05) translateX(-2%); }
    to { transform: scale(1.15) translateX(2%); }
}
.slide::after {
    content: '';
    position: absolute;
    inset: 0;
    background:
        linear-gradient(to bottom, transparent 55%, rgba(27, 30, 37, .9)),
        linear-gradient(90deg, rgba(27, 30, 37, .15) 30%, rgba(27, 30, 37, .7));   /* 底圖清楚了，標題那側要壓深一點才讀得到 */
    pointer-events: none;
}

.link {
    position: relative;
    z-index: 1;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 36px;
    height: 100%;
    padding: 32px 72px 44px;        /* 左右留給上一部 / 下一部的點擊區 */
    color: inherit;
    text-decoration: none;
}

/* 清楚的 16:9 畫框：先是封面推近，預覽影片開始播就淡入蓋上 */
.frame {
    position: relative;
    flex: none;
    width: min(800px, 55%, calc((var(--h) - 76px) * 16 / 9));   /* 800 = cover-n.jpg 原生寬，再大就只是放大糊圖 */
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: 6px;
    background: #000;
    box-shadow: 0 24px 60px rgba(0, 0, 0, .6);
}
.frame img, .frame video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
}
.frame img { animation: kb 9s ease-out both; }
@keyframes kb {
    from { transform: scale(1.14) translate(2%, 2%); }
    to { transform: scale(1); }
}
.frame video { opacity: 0; transition: opacity .8s ease; }
.frame[data-live="1"] video { opacity: 1; }
.frame::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    transition: box-shadow .15s;
}
.link:hover .frame::after { box-shadow: inset 0 0 0 2px var(--focus); }

.text {
    flex: 1;
    min-width: 0;
    max-width: 560px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
}
.slide[data-on="1"] .text { animation: rise .7s .12s cubic-bezier(.2, .7, .2, 1) both; }
@keyframes rise {
    from { opacity: 0; transform: translateY(14px); }
    to { opacity: 1; transform: none; }
}
.tag { font-size: 12px; letter-spacing: .04em; color: var(--ink-dim); }
.title {
    font-size: clamp(18px, 2.2vw, 28px);
    font-weight: 700;
    line-height: 1.3;
    color: #fff;
    text-shadow: 0 2px 16px rgba(0, 0, 0, .5);
    text-wrap: balance;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.open {
    margin-top: 4px;
    padding: 6px 16px;
    font-size: 13px;
    border: 1px solid rgba(255, 255, 255, .35);
    border-radius: 999px;
    background: rgba(27, 30, 37, .35);
    transition: border-color .12s, background .12s;
}
.link:hover .open { border-color: var(--focus); background: rgba(136, 192, 208, .18); }

/* 上一部 / 下一部：左右整條高度都能點，hover 才浮出來 */
.nav {
    position: absolute;
    top: 0;
    bottom: 3px;
    z-index: 2;
    width: 64px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    color: #fff;
    background: transparent;
    cursor: pointer;
    opacity: .4;
    transition: opacity .15s, background .15s;
}
.nav.prev { left: 0; }
.nav.next { right: 0; }
.nav svg { width: 34px; height: 34px; filter: drop-shadow(0 1px 6px rgba(0, 0, 0, .6)); }
.hero:hover .nav { opacity: .75; }
.nav:hover { opacity: 1 !important; }
.nav.prev:hover { background: linear-gradient(90deg, rgba(0, 0, 0, .35), transparent); }
.nav.next:hover { background: linear-gradient(-90deg, rgba(0, 0, 0, .35), transparent); }
.nav:focus-visible { opacity: 1; outline: 2px solid var(--focus); outline-offset: -4px; }

.ctl {
    position: absolute;
    right: 72px;
    bottom: 14px;
    z-index: 2;
    font-size: 11px;
    color: var(--ink-dim);
}
.track {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 2;
    height: 3px;
    background: rgba(236, 239, 244, .12);
}
.bar {
    height: 100%;
    background: rgba(236, 239, 244, .65);
    transform: scaleX(0);
    transform-origin: left;
}
.bar.run { animation: bar var(--slide) linear forwards; }
@keyframes bar { to { transform: scaleX(1); } }
.hero[data-paused="1"] .bar,
.hero[data-hidden="1"] .bar,
.hero[data-off="1"] .bar { animation-play-state: paused; }
.hero[data-off="1"] .bg,
.hero[data-off="1"] .frame img { animation-play-state: paused; }

/* 窄螢幕改直排：畫框在上、標題在下 */
@media (max-width: 760px) {
    .hero { height: calc((100cqw - 96px) * 9 / 16 + 190px); }
    :host([data-bleed]) .hero { height: calc((100cqw - 96px) * 9 / 16 + 190px + var(--vh-header, 0px)); }
    :host([data-bleed]) .link { padding-top: calc(20px + var(--vh-header, 0px)); }
    .link { flex-direction: column; align-items: stretch; gap: 16px; padding: 20px 48px 40px; }
    .frame { width: 100%; }
    .ctl { right: 48px; }
    .nav { width: 44px; }
    .nav svg { width: 26px; height: 26px; }
}

/* 進度條留著：它是資訊（多久換下一部），不是裝飾；預覽影片在 sync() 裡就不播 */
@media (prefers-reduced-motion: reduce) {
    .slide, .frame video, .nav, .open { transition: none; }
    .bg, .frame img, .text { animation: none !important; }
}
`;

    // ── 啟動 ──────────────────────────────────────────────────
    // 卡片是 Alpine 在前端渲染的，document_end 時可能還沒出現
    let queued = false;
    function refresh() {
        queued = false;
        if (!mount()) return;
        const added = collect();
        if (at < 0 && added) show(1);
        else if (added && ui) ui.count.textContent = `${at + 1} / ${pool.length}`;
    }

    refresh();
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        setTimeout(refresh, 300);
    }).observe(document.body, { childList: true, subtree: true });
})();

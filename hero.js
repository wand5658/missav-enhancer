(function () {
    // 列表頁頂端的封面輪播。資料完全從當前頁面已經渲染好的卡片讀，不另外 fetch —
    // 站台在 Cloudflare 後面，同源 DOM 是唯一穩定的來源。
    //
    // 首頁靠卡片認：預覽影片 id 是 preview-home-<區塊>-<番號>，不用管網址或語系路徑。
    // 其他要輪播的頁面靠網址認（VH.LIST_PAGES，在 pages.js），收整頁的 .thumbnail，
    // 不依賴那些頁面的 video id 格式。
    const kind = VH.kind();
    if (kind !== "home" && kind !== "list") return;     // 影片頁、其他頁都不輪播
    const CARD_VIDEO = kind === "list" ? ".thumbnail video.preview" : 'video.preview[id^="preview-home-"]';
    const LAYOUT_ROOT = VH.LAYOUT_ROOT;

    // 停留秒數、切換速度、動畫種類都來自設定（settings.js），隨時可能被 popup 改掉，用到時才讀
    const slideMs = () => VHS.get("heroSeconds") * 1000;    // 每張停多久（進度條的動畫就是時鐘）
    const swapMs = () => VHS.get("heroSpeed");               // 切換動畫的時間
    const ALL_FX = ["parallax", "zoom", "flip", "push"];     // 規則在下面 CSS 的 .slide[data-fx]
    function pickFx() {
        const list = (VHS.get("heroFx") || []).filter(f => ALL_FX.includes(f));
        const from = list.length ? list : ALL_FX.slice(0, 3);
        return from[Math.floor(Math.random() * from.length)];
    }
    // 這一頁要不要輪播：總開關 ＋ 首頁 / 列表頁各自的開關
    const enabled = () => VHS.on("hero") && VHS.on(kind === "home" ? "heroHome" : "heroList");
    const POOL_MAX = 40;
    const hdOn = () => VHS.on("heroHD") && VHS.get("heroPreview");
    const HD_WAIT_MS = 2500;        // 高畫質最多等多久，超過就先播 preview.mp4
    const MIN_VISIBLE = 0.5;        // hero 露出不到一半就整個暫停

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
        // 首頁、列表頁都滿版、頂到頁首底下；位置由 browse.js 量，這裡只切換內部樣式
        host.setAttribute("data-bleed", "");
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
        ui = {
            hero,
            stage: shadow.querySelector(".stage"),
            bar: shadow.querySelector(".bar"),
            count: shadow.querySelector(".count"),
        };

        ui.bar.addEventListener("animationend", () => show(1));
        shadow.querySelector(".prev").addEventListener("click", () => show(-1));
        shadow.querySelector(".next").addEventListener("click", () => show(1));

        // 滑鼠 hover 不暫停。只有鍵盤焦點在裡面時停進度條（預覽影片照播），不然 Tab 到「前往觀看」前就換片了。
        // 用 :focus-visible 判斷：滑鼠點上一部 / 下一部也會讓按鈕拿到焦點，那種不算
        hero.addEventListener("focusin", e => setPaused(e.target.matches(":focus-visible")));
        hero.addEventListener("focusout", e => {
            if (!hero.contains(e.relatedTarget)) setPaused(false);
        });
        document.addEventListener("visibilitychange", sync);
        applySettings();

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

        // 不用 <a href>：整張都是連結，滑鼠停在上面瀏覽器左下角會一直顯示網址。
        // 改成 role="link" 自己處理點擊；Ctrl/⌘/Shift 點、中鍵照樣開新分頁
        const link = document.createElement("div");
        link.className = "link";
        link.setAttribute("role", "link");
        link.tabIndex = 0;
        const open = e => {
            if (!item.href) return;
            if (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey) window.open(item.href, "_blank", "noopener");
            else location.href = item.href;
        };
        link.addEventListener("click", open);
        link.addEventListener("auxclick", e => { if (e.button === 1) open(e); });
        link.addEventListener("keydown", e => { if (e.key === "Enter") open(e); });

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
        // 真的開始播才蓋上去，載入中那段看到的是封面的推近，不是黑畫面。
        // 高畫質（hd.js）要先跳到挑好的起點，跳過去之前播的第 0 秒不算
        const atStart = () => !s._hd || video.currentTime >= s._hd.s - 1;
        video.addEventListener("playing", () => { if (atStart()) frame.dataset.live = "1"; });
        video.addEventListener("timeupdate", () => {
            if (!s._hd) return;
            if (atStart() && !video.paused) frame.dataset.live = "1";
            if (video.currentTime >= s._hd.s + VHD.CLIP_S) video.currentTime = s._hd.s;    // 只循環那一段
        });
        video.addEventListener("loadedmetadata", () => { if (s._hd) video.currentTime = s._hd.s; });
        // 串流載不到（網址失效、網路）就退回 preview.mp4
        video.addEventListener("error", () => {
            if (!s._hd) return;
            s._hd = null;
            s._hdState = "none";
            video.loop = true;
            video.removeAttribute("src");
            sync();
        });
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
        s._frame = frame;
        s._hd = null;
        s._hdState = hdOn() ? "wait" : "none";
        if (s._hdState === "wait") {
            // 快取裡有的幾乎立刻好；沒有的要 fetch 影片頁、挑起點，等太久就先播 preview.mp4
            const done = (e, why) => {
                if (s._hdState !== "wait") return;
                console.debug("[hd] slide", item.id, e ? "hd" : `fallback(${why || "none"})`);
                s._hd = e;
                s._hdState = e ? "ready" : "none";
                if (e) video.loop = false;
                sync();
            };
            VHD.resolve(item, VHS.get("heroHDPick")).then(done);
            setTimeout(() => done(null, "timeout"), HD_WAIT_MS);
        }
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
                const olds = [...ui.stage.children].filter(c => c !== next);
                // 第一張沒有 data-fx，直接出現。之後每次隨機挑一種動畫，新舊兩張用同一種；
                // 方向：下一部從右邊進、舊的往左出，上一部反過來
                if (olds.length) {
                    const fx = pickFx();
                    const dir = step < 0 ? -1 : 1;
                    for (const el of [next, ...olds]) {
                        el.dataset.fx = fx;
                        el.style.setProperty("--dir", dir);
                    }
                    next.getBoundingClientRect();   // 先排版一次（停在起始狀態），transition 才會跑
                }
                next.dataset.on = "1";
                olds.forEach(o => {
                    o.dataset.on = "0";
                    // 舊的推出去再停影片，停在最後一格離開而不是跳回封面
                    setTimeout(() => { stopVideo(o); o.remove(); }, swapMs() + 100);
                });

                ui.hero.hidden = false;
                // 後面兩部先準備好（fetch 影片頁、挑起點），輪到時就直接是高畫質；
                // 結果存進快取，沒輪到的下次來也用得到
                if (hdOn()) for (let k = 1; k <= Math.min(2, pool.length - 1); k++)
                    VHD.resolve(pool[(at + k) % pool.length], VHS.get("heroHDPick"));
                // 頁面背景（browse.css 的全頁染色）跟著目前這張封面換色
                if (/^https:\/\/[\w.\/-]+$/.test(cover))
                    document.documentElement.style.setProperty("--vh-cover", `url("${cover}")`);
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

    // popup 改設定時即時套用：開關、高度、秒數、速度、動態效果
    function applySettings() {
        if (!host || !ui) return;
        host.hidden = !enabled();
        host.toggleAttribute("data-short", VHS.get("heroHeight") === "short");
        host.toggleAttribute("data-reduce", VHS.reduced());
        ui.hero.style.setProperty("--slide", `${slideMs()}ms`);
        ui.hero.style.setProperty("--swap", `${swapMs()}ms`);
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
        // 預覽影片設定關掉時連載都不載，只看封面
        if (document.hidden || off || VHS.reduced() || !enabled() || !VHS.get("heroPreview")) {
            v.pause();
            return;
        }
        if (s._hdState === "wait") return;      // 高畫質還在準備，先停在封面
        if (!v.getAttribute("src"))
            v.src = s._hd ? VHD.src(s._hd, VHD.quality(s._frame.getBoundingClientRect().width)) : s._preview;
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
/* 滿版時占滿整個視窗：--h 是頁首以下的高度（畫框尺寸用它算），加回頁首剛好 100vh */
:host([data-bleed]) .hero { --h: calc(100vh - var(--vh-header, 0px)); border-radius: 0; height: calc(var(--h) + var(--vh-header, 0px)); }
/* 設定「較矮」：回到 78vh 那一版 */
:host([data-bleed][data-short]) .hero { --h: clamp(360px, 78vh, 860px); }
:host([hidden]) { display: none; }
:host([data-bleed]) .link { padding-top: calc(32px + var(--vh-header, 0px)); }
/* 滿版時下緣淡進頁面背景（browse.css 用目前封面染色的那層），不切出一條硬邊 */
:host([data-bleed]) .hero { background: transparent; }
:host([data-bleed]) .bg,
:host([data-bleed]) .slide::after {
    -webkit-mask-image: linear-gradient(to bottom, #000 50%, transparent 100%);
            mask-image: linear-gradient(to bottom, #000 50%, transparent 100%);
}
:host([data-bleed]) .slide::after { background: linear-gradient(90deg, rgba(27, 30, 37, .15) 30%, rgba(27, 30, 37, .7)); }
.stage { position: absolute; inset: 0; }
.slide {
    --dir: 1;
    --ease: cubic-bezier(.65, 0, .35, 1);
    position: absolute;
    inset: 0;
}

/* ── 切換動畫（show() 每次隨機挑一種寫進 data-fx）──────────
 * 起始狀態是 [data-fx]:not([data-on])，上場 data-on="1"，下場 data-on="0"。
 * .bg 的 transform 被 drift 動畫佔走、.text 也可能有動畫，所以位移用獨立的 translate 屬性，跟 transform 疊加 */

/* 視差：底圖、畫框、文字三層速度不同 */
.slide[data-fx="parallax"] :is(.bg, .frame, .text) {
    transition: translate var(--swap) var(--ease), opacity var(--swap) var(--ease);
}
.slide[data-fx="parallax"]:not([data-on]) .bg { translate: calc(var(--dir) * 100%) 0; }
.slide[data-fx="parallax"]:not([data-on]) .frame { translate: calc(var(--dir) * 140%) 0; }
.slide[data-fx="parallax"]:not([data-on]) .text { translate: calc(var(--dir) * 260%) 0; }
.slide[data-fx="parallax"][data-on="0"] .bg { translate: calc(var(--dir) * -40%) 0; opacity: .3; }
.slide[data-fx="parallax"][data-on="0"] .frame { translate: calc(var(--dir) * -140%) 0; }
.slide[data-fx="parallax"][data-on="0"] .text { translate: calc(var(--dir) * -260%) 0; }

/* 穿越：舊的衝向鏡頭散掉（疊在上面），新的從後方浮上來 */
.slide[data-fx="zoom"] {
    transition: transform var(--swap) var(--ease), opacity var(--swap) var(--ease), filter var(--swap) var(--ease);
}
.slide[data-fx="zoom"]:not([data-on]) { transform: scale(.85); opacity: 0; filter: blur(8px); }
.slide[data-fx="zoom"][data-on="0"] { z-index: 1; transform: scale(1.3); opacity: 0; filter: blur(12px); }

/* 推進：整張往旁邊推 */
.slide[data-fx="push"] { transition: transform var(--swap) var(--ease); }
.slide[data-fx="push"]:not([data-on]) { transform: translateX(calc(var(--dir) * 100%)); }
.slide[data-fx="push"][data-on="0"] { transform: translateX(calc(var(--dir) * -100%)); }

/* 3D 翻卡：畫框像翻牌一樣轉過去，底圖交叉淡化，文字上下錯開 */
.slide[data-fx="flip"] { transition: opacity var(--swap) var(--ease); }
.slide[data-fx="flip"]:not([data-on]),
.slide[data-fx="flip"][data-on="0"] { opacity: 0; }
.slide[data-fx="flip"] .link { perspective: 1400px; }
.slide[data-fx="flip"] .frame {
    backface-visibility: hidden;
    transition: transform var(--swap) var(--ease), opacity var(--swap) var(--ease);
}
.slide[data-fx="flip"] .text { transition: translate var(--swap) var(--ease), opacity var(--swap) var(--ease); }
.slide[data-fx="flip"]:not([data-on]) .frame { transform: rotateY(calc(var(--dir) * 75deg)) translateX(calc(var(--dir) * 30%)); opacity: 0; }
.slide[data-fx="flip"][data-on="0"] .frame { transform: rotateY(calc(var(--dir) * -75deg)) translateX(calc(var(--dir) * -30%)); opacity: 0; }
.slide[data-fx="flip"]:not([data-on]) .text { translate: 0 24px; opacity: 0; }
.slide[data-fx="flip"][data-on="0"] .text { translate: 0 -24px; opacity: 0; }

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
    cursor: pointer;
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
.link:hover .frame::after,
.link:focus-visible .frame::after { box-shadow: inset 0 0 0 2px var(--focus); }
.link:focus-visible { outline: none; }

.text {
    flex: 1;
    min-width: 0;
    max-width: 560px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
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

/* 減少動態效果（設定或系統偏好，host 的 data-reduce 由 applySettings 寫）。
 * 不用 @media (prefers-reduced-motion)：設定選「完整」時要能蓋過系統偏好。
 * 進度條留著：它是資訊（多久換下一部），不是裝飾；預覽影片在 sync() 裡就不播 */
:host([data-reduce]) .slide,
:host([data-reduce]) .slide *,
:host([data-reduce]) .frame video,
:host([data-reduce]) .nav,
:host([data-reduce]) .open { transition: none !important; }
:host([data-reduce]) .bg,
:host([data-reduce]) .frame img,
:host([data-reduce]) .text { animation: none !important; }
`;

    // ── 啟動 ──────────────────────────────────────────────────
    // 卡片是 Alpine 在前端渲染的，document_end 時可能還沒出現
    let queued = false;
    function refresh() {
        queued = false;
        if (!enabled()) return;             // 關掉時不收卡片、不掛載；打開時由 subscribe 叫一次
        if (!mount()) return;
        const added = collect();
        if (at < 0 && added) show(1);
        else if (added && ui) ui.count.textContent = `${at + 1} / ${pool.length}`;
    }

    VHS.ready.then(() => {
        refresh();
        new MutationObserver(() => {
            if (queued) return;
            queued = true;
            setTimeout(refresh, 300);
        }).observe(document.body, { childList: true, subtree: true });
        VHS.subscribe(() => {
            applySettings();
            if (enabled()) refresh();
        });
    });
})();

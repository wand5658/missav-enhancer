// 分鏡與封面牆（設定 viewer）：畫面右緣的抽屜開一個全螢幕的看圖 viewer，看兩種「圖」：
// - 分鏡：影片頁播放器的拖曳預覽大圖切成一格一格，Enter 從那個時間點播；停在某一格會從串流抓清楚畫面
// - 封面牆：頁面上所有影片卡片的封面（單張換成 800px 的 cover-n），Enter 開那部影片
//
// viewer 本體是 viewer.js + viewer.css，一個不認得任何網站的看圖元件（站台相關的東西一律放這支）；
// 這支是它的宿主，交代圖從哪來、Enter 做什麼、關掉捲回哪裡。
// 不提供下載，所以 viewer 的下載 / 複製網址那一組不會出現。
// 介面語言跟 popup 同一個設定（lang）：viewer 是開的時候才建，沒開著時改語言，下次開就是新的語言。
//
// 清單裡的 <img> 都建在一份沒有 browsing context 的空文件裡，建的時候不會自己去下載。
// 資料掛在 data-bv-*（viewer 的格式）：title（上方列）、cap（計數器 / 格子角落）、
// t（分鏡的秒數）、href（封面牆的影片頁）、sharp（清楚畫面，viewer 單張就改顯示它）。
(async () => {
    await VHS.ready;

    const CFG = {
        card: ".thumbnail",                   // 一張影片卡片（首頁、列表、影片頁的推薦都是它）
        link: "a[href]",                      // 卡片裡第一個連結 = 影片頁
        cover: "img",                         // 封面；lozad 懶載入，網址可能還在 data-src
        title: ".my-2 a",                     // 卡片下方的標題（含番號）
        // 封面角落的小標籤：片長跟「中文字幕」「無碼影片」這些徽章是同一種 span，靠內容長得像時間來認
        badge: "span.absolute",
        duration: /^\d+:\d{2}(:\d{2})?$/,
        player: ".plyr video, video#player",  // 影片頁的主播放器（卡片的預覽也是 <video>，要分開）
        seekCdn: "https://surrit.com",
        storyMax: 240,                        // 分鏡最多幾格；原始大約 2 秒一格，一小時就一千八，跳著取
    };

    // 宿主自己的文字；viewer 的在 viewer.js 裡
    const STR = {
        zh: {
            story: "分鏡", storyTip: "把這部的拖曳預覽圖攤開成分鏡，Enter 從那一格開始播",
            wall: "封面牆", wallTip: "這頁所有影片的大封面，Enter 開那部影片",
            play: "▶ 從這裡播", openVideo: "開啟影片",
            helpEnter: "分鏡：從這個時間點播放；封面牆：開啟這部影片",
            noPlayer: "找不到播放器", added: n => `接上 ${n} 格`,
            noSpec: "這頁沒有分鏡資料", storyFail: m => `分鏡抓不到（${m}）`, noCards: "這頁沒有影片卡片",
        },
        en: {
            story: "Storyboard", storyTip: "Lay out this video's scrub thumbnails; Enter plays from the chosen frame",
            wall: "Cover wall", wallTip: "Large covers of every video on this page; Enter opens that video",
            play: "▶ Play from here", openVideo: "Open video",
            helpEnter: "Storyboard: play from this moment; cover wall: open this video",
            noPlayer: "Player not found", added: n => `Added ${n} frames`,
            noSpec: "No storyboard on this page", storyFail: m => `Could not load the storyboard (${m})`, noCards: "No video cards on this page",
        },
    };
    // 跟 popup 同一套：auto 看瀏覽器語言
    const lang = () => {
        const l = VHS.get("lang");
        if (l === "zh" || l === "en") return l;
        return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
    };
    const t = () => STR[lang()];

    // viewer 的偏好：不給使用者調（popup 只有開關），[ ] + - 調的只活在這一頁
    const GRID_STEPS = [120, 160, 200, 260, 340, 440, 560, 720, 920];
    const stepIndex = px => GRID_STEPS.reduce((best, v, i) => (Math.abs(v - px) < Math.abs(GRID_STEPS[best] - px) ? i : best), 0);
    const PREFS = {
        openInGrid: true, gridCol: 340, slideDelay: 3000, slideLoop: true, slideShuffle: false,
        idleHide: 2500, preload: 4, preloadAll: true,
    };

    // viewer.css 之後接上這支自己的樣式（封面牆 hover 預覽），一起進 viewer 的 Shadow DOM
    const HOST_CSS = `
        .vh-tp {
            position: absolute; inset: 0; z-index: 1; overflow: hidden; pointer-events: none;
            background: #000; opacity: 0; transition: opacity .3s ease;
        }
        .vh-tp[data-live="1"] { opacity: 1; }
        .vh-tp video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .vh-tp video.mv { opacity: 0; }
        .vh-tp video.mv[data-on] { opacity: 1; }
    `;
    let cssPromise = null;
    const loadCss = () => (cssPromise ||= fetch(chrome.runtime.getURL("viewer.css")).then(r => r.text()).catch(() => "")
        .then(css => css + HOST_CSS));

    let roundTitle = "";                      // 這一輪上方列的標題（分鏡是影片標題，封面牆沒有）

    // viewer 用到才建，語言在建的時候決定；語言換了而 viewer 沒開著，就換一個新的
    let viewer = null;
    let viewerLang = "";
    function getViewer() {
        const l = lang();
        if (viewer && (viewerLang === l || viewer.busy())) return viewer;
        viewerLang = l;
        viewer = makeViewer(l);
        return viewer;
    }

    const makeViewer = l => globalThis.BV_VIEWER.create({
        id: "vh-viewer",
        lang: l,
        css: loadCss,
        prefs: PREFS,
        gridSteps: GRID_STEPS,
        stepIndex,
        minSize: 0,                           // 分鏡一格只有一百多 px 寬，不能拿「太小 = 失效」來篩
        // 卡片上的封面是 cover-t.jpg（330×222），單張看換成 cover-n.jpg（800×537）；載不到退回 cover-t
        rewrite: [[/\/cover-t\.jpg(\?.*)?$/, "/cover-n.jpg"]],
        help: [["Enter", STR[l].helpEnter]],
        itemAction,
        onShow: item => wantSharp(item),      // 分鏡格先顯示模糊的，停一下再換成串流抓的清楚畫面
        tileHover: (item, tile) => hoverPreview(item, tile),
        imageHover: (item, layer) => hoverPreview(item, layer),   // 單張：疊在圖上的那一層，跟著縮放
        reduced: () => VHS.reduced(),
        onRound: () => roundTitle,
        onClose,
    });

    function open(list, i, title, source) {
        if (viewer?.busy()) return Promise.resolve();
        roundTitle = title;
        return getViewer().open(list, i, source);
    }

    function onClose(list, index) {
        if (storyCache?.items === list) storyCache.at = index;   // 分鏡重開時回到這一格
        const card = list[index]?.bvCard;                        // 封面牆：每張記著頁面上那張卡片
        if (card?.isConnected) card.scrollIntoView({ block: "center" });
    }

    const inertDoc = document.implementation.createHTMLDocument("");

    function makeItem(src, w, h, data) {
        const img = inertDoc.createElement("img");
        img.src = src;
        img.setAttribute("width", String(w));    // viewer 靠它先排好總覽的格子高度
        img.setAttribute("height", String(h));
        Object.assign(img.dataset, data);
        return img;
    }

    function clock(sec) {
        const t = Math.round(sec);
        const pad = n => String(n).padStart(2, "0");
        const h = Math.floor(t / 3600);
        const m = Math.floor(t / 60) % 60;
        return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${m}:${pad(t % 60)}`;
    }

    // 這一張按 Enter / 工具列按鈕要做什麼
    function itemAction(img) {
        if (img.dataset.bvT) return { label: t().play, run: () => seekPlayer(Number(img.dataset.bvT)) };
        if (img.dataset.bvHref) return { label: t().openVideo, run: () => { location.href = img.dataset.bvHref; } };
        return null;
    }

    // 分鏡的 log 一律帶這個前綴，console 篩 [分鏡] 就看得到整輪經過
    const storyLog = (...a) => console.debug("[分鏡]", ...a);
    const storyWarn = (...a) => console.warn("[分鏡]", ...a);

    const playerVideo = () => document.querySelector(CFG.player);

    // 關掉 viewer、跳到那個時間點開始播。
    // 站台在「第一次」play 時才呼叫 hls.startLoad(-1)，-1 讓 hls.js 從頭開始、把播放位置拉回 0，
    // 所以還沒播過的時候先設 currentTime 會被蓋掉（實測：剛載入頁面按「從這裡播」都從頭播）。
    // 沒播過就先 play，等 playing（hls.js 已經拉回起點）再跳；過一下再看一次，又被拉回去就再跳
    const SEEK_RECHECK = 600;
    function seekPlayer(t) {
        const v = playerVideo();
        if (!v) { viewer.toast(t().noPlayer); return; }
        viewer.close();
        v.scrollIntoView({ block: "center" });
        const fresh = !v.played.length;   // 還沒播過任何一段
        storyLog("跳到", clock(t), fresh ? "（第一次播放，等 playing 再跳）" : "");
        if (!fresh && v.readyState >= 1) {
            v.currentTime = t;
            v.play().catch(() => {});
            return;
        }
        const seek = () => {
            if (Math.abs(v.currentTime - t) <= 2) return;
            storyLog("播放位置在", clock(v.currentTime), "→ 跳回", clock(t));
            v.currentTime = t;
        };
        v.addEventListener("playing", () => { seek(); setTimeout(seek, SEEK_RECHECK); }, { once: true });
        v.play().catch(e => storyWarn("play() 被拒：", e.message));
    }

    // ── 清楚畫面（設定 viewerSharp）─────────────────────────────
    // 分鏡格只有 300×168，單張放大一定糊。停在某一格 SHARP_DWELL 之後，
    // 用一個不掛在頁面上的 <video> 播同一部的串流、跳到那一格的時間點、畫到 canvas 上，換成那張。
    // - surrit 的 playlist 跟分段在帶 Origin 時都回 Access-Control-Allow-Origin（2026-10-27 用 curl 量過），
    //   所以 crossOrigin="anonymous" 抓下來的畫面不會污染 canvas，toDataURL 拿得到
    // - Chrome 原生播得了 HLS（hd.js 也是這樣播），不用 hls.js；不支援就整個不做
    // - 畫質從 playlist.m3u8 挑解析度最高的那條（量過的那部最高 720p，1080p 是 404）
    // - 一次只抓一格：快速翻過去的不排隊，只抓最後停下來的那格；抓到的掛在 data-bv-sharp。
    //   連續失敗 SHARP_MAX_FAILS 次就整頁放棄
    const SHARP_DWELL = 300;
    const SHARP_TIMEOUT = 15000;
    const SHARP_MAX_FAILS = 3;
    let sharpWant = null;      // 停下來的那一格（<img>）
    let sharpTimer = 0;
    let sharpBusy = false;
    let sharpFails = 0;
    let sharpVideo = null;     // Promise<HTMLVideoElement>，這一頁共用一個

    function wantSharp(item) {
        clearTimeout(sharpTimer);
        if (!VHS.on("viewerSharp")) return;
        if (!item?.dataset.bvT || item.dataset.bvSharp || sharpFails >= SHARP_MAX_FAILS) return;
        sharpWant = item;
        sharpTimer = setTimeout(runSharp, SHARP_DWELL);
    }

    async function runSharp() {
        if (sharpBusy) return;               // 手上這格抓完會再看一次 sharpWant
        sharpBusy = true;
        while (sharpWant && viewer.isOpen() && !viewer.gridOpen()) {
            const item = sharpWant;
            sharpWant = null;
            if (item.dataset.bvSharp || viewer.current() !== item) continue;   // 等的期間已經翻走了
            const t = Number(item.dataset.bvT);
            const t0 = performance.now();
            try {
                const url = await grabFrame(t);
                item.dataset.bvSharp = url;
                sharpFails = 0;
                storyLog("清楚畫面", clock(t), `${Math.round(performance.now() - t0)}ms`);
                // 先解碼好再換，不然換的那一瞬間會空一格
                const pre = new Image();
                pre.src = url;
                await pre.decode().catch(() => {});
                if (viewer.isOpen() && viewer.current() === item && !viewer.gridOpen()) viewer.refresh();
            } catch (e) {
                storyWarn(`清楚畫面抓不到（${clock(t)}）：${e.message}`);
                if (++sharpFails >= SHARP_MAX_FAILS) storyWarn(`連續 ${sharpFails} 次失敗，這一頁不再抓清楚畫面`);
            }
        }
        sharpBusy = false;
    }

    // 串流挑最高解析度那條：master playlist 每條是 #EXT-X-STREAM-INF:…RESOLUTION=WxH 下一行網址
    async function bestVariant(uuid) {
        const master = `${CFG.seekCdn}/${uuid}/playlist.m3u8`;
        const r = await fetch(master, { cache: "no-store" });
        if (!r.ok) throw new Error(`playlist HTTP ${r.status}`);
        const lines = (await r.text()).split(/\r?\n/);
        let best = null;
        let bestH = 0;
        for (let i = 0; i < lines.length - 1; i++) {
            const h = Number(/RESOLUTION=\d+x(\d+)/.exec(lines[i])?.[1]);
            if (!h || h <= bestH) continue;
            bestH = h;
            best = new URL(lines[i + 1].trim(), master).href;
        }
        if (!best) throw new Error("playlist 裡沒有畫質");
        storyLog("清楚畫面用", `${bestH}p`, best);
        return best;
    }

    function sharpPlayer() {
        sharpVideo ||= (async () => {
            const spec = storySpec();
            if (!spec) throw new Error("沒有 uuid");
            const v = document.createElement("video");
            if (!v.canPlayType("application/vnd.apple.mpegurl")) throw new Error("這個瀏覽器不能原生播 HLS");
            v.muted = true;
            v.playsInline = true;
            v.preload = "metadata";            // 不要從頭一路緩衝；每次 seek 只會抓那一段（一段 4 秒、約 1 MB）
            v.crossOrigin = "anonymous";         // 沒有這個，畫到 canvas 上就不能 toDataURL
            v.src = await bestVariant(spec.uuid);
            await waitFor(v, "loadedmetadata");
            return v;
        })();
        // 起不來就別留著壞的 Promise，下次還能再試（失敗次數由 runSharp 算）
        sharpVideo.catch(() => { sharpVideo = null; });
        return sharpVideo;
    }

    function waitFor(v, type) {
        return new Promise((resolve, reject) => {
            const off = () => {
                clearTimeout(timer);
                v.removeEventListener(type, ok);
                v.removeEventListener("error", bad);
            };
            const ok = () => { off(); resolve(); };
            const bad = () => { off(); reject(new Error(`video error ${v.error?.code ?? ""}`.trim())); };
            const timer = setTimeout(() => { off(); reject(new Error(`等 ${type} 逾時`)); }, SHARP_TIMEOUT);
            v.addEventListener(type, ok);
            v.addEventListener("error", bad);
        });
    }

    async function grabFrame(t) {
        const v = await sharpPlayer();
        v.currentTime = Math.min(t, Math.max(0, v.duration - 0.1));
        await waitFor(v, "seeked");
        if (v.readyState < 2) await waitFor(v, "canplay");   // seeked 了但那一格還沒解出來（loadeddata 只會發一次，不能等它）
        const cv = document.createElement("canvas");
        cv.width = v.videoWidth;
        cv.height = v.videoHeight;
        cv.getContext("2d").drawImage(v, 0, 0);
        return cv.toDataURL("image/jpeg", 0.9);
    }

    // ── 分鏡 ──────────────────────────────────────────────────

    // 播放器設定裡的分鏡規格，跟 hd.js 用同一個解析（VHD.parse）；不是影片頁就回 null
    let specCache;
    function storySpec() {
        if (specCache === undefined) {
            const r = globalThis.VHD?.parse(document.documentElement.outerHTML);
            specCache = r?.th ? { uuid: r.u, th: r.th, dur: r.d } : null;
        }
        return specCache;
    }

    const SHEET_MAX_FAILS = 3;

    // 抓分鏡大圖。surrit 的規矩（2026-10-27 用 curl 量的）：
    // - 沒有 missav 的 Referer 一律 403 —— 所以只能從頁面這一側抓
    // - 請求帶 Origin 才回 Access-Control-Allow-Origin，而且沒有 Vary: Origin
    // 播放器用 <img> 載過的那張（沒有 Origin）會以「沒有 CORS header」的版本留在快取裡，
    // 之後一般的 fetch 命中它就被 CORS 擋。no-store 跳過快取直接問伺服器，也不覆寫播放器那份
    async function loadSheet(url) {
        const t0 = performance.now();
        let r;
        try {
            r = await fetch(url, { cache: "no-store" });
        } catch (e) {
            // CORS 擋下或網路斷了：fetch 只給 TypeError，看不到狀態碼，詳細原因在 console 上一行的紅字
            throw new Error(`網路 / CORS 錯誤（${e.message}）`);
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bmp = await createImageBitmap(await r.blob());
        storyLog("ok", url.replace(/^.*\/seek\//, ""), `${bmp.width}×${bmp.height}`, `${Math.round(performance.now() - t0)}ms`);
        return bmp;
    }

    // 分鏡：大圖一張 col×row 格，大約 2 秒一格。全部切出來一部片上千格，翻不完也沒意義，
    // 所以每 stride 格取一格、總數壓在 storyMax 以內。切好的格子轉成 data: URL。
    // 第一張大圖切完就開，後面的走 viewer 的續頁（source.more）一張一張接上來。
    // 這一頁的分鏡快取：{ uuid, items, more, at }。關掉再開不用重抓 ——
    // items 就是交給 viewer 的那個陣列，續頁接上來的格子直接 push 進它，所以快取自己會長；
    // more 的閉包記著抓到第幾張大圖，關掉時沒抓完的，重開會接著抓。at 是上次看到第幾格。
    // 只放記憶體：換影片是整頁重新載入，content script 重來一次就清掉了，用 uuid 對再保險一次
    let storyCache = null;

    const storyTitle = () => (document.querySelector('meta[property="og:title"]')?.content || document.title).trim();
    const storySource = more => ({ more, label: added => t().added(added) });   // 打的是 CDN，不用替站台喘氣

    async function openStoryboard() {
        const spec = storySpec();
        if (!spec) return t().noSpec;
        const { uuid, th } = spec;
        if (storyCache?.uuid === uuid) {
            storyLog("用這頁的快取", `${storyCache.items.length} 格`, `從第 ${storyCache.at + 1} 格開`);
            await open(storyCache.items, storyCache.at, storyTitle(), storySource(storyCache.more));
            return "";
        }
        const vd = playerVideo()?.duration;
        const dur = spec.dur || (Number.isFinite(vd) ? vd : 0);
        // 第 k 格是哪一秒。分鏡是固定每 step 秒取一格、取在那一段的正中間，所以是 (k + 0.5) × step。
        // step 是整數秒：pic_num 是片長 ÷ step 無條件進位（852 格 × 2 秒 = 1704，片長 1703），
        // 直接拿片長 ÷ 格數會得到 1.9988，越後面差越多。2026-10-27 拿 ffmpeg 解串流、每格比對量的：
        // 兩張大圖裡每一格都落在 2k + 1 秒，誤差一個影格（0.04 秒）。
        // 除出來不接近整數（不是這套產生方式）就照用原本的值；量不到片長就只標編號、不能跳
        const raw = dur ? dur / th.n : 0;
        const step = Math.abs(raw - Math.round(raw)) < 0.05 && Math.round(raw) >= 1 ? Math.round(raw) : raw;
        const tAt = k => Math.min((k + 0.5) * step, Math.max(0, dur - 0.5));
        const per = th.col * th.row;
        const sheets = Math.ceil(th.n / per);
        const stride = Math.max(1, Math.ceil(th.n / CFG.storyMax));
        let sheet = 0;
        let k = 0;                                  // 下一個要取的是全片第幾格
        const skipped = [];                         // 抓不到、整張略過的大圖（0 起算）
        storyLog("開始", { uuid, ...th, dur, step: +step.toFixed(3), sheets, stride });

        const cv = document.createElement("canvas");
        cv.width = th.w;
        cv.height = th.h;
        const cx = cv.getContext("2d");

        // 下一張有格子要取的大圖，切出那幾格。單張抓不到就跳過那張（少一段，不是整個停）；
        // 連續 SHEET_MAX_FAILS 張都不行才丟錯，續頁那邊會收手
        let fails = 0;
        async function more() {
            while (sheet < sheets) {
                const s = sheet++;
                const end = Math.min(th.n, (s + 1) * per);
                if (k >= end) continue;                 // stride 比一張大圖還大時，有些大圖整張跳過
                const url = `${CFG.seekCdn}/${uuid}/seek/_${s}.jpg`;
                let bmp;
                try {
                    bmp = await loadSheet(url);
                    fails = 0;
                } catch (e) {
                    skipped.push(s);
                    storyWarn(`第 ${s + 1}/${sheets} 張失敗：${e.message}`, url);
                    if (++fails >= SHEET_MAX_FAILS) {
                        storyWarn(`連續 ${fails} 張失敗，停止；略過的大圖：`, skipped.map(x => x + 1));
                        throw e;
                    }
                    while (k < end) k += stride;          // 這張的格子全部略過，從下一張接著取
                    continue;
                }
                const out = [];
                for (; k < end; k += stride) {
                    const i = k - s * per;
                    // 圖可能比 col×w 大一點（邊框），照規格的格子位置切
                    cx.drawImage(bmp, (i % th.col) * th.w, Math.floor(i / th.col) * th.h, th.w, th.h, 0, 0, th.w, th.h);
                    const data = { bvCap: step ? clock(tAt(k)) : `#${k + 1}` };
                    if (step) data.bvT = String(tAt(k));
                    out.push(makeItem(cv.toDataURL("image/jpeg", 0.9), th.w, th.h, data));
                }
                bmp.close();
                return out;
            }
            if (sheet >= sheets && !more.done) {
                more.done = true;
                storyLog(`完成：${sheets} 張大圖`, skipped.length ? { 略過: skipped.map(x => x + 1) } : "全部抓到");
            }
            return [];
        }

        let first;
        try { first = await more(); } catch (e) { return t().storyFail(e.message); }
        if (!first.length) return t().noSpec;
        storyCache = { uuid, items: first, more, at: 0 };
        await open(first, 0, storyTitle(), storySource(more));
        return "";
    }

    // ── 封面牆 ────────────────────────────────────────────────
    // 頁面上現有的影片卡片，不往後抓（站台在 Cloudflare 後面，fetch 列表頁不可靠）
    function openCoverWall() {
        const list = [];
        const seen = new Set();
        let start = -1;
        for (const card of document.querySelectorAll(CFG.card)) {
            if (!card.getClientRects().length) continue;   // x-show 藏起來的佔位卡
            const a = card.querySelector(CFG.link);
            const raw = a?.getAttribute("href") || "";
            if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) continue;   // 還沒渲染的模板
            if (seen.has(a.href)) continue;                 // 封面跟標題各一個連結，同一部可能出現兩次
            const img = card.querySelector(CFG.cover);
            const src = img?.dataset.src || img?.currentSrc || img?.src || "";
            if (!/^https?:/.test(src)) continue;
            seen.add(a.href);
            const title = (card.querySelector(CFG.title)?.textContent || a.getAttribute("alt") || "")
                .replace(/\s+/g, " ").trim();
            const dur = [...card.querySelectorAll(CFG.badge)]
                .map(el => el.textContent.trim()).find(t => CFG.duration.test(t)) || "";
            const item = makeItem(src, 800, 537, { bvHref: a.href, bvTitle: title, bvCap: dur });
            item.bvCard = card;                             // 關掉時捲回這張卡片
            const pv = card.querySelector("video.preview");
            const pvSrc = pv?.getAttribute("data-src") || pv?.getAttribute("src") || "";
            if (pvSrc) item.bvPreview = new URL(pvSrc, location.href).href;   // hover 時播（tileHover）
            // 從畫面上第一張看得到的卡片開始，不用每次都從頁首翻
            if (start < 0 && card.getBoundingClientRect().bottom > 0) start = list.length;
            list.push(item);
        }
        if (!list.length) return t().noCards;
        open(list, Math.max(0, start), "");
        return "";
    }

    // ── 封面牆：滑鼠停在格子上（或單張的圖上）播預覽（設定 viewerPreview）─────────────
    // 先播站台的 preview.mp4；設定 viewerHD 開著就再疊一層高畫質快剪，出畫面才淡入蓋上去。
    // 跟頁面卡片的 hover（hoverHD，只用快取）不同：快取沒有就去抓影片頁，所以封面牆每一部都能播高畫質。
    // 停 HOVER_DELAY 才開始，掃過去的格子不發 request；同時只有一格（viewer 保證），移開就整個拿掉。
    // el 是總覽的格子，或單張時疊在圖上的那一層（viewer 讓它跟圖同大小、同變形）
    const HOVER_DELAY = 300;
    function hoverPreview(item, el) {
        if (!item.bvPreview || !VHS.on("viewerPreview")) return null;
        const boxes = [];
        let mont = null;
        let dead = false;
        const layer = () => {
            const box = document.createElement("div");
            box.className = "vh-tp";
            el.append(box);
            boxes.push(box);
            return box;
        };
        const timer = setTimeout(async () => {
            const box = layer();
            const v = document.createElement("video");
            v.muted = v.defaultMuted = true;
            v.playsInline = true;
            v.loop = true;
            v.addEventListener("playing", () => { box.dataset.live = "1"; }, { once: true });
            v.src = item.bvPreview;
            box.append(v);
            v.play().catch(() => {});

            // 高畫質：跟輪播同一條路（VHD.resolve）。快取沒有就去抓影片頁找串流、挑片段，
            // 抓頁一次一個、被 Cloudflare 擋會退避（hd.js）；結果進快取，之後這張和頁面上的卡片都直接用
            const id = /\/([^/]+)\/preview\.mp4$/.exec(item.bvPreview)?.[1];
            const href = item.dataset.bvHref;
            if (!id || !href || !VHS.on("viewerHD") || !globalThis.VHD) return;
            const entry = await VHD.resolve({ id, href }, VHS.get("heroHDPick"));
            if (dead || !entry) return;
            const hd = layer();
            mont = VHD.montage(hd, entry, VHD.quality(el.getBoundingClientRect().width), () => { hd.remove(); mont = null; });
            mont.play().catch(() => {});
        }, HOVER_DELAY);
        return () => {
            dead = true;
            clearTimeout(timer);
            mont?.stop();
            for (const box of boxes) {
                for (const v of box.querySelectorAll("video")) {
                    v.pause();
                    v.removeAttribute("src");           // 拿掉 src 才會真的中斷下載
                    v.load();
                }
                box.remove();
            }
        };
    }

    // ── 入口：畫面右緣正中間的抽屜（自己一個 Shadow DOM，不碰頁面樣式）──
    // 左下角會壓到播放器的播放鍵、上面是站台的導覽列，右緣中段是唯一沒人用的地方。
    // 平常只露出 PEEK 寬的一條把手，滑鼠碰到（或 Tab 進來）才整個滑出來，播放器滿版時也只蓋到邊上一條。
    // 把手要自己看得見：站台是深色底，6px 的深灰半透明條等於隱形，所以左緣是粉色、中間一條淺色握把、外加陰影。
    // 不用快速鍵：播放器（Plyr）跟站台自己都吃鍵盤，撞到哪個都麻煩。
    // 分鏡只在讀得到規格的影片頁出現；封面牆一律出現（卡片是 Alpine 晚點才畫的，按下去才數）
    const PEEK = 14;
    const host = document.createElement("div");
    host.id = "vh-viewer-launch";
    host.style.cssText = "all:initial;position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:2147483646;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .drawer {
          position: relative;
          display: flex; flex-direction: column; gap: 4px; padding: 6px;
          padding-left: ${PEEK + 2}px;      /* 左邊留給把手，滑出來時按鈕不壓在握把上 */
          border-radius: 10px 0 0 10px;
          background: rgba(28, 28, 34, .94); border: 1px solid rgba(255, 255, 255, .22); border-right: 0;
          border-left: 3px solid #fe628e;
          box-shadow: -2px 0 10px rgba(0, 0, 0, .55);
          transform: translateX(calc(100% - ${PEEK}px)); opacity: .85;
          transition: transform .18s ease, opacity .18s;
        }
        /* 握把：收著的時候唯一看得到的那一條裡，垂直置中一根淺色短棒 */
        .drawer::before {
          content: ''; position: absolute; left: ${Math.round(PEEK / 2) - 3}px; top: 50%;
          width: 3px; height: 28px; margin-top: -14px; border-radius: 2px;
          background: rgba(255, 255, 255, .6);
        }
        .drawer:hover, .drawer:focus-within, .drawer[data-open] { transform: none; opacity: 1; }
        button {
          all: unset; cursor: pointer; padding: 6px 10px; border-radius: 6px; text-align: center;
          font: 13px/1.2 system-ui, sans-serif; color: #e8e8ea; white-space: nowrap;
        }
        button:hover { background: rgba(254, 98, 142, .18); color: #fff; }
        button:focus-visible { outline: 2px solid #fe628e; }
        button[hidden] { display: none; }
        button[data-busy] { cursor: progress; opacity: .6; }
        /* 開不起來的原因：橫的泡泡掛在抽屜左邊，不把按鈕撐寬 */
        .msg {
          position: absolute; right: calc(100% + 8px); top: 50%; transform: translateY(-50%);
          padding: 6px 10px; border-radius: 6px; white-space: nowrap;
          font: 13px/1.2 system-ui, sans-serif; color: #fff; background: rgba(160, 40, 50, .92);
          pointer-events: none;
        }
        .msg[hidden] { display: none; }
        :host([data-reduce]) .drawer { transition: none; }
      </style>
      <div class="drawer">
        <button data-act="story" hidden></button>
        <button data-act="wall"></button>
        <div class="msg" hidden></div>
      </div>`;
    const drawer = root.querySelector(".drawer");
    const msg = root.querySelector(".msg");
    const story = root.querySelector('[data-act="story"]');
    const wall = root.querySelector('[data-act="wall"]');

    // 設定改了即時套用：總開關關掉整個抽屜不見，兩個項目各管自己那顆；語言也是
    function applySettings() {
        const s = t();
        story.textContent = s.story;
        story.title = s.storyTip;
        wall.textContent = s.wall;
        wall.title = s.wallTip;
        story.hidden = !(VHS.on("viewerStory") && storySpec());
        wall.hidden = !VHS.on("viewerWall");
        host.hidden = !VHS.on("viewer") || (story.hidden && wall.hidden);
        host.toggleAttribute("data-reduce", VHS.reduced());
    }
    applySettings();
    VHS.subscribe(applySettings);

    let msgTimer = 0;
    root.addEventListener("click", async e => {
        const b = e.target.closest("button");
        if (!b || b.dataset.busy != null || viewer?.busy()) return;
        b.dataset.busy = "";
        drawer.dataset.open = "";      // 抓第一張分鏡要一下子，滑鼠移開也別先收回去
        // 回傳的是開不起來的原因（viewer 沒開，toast 也就沒地方出），在旁邊顯示一下
        const why = await (b === story ? openStoryboard() : openCoverWall());
        delete b.dataset.busy;
        clearTimeout(msgTimer);
        msg.textContent = why;
        msg.hidden = !why;
        if (!why) { delete drawer.dataset.open; return; }
        msgTimer = setTimeout(() => { msg.hidden = true; delete drawer.dataset.open; }, 2500);
    });
    document.documentElement.appendChild(host);

    // health.js 用：影片頁讀不到分鏡規格（站台改了播放器設定的寫法）
    globalThis.VHV = { storyOk: () => Boolean(storySpec()) };
})();

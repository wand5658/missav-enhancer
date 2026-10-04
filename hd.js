// 輪播的高畫質預覽（設定 heroHD）：用正片的 HLS 串流取代 320×180 的 preview.mp4。
//
// 串流網址是 surrit.com/<uuid>/<畫質>/video.m3u8，uuid 只在影片頁的 HTML 裡（卡片上那個 uuid 不是它），
// 所以要同源 fetch 影片頁；站台在 Cloudflare 後面，會不定時回 403，失敗就退回 preview.mp4。
// 拿到的結果（uuid、片長、拖曳預覽圖的規格、挑好的起點）存在 chrome.storage.local，同一部不再 fetch。
// 使用者自己打開影片頁時，這裡直接從頁面讀進快取，不花任何請求。
//
// Chrome 原生播得了 HLS（canPlayType 回 maybe），不用 hls.js：<video src=m3u8> 再設 currentTime，
// 瀏覽器只下載那一段的 4 秒分段。
//
// 起點怎麼挑：站台自己的 preview.mp4 只是在 10%、20%…80% 各剪 1 秒（2026-10 量過），沒有挑選；
// 這裡抽幾張拖曳預覽圖（每張 6×6 格，約每 2 秒一格），每 12 秒一個窗格打分：
// 膚色比例（太滿通常是暖色燈光或極近特寫，扣分）＋畫面變動量，窗格裡有換鏡頭、太暗或太平的不要。
globalThis.VHD = (() => {
    const CDN = "https://surrit.com";
    const CLIP_S = 12;                      // 每段播多長（3 個 HLS 分段）
    const SAMPLE_AT = [0.3, 0.45, 0.6, 0.75];  // 抽哪幾張拖曳預覽圖（片長比例）；片頭多半是訪談，不抽
    const TILE_W = 48, TILE_H = 27;         // 打分用的縮圖尺寸
    const KEY = id => `hd:${id}`;
    const VER = 1;                          // 快取格式或挑選演算法改了就加一，舊的重算
    const local = globalThis.chrome?.storage?.local;

    const log = (...a) => console.debug("[hd]", ...a);

    // ── 從影片頁的 HTML 讀資料 ─────────────────────────────────
    // 拖曳預覽圖的網址是明文（播放器設定的 thumbnail.urls），uuid 從那裡拿最穩；
    // 找不到再解 eval(function(p,a,c,k,e,d)…) 那段打包過的 script
    function parse(html) {
        let uuid = /surrit\.com\\?\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\?\/seek/.exec(html)?.[1];
        if (!uuid) uuid = /surrit\.com\/([0-9a-f-]{36})\/playlist\.m3u8/.exec(unpackAll(html))?.[1];
        if (!uuid) return null;
        // 頁面上別的 script 也有 width:，只在播放器設定的 thumbnail: { … urls 那段裡找
        const block = /thumbnail:\s*\{([\s\S]*?)urls:/.exec(html)?.[1] || "";
        const num = k => Number(new RegExp(`\\b${k}:\\s*(\\d+)`).exec(block)?.[1]) || 0;
        const dur = Number(/property="og:video:duration" content="(\d+)"/.exec(html)?.[1]) || 0;
        const th = { n: num("pic_num"), w: num("width"), h: num("height"), col: num("col"), row: num("row") };
        return { u: uuid, d: dur, th: th.n && th.w && th.h && th.col && th.row ? th : null };
    }

    function unpackAll(html) {
        let out = "";
        const re = /\}\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
        for (const m of html.matchAll(re)) {
            const [, p, a, , k] = m;
            const base = Number(a), words = k.split("|");
            if (base > 36) continue;
            out += p.replace(/\b\w+\b/g, w => words[parseInt(w, base)] || w).replace(/\\'/g, "'") + "\n";
        }
        return out;
    }

    // ── 快取 ──────────────────────────────────────────────────
    const getCache = id => new Promise(res => {
        if (!local) return res(null);
        local.get(KEY(id), o => {
            const e = o?.[KEY(id)];
            res(e && e.v === VER ? e : null);
        });
    });
    const putCache = (id, e) => local?.set({ [KEY(id)]: { ...e, v: VER, t: Date.now() } });

    // 影片頁：自己的 HTML 就有，讀進快取（不挑起點，等輪播用到再挑）
    function harvest() {
        const id = /\/\/[^/]+\/([^/]+)\/cover-n\.jpg/.exec(document.querySelector('meta[property="og:image"]')?.content || "")?.[1];
        if (!id) return;
        const html = [...document.scripts].map(s => s.textContent).join("\n")
            + document.head.innerHTML;      // og:video:duration 在 <head>
        const info = parse(html);
        if (!info) return;
        getCache(id).then(old => {
            if (old?.u === info.u) return;
            putCache(id, info);
            log("harvest", id, info.u);
        });
    }

    // ── fetch 影片頁：一次一個，被 Cloudflare 擋就退避 ──────────
    // 2026-10 量到的 403 像是逐次隨機（200、403、200、403…），不是一擋就整段擋，
    // 所以同一個網址隔幾秒重試；連續好幾次都擋才整體退避
    const RETRY_MS = [2500, 5000];
    const BLOCK_AFTER = 4;                  // 連續幾次 403 就退避
    let chain = Promise.resolve();
    let blockedUntil = 0, backoff = 60e3, streak = 0;
    const stats = { ok: 0, blocked: 0, cached: 0 };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const HEADERS = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

    function fetchInfo(href) {
        const url = href.split("#")[0];
        const job = chain.then(async () => {
            for (let i = 0; i <= RETRY_MS.length; i++) {
                if (Date.now() < blockedUntil) return null;
                const r = await fetch(url, { credentials: "include", headers: HEADERS }).catch(() => null);
                if (r?.ok) {
                    streak = 0;
                    backoff = 60e3;
                    stats.ok++;
                    return parse(await r.text());
                }
                stats.blocked++;
                // Cloudflare 的挑戰頁會帶 cf-mitigated: challenge（官方建議 fetch 端用它判斷）
                log(r?.headers.get("cf-mitigated") === "challenge" ? "challenge" : `http ${r?.status ?? "error"}`, url);
                if (++streak >= BLOCK_AFTER) {
                    blockedUntil = Date.now() + backoff;
                    log("blocked", r?.status, `連續 ${streak} 次，退避 ${backoff / 1000}s`, stats);
                    backoff = Math.min(backoff * 2, 15 * 60e3);
                    streak = 0;
                    return null;
                }
                if (i < RETRY_MS.length) await sleep(RETRY_MS[i]);
            }
            log("give up", url, stats);
            return null;
        });
        chain = job.catch(() => null);
        return job;
    }

    // ── 挑起點 ────────────────────────────────────────────────
    async function sheetTiles(u, th, sheet) {
        const r = await fetch(`${CDN}/${u}/seek/_${sheet}.jpg`).catch(() => null);
        if (!r?.ok) return [];
        const bmp = await createImageBitmap(await r.blob());
        const cv = new OffscreenCanvas(th.col * TILE_W, th.row * TILE_H);
        const cx = cv.getContext("2d", { willReadFrequently: true });
        // 圖可能比 col×w 大一點（邊框），照規格切
        cx.drawImage(bmp, 0, 0, th.col * th.w, th.row * th.h, 0, 0, cv.width, cv.height);
        bmp.close();
        const per = th.col * th.row, first = sheet * per, tiles = [];
        for (let i = 0; i < per && first + i < th.n; i++) {
            const x = (i % th.col) * TILE_W, y = Math.floor(i / th.col) * TILE_H;
            tiles.push({ idx: first + i, px: cx.getImageData(x, y, TILE_W, TILE_H).data });
        }
        return tiles;
    }

    function features(px) {
        const n = px.length / 4, luma = new Float32Array(n), hist = new Float32Array(64);
        let skin = 0, sum = 0;
        for (let i = 0; i < n; i++) {
            const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
            const y = 0.299 * r + 0.587 * g + 0.114 * b;
            const cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b;
            const cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b;
            if (y >= 50 && cr >= 135 && cr <= 175 && cb >= 80 && cb <= 125) skin++;
            luma[i] = y; sum += y;
            hist[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)]++;
        }
        const mean = sum / n;
        let v = 0;
        for (let i = 0; i < n; i++) v += (luma[i] - mean) ** 2;
        for (let i = 0; i < 64; i++) hist[i] /= n;
        return { skin: skin / n, luma, mean, std: Math.sqrt(v / n), hist };
    }

    // 膚色：0.7 以下越多越好，再多（整片暖色、極近特寫）反而扣分
    const skinScore = s => s <= 0.7 ? s / 0.7 : 1 - (s - 0.7);

    function bestWindow(tiles, step) {
        const win = Math.max(2, Math.round(CLIP_S / step));
        const F = tiles.map(t => ({ idx: t.idx, ...features(t.px) }));
        for (let i = 1; i < F.length; i++) {
            const a = F[i - 1], b = F[i];
            let d = 0, inter = 0;
            for (let k = 0; k < a.luma.length; k++) d += Math.abs(a.luma[k] - b.luma[k]);
            for (let k = 0; k < 64; k++) inter += Math.min(a.hist[k], b.hist[k]);
            b.motion = d / a.luma.length;
            b.cut = inter < 0.55 || F[i].idx !== F[i - 1].idx + 1;
        }
        let best = null;
        for (let i = 1; i + win <= F.length; i++) {
            const w = F.slice(i, i + win);
            if (w.slice(1).some(f => f.cut)) continue;
            if (w.some(f => f.mean < 40 || f.std < 20)) continue;
            const skin = w.reduce((s, f) => s + skinScore(f.skin), 0) / win;
            const motion = w.slice(1).reduce((s, f) => s + f.motion, 0) / (win - 1);
            const score = skin + 0.4 * Math.min(motion / 12, 1);
            if (!best || score > best.score) best = { score, idx: w[0].idx };
        }
        return best;
    }

    async function pickStart(info) {
        const d = info.d;
        const fallback = Math.round(d * 0.5);
        if (!info.th || !d) return { s: fallback, how: "middle" };
        const { th } = info;
        const step = d / th.n, per = th.col * th.row;
        const sheets = [...new Set(SAMPLE_AT.map(f => Math.floor(f * th.n / per)))];
        let best = null;
        for (const sh of sheets) {
            const b = bestWindow(await sheetTiles(info.u, th, sh), step);
            if (b && (!best || b.score > best.score)) best = b;
        }
        if (!best) return { s: fallback, how: "middle" };
        return { s: Math.max(0, Math.min(Math.round(best.idx * step), d - CLIP_S - 1)), how: "smart", score: +best.score.toFixed(3) };
    }

    // ── 對外 ──────────────────────────────────────────────────
    const pending = new Map();

    // item：hero.js 的 {id, href}。回傳 {u, d, s} 或 null（拿不到就用 preview.mp4）
    function resolve(item, pick) {
        if (pending.has(item.id)) return pending.get(item.id);
        const job = (async () => {
            let e = await getCache(item.id);
            if (e) stats.cached++;
            if (!e) {
                const info = await fetchInfo(item.href);
                if (!info) return null;
                e = info;
            }
            if (e.s == null || e.how !== pick) {
                const p = pick === "smart" ? await pickStart(e) : { s: Math.round((e.d || 0) * 0.5), how: "middle" };
                e = { ...e, ...p };
                putCache(item.id, e);
                const mmss = t => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
                log("pick", item.id, mmss(p.s), p, stats);
            }
            return e.u && e.d ? e : null;
        })().catch(err => { log("error", item.id, err); return null; })
            .finally(() => pending.delete(item.id));
        pending.set(item.id, job);
        return job;
    }

    // 畫質：auto 依畫框實際像素寬挑，畫框最寬 800 CSS px，DPR 1 時 480p 就接近原生
    function quality(frameWidth) {
        const q = globalThis.VHS?.get("heroHDQuality") || "auto";
        if (q !== "auto") return q;
        return frameWidth * (globalThis.devicePixelRatio || 1) > 900 ? "720p" : "480p";
    }

    const src = (e, q) => `${CDN}/${e.u}/${q}/video.m3u8`;

    if (globalThis.VH?.kind?.() === "video") harvest();

    return { resolve, quality, src, CLIP_S, stats, parse };
})();

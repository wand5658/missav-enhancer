/* 全螢幕看圖 viewer：單張、格狀總覽、縮圖列、輪播、下載 / 複製。
   這支不認得任何網站 —— 沒有站台設定、沒有選擇器、不碰 chrome.*；圖從哪來、存到哪、
   工具列多哪幾顆，都由呼叫的一方（宿主）在 create(host) 時交代。當 content script 用時
   排在宿主前面載入（同一個 isolated world）。

   host 欄位（沒標「必填」的都可以省略）：
   - css()            必填，回傳 Promise<string>：viewer 的樣式，塞進 Shadow DOM
   - id               掛在頁面上那個 host 元素的 id（預設 bv-viewer）
   - lang             'zh' / 'en'：介面語言，建 viewer 時決定（預設 zh）
   - ready()          開 viewer 前要等的東西（設定 / 收藏讀回來）
   - prefs            必填，偏好的初始值（同 prefs.js 的 DEFAULTS 那幾個欄位）
   - gridSteps / stepIndex   必填，總覽欄寬的檔位表與「最接近哪一檔」
   - savePrefs(patch) viewer 裡用按鍵調過的偏好要寫回去（要不要 debounce 是宿主的事）
   - minSize          自然寬高都小於它的圖當成失效圖拿掉（0 = 不檢查）
   - rewrite          [[RegExp, 取代字串], ...]：優先載改寫後的網址，失敗退回原本的
   - download(url, filename)  回傳 Promise<boolean>；不給就整組下載 / 複製網址（⭳ ▾、S、C）都不出現
   - tools            [{ act, text, title, cls }]：插在下載鈕前面的工具列按鈕
   - keys             { 按鍵: act }：沒被 viewer 自己用掉的按鍵
   - help             [[按鍵, 說明], ...]：接在快速鍵說明裡
   - action(act)      tools / keys 的 act 由它處理
   - itemAction(item) 這一張的動作 { label, run } 或 null（Enter 與工具列最左邊那顆）
   - onShow(item)     換到某一張之後
   - tileHover(item, tile)  滑鼠進到總覽的某一格；回傳一個收掉的函式（滑鼠離開、總覽關掉時呼叫）
   - imageHover(item, layer)  單張時滑鼠在圖上；layer 疊在圖上、跟著縮放 / 平移 / 旋轉，大小是圖的原尺寸。
                      回傳收掉的函式（離開圖、換張、開總覽、關 viewer 時呼叫）
   - reduced()        要不要少動畫（預設看 prefers-reduced-motion）；目前只管標題跑馬燈
   - onRound(items)   一輪開始（items 已換好、goTo 之前）；回傳這一輪的標題
   - onUpdate()       工具列狀態更新完；宿主自己的按鈕在這裡跟著改
   - onClose(items, index)   viewer 關掉之後（捲回頁面上的哪裡由宿主決定）

   清單裡是 <img>（頁面上的、DOMParser 的、或自己建的都行），每張可以帶 data-bv-*：
   title（上方列標題，蓋過這一輪的；也畫在總覽格子底部）、cap（接在計數器後、畫在格子角落）、
   sharp（換成這個網址顯示 / 下載）。

   open(list, i, source)：source = { more, gap, label } 時是續頁 ——
   more() 回傳下一批 <img>，空的就是沒了；gap 是每批之間喘幾 ms；label(added, pages) 是接上時的提示 */
(() => {
  'use strict';
  if (globalThis.BV_VIEWER) return;

  // 頁面上原本的網址。rotations 的 key、縮圖列、備援都以它為基準
  const srcOf = (el) => el.currentSrc || el.src;

  /* 介面文字。host.lang 挑一份；函式的是帶數字的提示。
     help 是快速鍵說明的列，dl 那幾列只有宿主給了 download 才出現 */
  const STR = {
    zh: {
      modes: { fit: '適應視窗', width: '符合寬度', actual: '100%', free: '自由縮放' },
      prev: '上一張', next: '下一張',
      tMode: '切換顯示模式 (0 / W / 1)', tZoomOut: '縮小 (-)', tZoomIn: '放大 (+)',
      tRotate: '逆時針旋轉 90° (R，Shift+R 順時針)', tShuffle: '隨機順序輪播 (Shift+P)',
      tThumbs: '縮圖列 (T)', tGrid: '格狀總覽 (G)', tDownload: '下載這張 (S)', tDlMenu: '下載 / 複製網址選項',
      tFull: '全螢幕 (F)', tHelp: '快速鍵說明 (?)', tClose: '關閉 (Esc)', tBack: '回總覽 (Esc)',
      tPlay: (s) => `輪播 ${s} 秒 (P)，間隔用 [ ] 調`,
      miDownload: '下載這張', miCopy: '複製這張網址',
      miAll: (n) => `下載全部（${n} 張）`, miRest: (n) => `從這張開始（${n} 張）`, miCopyAll: (n) => `複製全部網址（${n} 個）`,
      helpTitle: '快速鍵',
      help: [
        ['← → / Space', '上一張 / 下一張'],
        ['滾輪', '捲動圖片，到底再翻頁'],
        ['點左 / 右半邊', '上一張 / 下一張'],
        ['拖曳', '平移'],
        ['Ctrl + 滾輪', '以游標為中心縮放（總覽時調縮圖大小）'],
        ['+ / −', '放大 / 縮小（總覽時調縮圖大小）'],
        ['0 / W / 1', '適應視窗 / 符合寬度 / 原尺寸'],
        ['R / Shift+R', '逆 / 順時針旋轉'],
        ['P', '開始 / 暫停輪播'],
        ['Shift+P', '輪播照順序 ↔ 隨機（每張都放過一次才重來）'],
        ['[ / ]', '輪播間隔 −0.5 / +0.5 秒'],
        ['T', '縮圖列'],
        ['G', '格狀總覽 ↔ 單圖（開啟時預設是總覽；從總覽進單圖後，右上角的 ✕ / Esc 是回總覽）'],
      ],
      helpDl: [['S', '下載這張'], ['Shift+S', '下載全部（Esc 取消）'], ['C / Shift+C', '複製這張 / 全部圖片網址']],
      helpFull: ['F', '全螢幕'],
      helpEnd: [
        ['Home / End', '第一張 / 最後一張'],
        ['翻到最後', '自動接上後續的圖，不用回頁面按下一頁'],
        ['滑鼠靜止', '工具列自動隱藏，動一下就回來'],
        ['Esc', '關閉'],
      ],
      dead: '略過一張已失效的圖', loadingNext: '載入下一頁…', added: (n) => `接上 ${n} 張`,
      first: '已經是第一張', last: '已經是最後一張', endPick: '看完了，挑下一個',
      slideEnd: '輪播結束', slidePause: '輪播暫停',
      slideStart: (shuf, s) => `${shuf ? '隨機輪播' : '輪播'}開始 ${s} 秒`,
      shuffleOn: '隨機順序', shuffleOff: '照順序', interval: (s) => `輪播間隔 ${s} 秒`,
      gridMax: '已經是最大', gridMin: '已經是最小', gridSize: (px) => `縮圖 ${px}px`,
      downloaded: (i, n) => `已下載 ${i} / ${n}`, dlFail: '下載失敗', dlBusy: '還在下載，Esc 可取消',
      dlCrawl: '先把後續的圖接完…', dlProgress: (i, n) => `下載中 ${i} / ${n}（Esc 取消）`,
      dlCancelled: (ok) => `已取消，已下載 ${ok} 張`, dlDoneFail: (ok, f) => `下載完成 ${ok} 張，失敗 ${f} 張`,
      dlDone: (ok) => `下載完成 ${ok} 張`,
      copied: (i) => `已複製第 ${i} 張的網址`, copyFail: '複製失敗', copiedAll: (n) => `已複製 ${n} 個網址`,
      imgFail: '圖片載入失敗', noFull: '無法進入全螢幕', helpHint: '按 ? 看快速鍵',
    },
    en: {
      modes: { fit: 'Fit', width: 'Fit width', actual: '100%', free: 'Free zoom' },
      prev: 'Previous', next: 'Next',
      tMode: 'Display mode (0 / W / 1)', tZoomOut: 'Zoom out (-)', tZoomIn: 'Zoom in (+)',
      tRotate: 'Rotate 90° left (R, Shift+R right)', tShuffle: 'Shuffle slideshow (Shift+P)',
      tThumbs: 'Thumbnail strip (T)', tGrid: 'Grid overview (G)', tDownload: 'Download this image (S)', tDlMenu: 'Download / copy URL options',
      tFull: 'Full screen (F)', tHelp: 'Keyboard shortcuts (?)', tClose: 'Close (Esc)', tBack: 'Back to grid (Esc)',
      tPlay: (s) => `Slideshow, ${s}s (P); [ ] changes the interval`,
      miDownload: 'Download this image', miCopy: 'Copy this image URL',
      miAll: (n) => `Download all (${n})`, miRest: (n) => `Download from here (${n})`, miCopyAll: (n) => `Copy all URLs (${n})`,
      helpTitle: 'Keyboard shortcuts',
      help: [
        ['← → / Space', 'Previous / next'],
        ['Wheel', 'Scroll the image, then turn the page at the end'],
        ['Click left / right', 'Previous / next'],
        ['Drag', 'Pan'],
        ['Ctrl + wheel', 'Zoom around the pointer (thumbnail size in the grid)'],
        ['+ / −', 'Zoom in / out (thumbnail size in the grid)'],
        ['0 / W / 1', 'Fit / fit width / actual size'],
        ['R / Shift+R', 'Rotate left / right'],
        ['P', 'Start / pause the slideshow'],
        ['Shift+P', 'Slideshow in order ↔ shuffled (each image once before repeating)'],
        ['[ / ]', 'Slideshow interval −0.5 / +0.5 s'],
        ['T', 'Thumbnail strip'],
        ['G', 'Grid ↔ single image (it opens on the grid; from there, ✕ / Esc in single view goes back to the grid)'],
      ],
      helpDl: [['S', 'Download this image'], ['Shift+S', 'Download all (Esc cancels)'], ['C / Shift+C', 'Copy this / all image URLs']],
      helpFull: ['F', 'Full screen'],
      helpEnd: [
        ['Home / End', 'First / last image'],
        ['Past the end', 'Loads what comes next automatically'],
        ['Mouse still', 'The toolbar hides; move the mouse to bring it back'],
        ['Esc', 'Close'],
      ],
      dead: 'Skipped a broken image', loadingNext: 'Loading more…', added: (n) => `Added ${n}`,
      first: 'This is the first image', last: 'This is the last image', endPick: 'That was the last one — pick what is next',
      slideEnd: 'Slideshow ended', slidePause: 'Slideshow paused',
      slideStart: (shuf, s) => `${shuf ? 'Shuffled slideshow' : 'Slideshow'}, ${s}s`,
      shuffleOn: 'Shuffled', shuffleOff: 'In order', interval: (s) => `Interval ${s}s`,
      gridMax: 'Already the largest', gridMin: 'Already the smallest', gridSize: (px) => `Thumbnails ${px}px`,
      downloaded: (i, n) => `Downloaded ${i} / ${n}`, dlFail: 'Download failed', dlBusy: 'Still downloading — Esc cancels',
      dlCrawl: 'Loading the rest first…', dlProgress: (i, n) => `Downloading ${i} / ${n} (Esc cancels)`,
      dlCancelled: (ok) => `Cancelled, ${ok} downloaded`, dlDoneFail: (ok, f) => `Downloaded ${ok}, ${f} failed`,
      dlDone: (ok) => `Downloaded ${ok}`,
      copied: (i) => `Copied the URL of image ${i}`, copyFail: 'Copy failed', copiedAll: (n) => `Copied ${n} URLs`,
      imgFail: 'Image failed to load', noFull: 'Full screen is not available', helpHint: 'Press ? for shortcuts',
    },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function create(host) {
    const MODES = ['fit', 'width', 'actual'];
    const T = STR[host.lang] || STR.zh;
    const MODE_LABEL = T.modes;
    const GRID_STEPS = host.gridSteps;

    /* prefs 永遠等於宿主存的值；slideDelay / gridStep / shuffle 則是「這一輪」的值，
       可能被 [ ] 或 + - 調過。setPrefs 只動真的有變的那幾個，兩邊才不會互相蓋掉 */
    const prefs = { ...host.prefs };

    let ui = null;              // Shadow DOM 節點集合，第一次開啟才建立
    let items = [];             // 目前這輪收集到的 <img> 元素
    let index = 0;
    let rotation = 0;           // 目前這張的角度：0 / 90 / 180 / 270
    const rotations = new Map(); // src → 角度；只放記憶體，頁面一重新整理就歸零
    let scale = 1;
    let mode = 'fit';           // 在同一分頁內沿用上次選的模式
    let panX = 0;
    let panY = 0;
    let open = false;
    let gridHome = false;       // 這一輪是從總覽開始的：單圖的 ✕ / Esc 是回總覽，見 closeOrBack
    let toastTimer = 0;
    let playing = false;                     // 輪播中
    let slideTimer = 0;
    let slideDelay = prefs.slideDelay;       // 在同一分頁內沿用上次調整的間隔
    let shuffle = prefs.slideShuffle;        // 隨機輪播；跟 slideDelay 一樣是「這一輪」的值
    let bag = [];                            // 隨機輪播還沒抽到的 index
    let bagLen = 0;                          // 這袋建立時的 items.length，用來補續頁接上來的
    let idleTimer = 0;
    let overUI = false;                      // 滑鼠停在工具列 / 縮圖列上就別收
    let batch = null;                        // 批次下載進行中：{ cancel }
    let pager = null;                        // 續頁狀態，見「續頁」段
    let booting = false;                     // open 正在等設定 / CSS，連點不要開兩次
    let roundTitle = '';                     // 上方列的標題（也是下載資料夾）；單張帶 data-bv-title 的以單張為準
    const ratios = new Map();                // src → 寬/高；格狀總覽排版用，跟 rotations 一樣只放記憶體

    // 宿主改了偏好（設定頁存檔）。只能在 create 跑完之後呼叫，會碰到後面才宣告的狀態
    function setPrefs(p) {
      const hit = (k) => p[k] !== prefs[k];
      const dSlide = hit('slideDelay');
      const dShuffle = hit('slideShuffle');
      const dGrid = hit('gridCol');
      const dIdle = hit('idleHide');
      const dAll = hit('preloadAll');
      Object.assign(prefs, p);

      if (dSlide) {
        slideDelay = prefs.slideDelay;
        if (playing) scheduleSlide();        // 播放中就用新間隔重新計時（含進度條）
        if (open && ui) updateUI();          // 播放鍵的 tooltip 帶著秒數
      }
      if (dShuffle) {
        shuffle = prefs.slideShuffle;
        if (shuffle) refillBag();            // 換模式就重開一輪（沒播也先備好）
        if (open && ui) updateUI();
      }
      if (dGrid) setGridStep(host.stepIndex(prefs.gridCol));
      if (dIdle && open) poke();             // 舊的計時器是用舊的秒數排的，重排一次
      if (dAll && open) warmAll();           // 開著的這一輪馬上開始抓；關掉則是抓完手上這幾張就停
    }

    // viewer 裡用 [ ] 或 + - 調過的值寫回去，下次開自動沿用。
    // 自己改的先記上，宿主存檔的回音（setPrefs）才不會再套用一次
    function persist(patch) {
      Object.assign(prefs, patch);
      host.savePrefs?.(patch);
    }

    /* ── 圖片網址 ──────────────────────────────────────── */

    const badRewrite = new Set();   // 改寫後的網址載失敗過的原網址
    let rewriteOff = false;         // 連續失敗太多次就整場放棄改寫，別每張都白跑一次

    // 改寫後的網址；沒有對應規則、或這張已知改寫會失敗，就回 null
    function altSrc(src) {
      if (rewriteOff || badRewrite.has(src)) return null;
      for (const [re, to] of host.rewrite || []) {
        const alt = src.replace(re, to);
        if (alt !== src) return alt;
      }
      return null;
    }

    // 改寫後的網址載失敗就記一筆；連續幾張都不通就整場放棄改寫
    function markBadRewrite(src) {
      if (badRewrite.has(src)) return;
      badRewrite.add(src);
      if (badRewrite.size >= 3) rewriteOff = true;   // 這站的原始來源顯然不通
    }

    // 實際要載入 / 下載 / 複製的網址
    function viewSrc(el) {
      if (el.dataset.bvSharp) return el.dataset.bvSharp;   // 宿主換上的清楚版本（影片站分鏡）
      const src = srcOf(el);
      return altSrc(src) || src;
    }

    /* ── 壞圖救援 ────────────────────────────────────────
       縮圖列 / 總覽一律用頁面原本的網址（通常是縮過的小圖）。那個網址載不到時，重試同一個
       網址通常沒用，只能退回 rewrite 後的網址 —— 那多半是沒縮過的原尺寸，
       所以只救真的壞掉的那幾張，而且排隊一次一張，不要一個畫面幾十 MB 一起衝出去 */
    const FIX_GAP = 150;        // 每張之間喘一下
    const fixQueue = [];
    let fixing = false;

    function queueFix(img, src, done) {
      if (!altSrc(src)) return;      // 沒有改寫規則、或這張的原始來源已知不通
      fixQueue.push({ img, src, done });
      if (!fixing) runFixQueue();
    }

    async function runFixQueue() {
      fixing = true;
      while (fixQueue.length) {
        const { img, src, done } = fixQueue.shift();
        const alt = altSrc(src);
        if (!alt) continue;                 // 中途整場放棄改寫了，剩下的不用再試
        if (!img.isConnected) continue;     // viewer 重開過，這格已經不在畫面上了
        await loadAlt(img, src, alt, done);
        await sleep(FIX_GAP);
      }
      fixing = false;
    }

    // 把改寫後的網址載進原本那個 <img>：成功才 done()，失敗就記一筆讓後面的別再白跑
    function loadAlt(img, src, alt, done) {
      return new Promise((resolve) => {
        if (img.src === alt && img.complete) {     // onImgReady 早一步補好了
          if (img.naturalWidth) done(); else markBadRewrite(src);
          resolve();
          return;
        }
        const off = () => {
          clearTimeout(timer);
          img.removeEventListener('load', ok);
          img.removeEventListener('error', bad);
        };
        const ok = () => { off(); done(); resolve(); };
        const bad = () => { off(); markBadRewrite(src); resolve(); };
        // 沒有結果就不算數，但也不能讓佇列卡在這張上面
        const timer = setTimeout(() => { off(); resolve(); }, 15000);
        img.addEventListener('load', ok);
        img.addEventListener('error', bad);
        if (img.src !== alt) img.src = alt;       // 已經在載了就等它，別重設
      });
    }

    /* ── 續頁：把 source.more() 給的下一批接到 items 後面 ─────
       網頁分頁（宿主 fetch 下一頁挑圖）跟自己產生的清單（影片站的分鏡，一張大圖算一頁）
       在這裡都一樣：more() 回傳下一批，空的就是沒了，丟錯也算沒了 */

    function initPager(source) {
      pager = {
        pages: 1,
        more: source?.more || null,
        gap: source?.gap || 0,
        label: source?.label || null,
        seen: new Set(items.map(srcOf)),
        loading: null,
        crawl: null,
        done: !source?.more,
      };
    }

    // 抓下一批，回傳新增了幾張。同時被呼叫多次會共用同一個 promise
    function loadNextPage() {
      if (!pager || pager.done) return Promise.resolve(0);
      if (pager.loading) return pager.loading;

      const p = pager;
      p.loading = (async () => {
        let added = 0;
        try {
          const list = await p.more();
          // 等的期間換了一輪：這一批是上一輪的，不能塞進新的 items
          if (pager !== p) return 0;
          for (const img of list || []) {
            const src = srcOf(img);
            if (p.seen.has(src)) continue;   // 分頁重複或抓回同一頁就跳過
            p.seen.add(src);
            items.push(img);
            added++;
          }
          p.pages++;
          if (!list?.length) p.done = true;
        } catch {
          p.done = true;   // 抓不到就收手，退回原本「只有這一頁」的行為
        } finally {
          p.loading = null;
        }

        if (!added) {
          if (open && pager === p) updateUI();   // 收手了：計數器的「+」要拿掉
        } else {
          syncThumbs();
          syncGrid();
          warmAll();       // 整本預載：新接上來的也要抓
          updateUI();
        }
        return added;
      })();

      return p.loading;
    }

    // 開啟後在背景把剩下的一批一批接完，讓計數器 / 縮圖列 / 下載全部都看得到全部
    // 只跑一個迴圈；下載全部要等它跑完，所以把 promise 記在 pager 上共用
    function crawlRest() {
      const p = pager;
      if (!p) return Promise.resolve();
      if (p.crawl) return p.crawl;

      p.crawl = (async () => {
        while (pager === p && !p.done && (open || batch) && !batch?.cancel) {
          await loadNextPage();
          if (p.done) break;
          await sleep(p.gap);
        }
        // 沒接完就停下來（viewer 關掉了）的話清掉，下次再開能接著爬
        if (!p.done) p.crawl = null;
      })();

      return p.crawl;
    }

    /* ── UI 建立 ───────────────────────────────────────── */

    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

    async function buildUI() {
      const css = await host.css();

      const hostEl = document.createElement('div');
      hostEl.id = host.id || 'bv-viewer';   // 宿主可能拿這個 id 寫選擇器（例如藏廣告時排除它）
      hostEl.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
      const shadow = hostEl.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = css;
      shadow.appendChild(style);

      const extraTools = (host.tools || []).map((t) =>
        `<button class="bv-btn${t.cls ? ` ${esc(t.cls)}` : ''}" data-act="${esc(t.act)}" title="${esc(t.title || '')}">${esc(t.text)}</button>`).join('');
      // 宿主沒給下載就連複製網址一起拿掉：兩者在同一個下拉裡，只剩複製的 ▾ 單獨掛著很怪
      const dl = host.download ? '' : ' hidden';
      const helpRows = [...T.help, ...(host.download ? T.helpDl : []), T.helpFull, ...(host.help || []), ...T.helpEnd]
        .map(([k, d]) => `<dt>${esc(k)}</dt><dd>${esc(d)}</dd>`).join('');

      const overlay = document.createElement('div');
      overlay.className = 'bv-overlay';
      overlay.innerHTML = `
        <div class="bv-stage">
          <img class="bv-img" draggable="false" alt="">
          <div class="bv-layer"></div>
          <div class="bv-spinner" hidden></div>
          <button class="bv-nav bv-nav--prev" tabindex="-1" title="${T.prev} (←)" aria-label="${T.prev}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
          </button>
          <button class="bv-nav bv-nav--next" tabindex="-1" title="${T.next} (→)" aria-label="${T.next}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>
        <div class="bv-topbar">
          <span class="bv-counter">0 / 0</span>
          <span class="bv-title" hidden></span>
          <span class="bv-spacer"></span>
          <div class="bv-tools">
            <button class="bv-btn bv-btn--go" data-act="go" hidden></button>
            <button class="bv-btn bv-btn--mode" data-act="mode" title="${T.tMode}">${T.modes.fit}</button>
            <button class="bv-btn" data-act="zoomout" title="${T.tZoomOut}">−</button>
            <button class="bv-btn" data-act="zoomin"  title="${T.tZoomIn}">＋</button>
            <button class="bv-btn" data-act="rotate"  title="${T.tRotate}">⟲</button>
            <button class="bv-btn bv-btn--play" data-act="slideshow">▶</button>
            <button class="bv-btn" data-act="shuffle" title="${T.tShuffle}">⇄</button>
            <button class="bv-btn" data-act="thumbs"  title="${T.tThumbs}">▦</button>
            <button class="bv-btn" data-act="grid"    title="${T.tGrid}">⊞</button>
            ${extraTools}
            <button class="bv-btn" data-act="download" title="${T.tDownload}"${dl}>⭳</button>
            <button class="bv-btn bv-btn--caret" data-act="dlmenu" title="${T.tDlMenu}"${dl}>▾</button>
            <button class="bv-btn" data-act="full"    title="${T.tFull}">⛶</button>
            <button class="bv-btn" data-act="help"    title="${T.tHelp}">?</button>
            <button class="bv-btn bv-btn--close" data-act="close" title="${T.tClose}">✕</button>
          </div>
        </div>
        <div class="bv-menu" hidden>
          <button class="bv-mi" data-act="download"><span>${T.miDownload}</span><em>S</em></button>
          <button class="bv-mi" data-act="download-all"><span></span><em>Shift+S</em></button>
          <button class="bv-mi" data-act="download-rest"><span></span><em></em></button>
          <div class="bv-sep"></div>
          <button class="bv-mi" data-act="copy"><span>${T.miCopy}</span><em>C</em></button>
          <button class="bv-mi" data-act="copy-all"><span></span><em>Shift+C</em></button>
        </div>
        <div class="bv-grid" hidden>
          <div class="bv-grid-inner"></div>
          <section class="bv-next" hidden></section>
        </div>
        <div class="bv-progress" hidden><i></i></div>
        <div class="bv-thumbs" hidden></div>
        <div class="bv-toast"></div>
        <div class="bv-help" hidden>
          <h3>${T.helpTitle}</h3>
          <dl>${helpRows}</dl>
        </div>
      `;
      shadow.appendChild(overlay);

      ui = {
        host: hostEl,
        shadow,
        overlay,
        stage: shadow.querySelector('.bv-stage'),
        img: shadow.querySelector('.bv-img'),
        layer: shadow.querySelector('.bv-layer'),
        spinner: shadow.querySelector('.bv-spinner'),
        counter: shadow.querySelector('.bv-counter'),
        title: shadow.querySelector('.bv-title'),
        closeBtn: shadow.querySelector('[data-act="close"]'),
        tools: shadow.querySelector('.bv-tools'),
        goBtn: shadow.querySelector('[data-act="go"]'),
        modeBtn: shadow.querySelector('[data-act="mode"]'),
        playBtn: shadow.querySelector('[data-act="slideshow"]'),
        shuffleBtn: shadow.querySelector('[data-act="shuffle"]'),
        thumbsBtn: shadow.querySelector('[data-act="thumbs"]'),
        gridBtn: shadow.querySelector('[data-act="grid"]'),
        navPrev: shadow.querySelector('.bv-nav--prev'),
        navNext: shadow.querySelector('.bv-nav--next'),
        dlMenuBtn: shadow.querySelector('[data-act="dlmenu"]'),
        dlMenu: shadow.querySelector('.bv-menu'),
        dlAllLabel: shadow.querySelector('[data-act="download-all"] span'),
        dlRestLabel: shadow.querySelector('[data-act="download-rest"] span'),
        copyAllLabel: shadow.querySelector('[data-act="copy-all"] span'),
        progress: shadow.querySelector('.bv-progress'),
        progressBar: shadow.querySelector('.bv-progress > i'),
        thumbs: shadow.querySelector('.bv-thumbs'),
        grid: shadow.querySelector('.bv-grid'),
        gridInner: shadow.querySelector('.bv-grid-inner'),
        foot: shadow.querySelector('.bv-next'),
        toast: shadow.querySelector('.bv-toast'),
        help: shadow.querySelector('.bv-help'),
      };

      bindUI();
      return ui;
    }

    /* ── 幾何計算 ──────────────────────────────────────── */

    // 旋轉後圖片佔的「未縮放」尺寸
    function baseSize() {
      const nw = ui.img.naturalWidth || 1;
      const nh = ui.img.naturalHeight || 1;
      return rotation % 180 === 0 ? [nw, nh] : [nh, nw];
    }

    const stageRect = () => ui.stage.getBoundingClientRect();

    function computeScale(m) {
      const [w, h] = baseSize();
      const r = stageRect();
      if (!r.width || !r.height) return 1;
      if (m === 'width') return r.width / w;
      if (m === 'actual') return 1;
      return Math.min(r.width / w, r.height / h); // fit
    }

    function panLimits() {
      const [w, h] = baseSize();
      const r = stageRect();
      return [Math.max(0, (w * scale - r.width) / 2), Math.max(0, (h * scale - r.height) / 2)];
    }

    function clampPan() {
      const [mx, my] = panLimits();
      panX = Math.min(mx, Math.max(-mx, panX));
      panY = Math.min(my, Math.max(-my, panY));
    }

    function applyTransform() {
      const t = `translate(-50%,-50%) translate(${panX}px, ${panY}px) scale(${scale}) rotate(${rotation}deg)`;
      ui.img.style.transform = t;
      // 宿主的那一層跟圖疊在一起：同樣的原尺寸、同樣的變形
      ui.layer.style.width = `${ui.img.naturalWidth}px`;
      ui.layer.style.height = `${ui.img.naturalHeight}px`;
      ui.layer.style.transform = t;
    }

    function setMode(m) {
      mode = m;
      scale = computeScale(m);
      panX = 0;
      panY = 0;
      if (m === 'width') {
        // 符合寬度時對齊到圖片頂端，方便由上往下讀
        panY = panLimits()[1];
      }
      clampPan();
      applyTransform();
      updateUI();
    }

    function zoomBy(factor, cx = 0, cy = 0) {
      const next = Math.min(16, Math.max(0.05, scale * factor));
      if (next === scale) return;
      // 讓 (cx, cy)（相對舞台中心）這個點在縮放後停在原位
      panX = cx - ((cx - panX) * next) / scale;
      panY = cy - ((cy - panY) * next) / scale;
      scale = next;
      mode = 'free';
      clampPan();
      applyTransform();
      updateUI();
    }

    /* ── 換頁 ──────────────────────────────────────────── */

    function goTo(i) {
      if (!items.length) return;
      if (items[index] !== items[Math.min(items.length - 1, Math.max(0, i))]) imageLeave();   // 換張了，上一張的收掉
      index = Math.min(items.length - 1, Math.max(0, i));

      rotation = rotations.get(srcOf(items[index])) || 0;   // 回到轉過的圖，角度接回去

      const url = viewSrc(items[index]);
      if (ui.img.src !== url) {
        ui.spinner.hidden = false;
        ui.img.src = url;
      }
      if (ui.img.complete && ui.img.naturalWidth) onImgReady();

      updateUI();
      preload();
      host.onShow?.(items[index]);
    }

    /* ── 失效的圖：載得進來，但不是真的那張 ─────────────────
       有些來源對已經不存在的檔會回一張極小的佔位圖，主圖、格子、縮圖都「載入成功」，
       放大成一整格糊掉的方塊。它跟 icon 一樣小，用 minSize 認；認出來就從這一輪整個拿掉 */
    const minSize = host.minSize || 0;
    const isDead = (img) => img.naturalWidth > 0
      && img.naturalWidth < minSize && img.naturalHeight < minSize;

    // 依 srcOf 找（偵測是非同步的，那時 index 可能已經變了），拿掉後把後面的編號全部往前補
    function dropItem(src) {
      const i = items.findIndex((el) => srcOf(el) === src);
      if (i < 0) return;
      items.splice(i, 1);
      for (const list of [ui.gridInner, ui.thumbs]) {
        const node = list.children[i];   // 格子 / 縮圖是照 items 順序建的，第 i 個就是它（還沒建到就沒有）
        if (!node) continue;
        node.remove();
        for (let k = i; k < list.children.length; k++) {
          list.children[k].dataset.i = String(k);
          if (list === ui.gridInner) list.children[k].dataset.n = String(k + 1);
        }
      }
      bag = bag.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));
      if (i < bagLen) bagLen--;
      toast(T.dead);
      if (!items.length) { closeViewer(); return; }
      if (index > i) index--;
      if (index === i || index >= items.length) goTo(Math.min(i, items.length - 1));   // 正在看的就是它：換成下一張
      else updateUI();
    }

    function onImgReady() {
      ui.spinner.hidden = true;
      if (isDead(ui.img)) { dropItem(srcOf(items[index])); return; }

      const t = ui.thumbs.children[index];
      if (t && t.dataset.failed === '1' && t.src !== ui.img.src) {
        t.src = ui.img.src;              // 主圖剛載好，這個網址已經在快取裡
        delete t.dataset.failed;
      }

      const g = ui.gridInner.children[index];
      const gi = g && g.firstElementChild;
      if (g && g.dataset.failed === '1' && gi && gi.src !== ui.img.src) {
        gi.src = ui.img.src;             // 同上，這個網址已經在快取裡，補起來不用錢
        delete g.dataset.failed;
      }

      setMode(mode === 'free' ? 'fit' : mode);
      scheduleSlide();
      imageCheck();      // 換張後滑鼠沒動也算停在新的這張上
    }

    async function next() {
      if (index < items.length - 1) return goTo(index + 1);
      if (!pager || pager.done) { endOfAlbum(); return; }

      const at = index;
      toast(T.loadingNext, 0);
      const added = await loadNextPage();
      if (!added) { endOfAlbum(); return; }
      toast(pager.label ? pager.label(added, pager.pages) : T.added(added));
      if (index === at) goTo(at + 1);   // 期間使用者自己動過就別搶
    }

    const prev = () => index > 0 ? goTo(index - 1) : toast(T.first);

    // 翻過最後一張：總覽底下有宿主放的東西（推薦）就帶去那裡，沒有就照舊提示
    function endOfAlbum() {
      if (ui.foot.hidden) { toast(T.last); return; }
      openGrid();
      ui.foot.scrollIntoView({ block: 'start' });
      toast(T.endPick);
    }

    function preload() {
      if (prefs.preloadAll) { warmAll(); return; }   // 整本都要抓，前後幾張自然排最前面
      for (let d = 1; d <= prefs.preload; d++) {
        for (const i of [index + d, index - d]) {
          if (items[i]) new Image().src = viewSrc(items[i]);
        }
      }
    }

    /* ── 整本預載（prefs.preloadAll）─────────────────────
       把這一輪每一張的原圖（viewSrc）都抓進快取，翻到哪張都不用等。每次空出名額就挑
       離 index 最近、還沒抓過的那張，所以 goTo 換了位置會跟著改抓新位置附近；續頁接上來的
       由 loadNextPage 叫 warmAll 補進來。同時 WARM_PARALLEL 張：全部一起發的話，
       正在看的那張反而排在幾十張後面 */
    const WARM_PARALLEL = 3;
    const WARM_TIMEOUT = 20000;   // 卡住的那張不要一直佔著名額
    const warmed = new Set();     // 已經開始抓（或抓完）的原圖網址；跨輪保留，快取裡本來就有了
    let warmRound = 0;            // beginRound / closeViewer 遞增，上一輪的回呼就不再補位
    let warmers = 0;

    function warmAll() {
      if (!open || !prefs.preloadAll) return;
      while (warmers < WARM_PARALLEL && warmOne(warmRound));
    }

    // 開始抓一張；沒有可抓的就回 false
    function warmOne(round) {
      let pick = -1;
      for (let d = 0; d < items.length && pick < 0; d++) {
        for (const i of [index + d, index - d]) {
          if (items[i] && !warmed.has(viewSrc(items[i]))) { pick = i; break; }
        }
      }
      if (pick < 0) return false;
      const src = srcOf(items[pick]);
      const url = viewSrc(items[pick]);
      warmed.add(url);
      warmers++;
      const im = new Image();
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (round !== warmRound) return;   // 換本 / 關掉了，名額已經歸零重算
        warmers--;
        warmAll();
      };
      const timer = setTimeout(done, WARM_TIMEOUT);
      im.onload = () => {
        if (round === warmRound && isDead(im)) dropItem(src);   // 失效圖不用等翻到才發現
        done();
      };
      // rewrite 後的網址不通就跟主圖一樣記一筆；viewSrc 之後會給原本的網址，下一輪掃到再抓那個
      im.onerror = () => { if (url !== src) markBadRewrite(src); done(); };
      im.src = url;
      return true;
    }

    function stopWarm() {
      warmRound++;
      warmers = 0;
    }

    /* ── 輪播 ──────────────────────────────────────────── */

    // 計時從「圖片畫出來」才開始，載入慢的圖不會被跳過（見 onImgReady）
    function scheduleSlide() {
      clearTimeout(slideTimer);
      if (!playing || !open) return;
      slideTimer = setTimeout(slideStep, slideDelay);
      runProgress();
    }

    async function slideStep() {
      if (!playing || !open) return;
      if (shuffle) { await shuffleStep(); return; }
      if (index < items.length - 1) { goTo(index + 1); return; }
      if (pager && !pager.done && (await loadNextPage())) {
        if (playing && open) goTo(index + 1);
        return;
      }
      if (prefs.slideLoop) goTo(0);
      else stopSlideshow(T.slideEnd);
    }

    /* 隨機輪播用「抽牌袋」而不是每次 Math.random()：純亂數會一直重播同幾張、
       又漏掉另外幾張。袋子裡是還沒放過的 index，抽完一輪才重新洗。
       續頁是邊播邊接的，所以每次抽之前先把新接上來的那幾張補進這一輪 */
    function refillBag() {
      bag = [];
      bagLen = items.length;
      for (let i = 0; i < items.length; i++) if (i !== index) bag.push(i);   // 不要馬上重播現在這張
    }

    function growBag() {
      for (; bagLen < items.length; bagLen++) bag.push(bagLen);
    }

    // 抽一張沒放過的；袋子空了回 -1
    function drawFromBag() {
      growBag();
      if (!bag.length) return -1;
      const at = Math.floor(Math.random() * bag.length);
      const i = bag[at];
      bag[at] = bag[bag.length - 1];   // swap-pop，不用 splice 搬整條
      bag.pop();
      return i;
    }

    // 袋子空了才去接下一頁（順序輪播是翻到最後一張才接，時機一樣）
    async function shuffleStep() {
      let i = drawFromBag();
      if (i < 0 && pager && !pager.done && (await loadNextPage())) {
        if (!playing || !open) return;
        i = drawFromBag();
      }
      if (i < 0) {
        if (!prefs.slideLoop) { stopSlideshow(T.slideEnd); return; }
        refillBag();
        i = drawFromBag();
        if (i < 0) { scheduleSlide(); return; }   // 整本只有一張，原地等下一拍
      }
      goTo(i);
    }

    function startSlideshow() {
      if (playing) return;
      closeGrid();     // 輪播是單圖的事，從總覽按下去就先進單圖再播
      playing = true;
      if (shuffle) refillBag();      // 每次重新播就是新的一輪
      toast(T.slideStart(shuffle, (slideDelay / 1000).toFixed(1)));
      scheduleSlide();
      updateUI();
    }

    function toggleShuffle() {
      shuffle = !shuffle;
      if (shuffle) refillBag();
      toast(shuffle ? T.shuffleOn : T.shuffleOff);
      updateUI();
      persist({ slideShuffle: shuffle });   // 下次開沿用
    }

    function stopSlideshow(msg = T.slidePause) {
      if (!playing) return;
      playing = false;
      clearTimeout(slideTimer);
      slideTimer = 0;
      stopProgress();
      toast(msg);
      updateUI();
    }

    const toggleSlideshow = () => (playing ? stopSlideshow() : startSlideshow());

    function bumpSlideDelay(ms) {
      slideDelay = Math.min(30000, Math.max(500, slideDelay + ms));
      toast(T.interval((slideDelay / 1000).toFixed(1)));
      if (playing) scheduleSlide(); // 重新計時，馬上套用新間隔
      updateUI();
      persist({ slideDelay });      // 下次開沿用
    }

    // 進度條：animation 是靠重新指派 + reflow 重播的
    function runProgress() {
      const bar = ui.progressBar;
      ui.progress.hidden = false;
      bar.style.animation = 'none';
      void bar.offsetWidth;
      bar.style.animation = `bv-progress ${slideDelay}ms linear forwards`;
    }

    function stopProgress() {
      ui.progressBar.style.animation = 'none';
      ui.progress.hidden = true;
    }

    /* ── 閒置隱藏 ──────────────────────────────────────── */

    // 有動作就叫一次：先把 UI 叫回來，再重新算閒置時間
    function poke() {
      if (!open) return;
      ui.overlay.dataset.idle = '0';
      clearTimeout(idleTimer);
      idleTimer = prefs.idleHide ? setTimeout(hideUI, prefs.idleHide) : 0;
    }

    function hideUI(force = false) {
      clearTimeout(idleTimer);
      idleTimer = 0;
      if (!open) return;
      if (!ui.grid.hidden) return;           // 總覽是用捲的，工具列收掉就回不去單圖了
      if (!force && overUI) {                // 停在工具列上就晚點再問
        idleTimer = setTimeout(hideUI, prefs.idleHide);
        return;
      }
      ui.overlay.dataset.idle = '1';
      closeMenu();               // 工具列都收了，下拉不該還浮在畫面上
    }

    const onBlur = () => hideUI(true);       // 視窗失焦（切分頁 / 切程式）直接收

    /* ── UI 更新 ───────────────────────────────────────── */

    function updateUI() {
      const more = pager && !pager.done ? '+' : '';   // 後面還有分頁沒接完
      const cur = items[index];
      // 每一張可以有自己的說明（影片站：分鏡是時間點，封面牆是那部影片的片長）
      const cap = cur?.dataset.bvCap;
      ui.counter.textContent = `${index + 1} / ${items.length}${more}${cap ? ` · ${cap}` : ''}`;
      const title = cur?.dataset.bvTitle || roundTitle;
      if (ui.title.textContent !== title) {
        ui.title.textContent = ui.title.title = title;
        ui.title.hidden = !title;
      }
      const go = cur && host.itemAction?.(cur);
      ui.goBtn.hidden = !go;
      if (go) { ui.goBtn.textContent = go.label; ui.goBtn.title = `${go.label} (Enter)`; }
      ui.modeBtn.textContent =
        mode === 'free' ? `${Math.round(scale * 100)}%` : MODE_LABEL[mode];
      ui.playBtn.textContent = playing ? '⏸' : '▶';
      // 到頭了不拿掉按鈕、只讓它隱形不作用：連點箭頭時第二下才不會掉到舞台上變成 dblclick 切縮放
      ui.navPrev.dataset.off = index <= 0 ? '1' : '0';
      ui.navNext.dataset.off = index >= items.length - 1 && (!pager || pager.done) ? '1' : '0';   // 還有續頁沒接就還能往後
      ui.playBtn.dataset.on = playing ? '1' : '0';
      ui.playBtn.title = T.tPlay((slideDelay / 1000).toFixed(1));
      ui.shuffleBtn.dataset.on = shuffle ? '1' : '0';
      ui.dlAllLabel.textContent = T.miAll(items.length);
      ui.dlRestLabel.textContent = T.miRest(items.length - index);
      ui.copyAllLabel.textContent = T.miCopyAll(items.length);

      const thumbs = ui.thumbs.children;
      for (let i = 0; i < thumbs.length; i++) {
        const on = i === index;
        thumbs[i].dataset.active = on ? '1' : '0';
        if (on && !ui.thumbs.hidden) {
          thumbs[i].scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
        }
      }

      // 總覽只標記、不自己捲；不然輪播時整個總覽會一直跳
      if (!ui.grid.hidden) {
        const tiles = ui.gridInner.children;
        for (let i = 0; i < tiles.length; i++) tiles[i].dataset.active = i === index ? '1' : '0';
      }

      host.onUpdate?.();
    }

    /* ── 縮圖 / 格子的預載 ─────────────────────
       原生 loading="lazy" 的提前量是拿視窗算的，而縮圖列跟總覽各自是一層 overflow
       容器：被它裁掉的那些算「不相交」，提前量不會跨過這層套用，等於沒有提前量 ——
       真的捲進來才開始載，所以捲起來永遠是一張一張冒出來。改成自己管：root 就設成
       那個捲動容器，rootMargin 才算得到，提前幾個畫面先發 request。還是只載看得到的
       附近，不是整份清單一次衝出去（一輪可能好幾十張，來源也可能限流） */
    const LAZY_AHEAD = 1500;   // px，大約兩個畫面

    // 被盯的元素可以是 <img> 本身（縮圖列），也可以是包著它的格子（總覽）
    function makeLazyIO(root, rootMargin) {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);           // 載過就不用再盯了
          loadLazy(e.target);
        }
      }, { root, rootMargin });
      return io;
    }

    // src 到這一刻才設；load / error 在建節點時就掛好了
    function loadLazy(el) {
      const img = el.tagName === 'IMG' ? el : el.querySelector('img');
      if (img && !img.src) img.src = img.dataset.src;
    }

    let thumbIO = null;
    let gridIO = null;

    // prefs.preloadAll 時不等捲到附近，建好就直接載
    function watchLazy(io, node) {
      if (prefs.preloadAll) loadLazy(node);
      else io().observe(node);
    }
    const thumbLazy = () => (thumbIO ||= makeLazyIO(ui.thumbs, `0px ${LAZY_AHEAD}px`));   // 橫向
    const gridLazy = () => (gridIO ||= makeLazyIO(ui.grid, `${LAZY_AHEAD}px 0px`));       // 縱向

    // 縮圖列沒打開就先不要建，不然一開 viewer 就會為整份清單（含續頁）發 request
    function syncThumbs() {
      if (ui.thumbs.hidden) return;
      if (ui.thumbs.children.length < items.length) addThumbs(ui.thumbs.children.length);
    }

    // 只補新的，重建會把縮圖列的捲動位置弄掉
    function addThumbs(from) {
      for (let i = from; i < items.length; i++) {
        const src = srcOf(items[i]);

        const t = document.createElement('img');
        t.className = 'bv-thumb';
        // 縮圖用頁面原本的網址（通常比較小、而且頁面已經載過）；
        // 什麼時候真的發 request 交給 thumbLazy（見上面）
        t.dataset.src = src;
        t.dataset.i = String(i);
        t.draggable = false;
        if (items[i].dataset.bvTitle) t.title = items[i].dataset.bvTitle;
        // 壞了先做記號，再排進救援佇列退回原始來源（見「壞圖救援」）
        t.addEventListener('error', () => {
          t.dataset.failed = '1';
          queueFix(t, src, () => { delete t.dataset.failed; });
        }, { once: true });
        t.addEventListener('load', () => { if (isDead(t) && t.isConnected) dropItem(src); });
        ui.thumbs.appendChild(t);
        watchLazy(thumbLazy, t);
      }
    }

    /* ── 格狀總覽 ──────────────────────────────────────── */

    const GRID_ROW = 8;      // grid-auto-rows 的列高，要跟 viewer.css 一致
    const GRID_GAP = 8;      // 同上，gap
    const GRID_RATIO = 0.72; // 量不到比例時先給個直式預設，等縮圖載好再校正

    // 欄寬的檔位表跟「最接近哪一檔」由宿主給（設定頁要用同一份）。
    // 跟 mode / slideDelay 一樣，在同一分頁內沿用調過的大小
    let gridStep = host.stepIndex(prefs.gridCol);

    // 排版要知道長寬比。頁面上的圖量得到；續頁是 DOMParser 產物、沒有 layout，
    // 退回 width / height 屬性，兩個都沒有就先用預設值佔位
    function ratioOf(el) {
      const src = srcOf(el);
      const hit = ratios.get(src);
      if (hit) return hit;
      const w = el.naturalWidth || Number(el.getAttribute('width')) || 0;
      const h = el.naturalHeight || Number(el.getAttribute('height')) || 0;
      if (w && h) {
        ratios.set(src, w / h);
        return w / h;
      }
      return GRID_RATIO;
    }

    // 欄寬每一格都一樣（1fr），量第一格就夠，不用每格都去問一次 layout
    function gridColWidth() {
      const first = ui.gridInner.firstElementChild;
      return first ? first.getBoundingClientRect().width : 0;
    }

    // 瀑布流靠 grid-auto-rows 的細列 + row span 疊出高度。
    // 不用 CSS 多欄：那是填滿一欄才換欄，第 1、2、3 張會變成直排，順序就亂了
    function layoutTile(tile, colW) {
      if (!colW) return;                     // 總覽關著的時候量不到，等 relayoutGrid 再說
      const r = Number(tile.dataset.ratio) || GRID_RATIO;
      const rows = Math.max(1, Math.round((colW / r + GRID_GAP) / (GRID_ROW + GRID_GAP)));
      tile.style.gridRowEnd = `span ${rows}`;
    }

    function relayoutGrid() {
      if (!ui || ui.grid.hidden) return;
      const colW = gridColWidth();
      for (const tile of ui.gridInner.children) layoutTile(tile, colW);
    }

    // 欄寬只有這一個旋鈕：viewer.css 的 minmax(var(--bv-col), 1fr)，
    // auto-fill 會自己依視窗寬度決定欄數，所以視窗變窄不用另外處理
    function applyGridCol() {
      ui.gridInner.style.setProperty('--bv-col', `${GRID_STEPS[gridStep]}px`);
    }

    // 畫面最上面那一格，改完欄寬要靠它把捲動位置接回去
    function topTile() {
      const top = ui.grid.getBoundingClientRect().top;
      for (const tile of ui.gridInner.children) {
        if (tile.getBoundingClientRect().bottom > top) return tile;
      }
      return null;
    }

    // dir = +1 放大 / -1 縮小
    function resizeGrid(dir) {
      const step = Math.min(GRID_STEPS.length - 1, Math.max(0, gridStep + dir));
      if (step === gridStep) {
        toast(dir > 0 ? T.gridMax : T.gridMin);
        return;
      }
      setGridStep(step);
      toast(T.gridSize(GRID_STEPS[gridStep]));
      persist({ gridCol: GRID_STEPS[gridStep] });   // 下次開沿用
    }

    // 設定頁改欄寬也走這裡（沒有 toast）。總覽關著的話就只記著，openGrid 會 applyGridCol
    function setGridStep(step) {
      gridStep = step;
      if (!ui || ui.grid.hidden) return;

      // 欄寬一變總高就跟著變，捲動位置會整個跳掉；抓個錨點改完再捲回同一個地方
      const anchor = topTile();
      const before = anchor ? anchor.getBoundingClientRect().top : 0;

      applyGridCol();
      relayoutGrid();            // 欄寬換了，所有 row span 都要重算

      if (anchor) ui.grid.scrollTop += anchor.getBoundingClientRect().top - before;
    }

    // 跟縮圖列同一個道理：總覽沒打開就一格都不要建，不然一開 viewer 就為整份清單發 request
    function syncGrid() {
      if (ui.grid.hidden) return;
      if (ui.gridInner.children.length < items.length) addTiles(ui.gridInner.children.length);
    }

    // 只補新的，重建會把總覽的捲動位置弄掉
    function addTiles(from) {
      for (let i = from; i < items.length; i++) {
        const src = srcOf(items[i]);

        const tile = document.createElement('div');
        tile.className = 'bv-gtile';
        tile.dataset.i = String(i);
        tile.dataset.n = String(i + 1);      // 壞圖時 CSS 拿它當編號顯示
        tile.dataset.ratio = String(ratioOf(items[i]));
        if (items[i].dataset.bvCap) tile.dataset.cap = items[i].dataset.bvCap;   // 每張自己的說明（例如時間點、片長）

        const img = document.createElement('img');
        img.className = 'bv-gimg';
        img.draggable = false;
        // 一律用頁面原本的網址。viewSrc 可能是沒縮過的原尺寸，一個畫面就好幾十 MB。
        // 什麼時候真的發 request 交給 gridLazy（見上面），這裡只先記起來
        img.dataset.src = src;
        img.addEventListener('load', () => {
          if (!img.naturalWidth || !img.naturalHeight) return;
          if (isDead(img)) { if (img.isConnected) dropItem(src); return; }   // 已經被清掉的上一輪格子不算
          const r = img.naturalWidth / img.naturalHeight;
          ratios.set(src, r);
          tile.dataset.ratio = String(r);
          layoutTile(tile, gridColWidth());  // 真實比例出來了，把這格的高度校正回去
        });
        // 壞了先做記號，再排進救援佇列退回原始來源（見「壞圖救援」）
        img.addEventListener('error', () => {
          tile.dataset.failed = '1';
          queueFix(img, src, () => { delete tile.dataset.failed; });
        }, { once: true });

        tile.appendChild(img);   // 一定要是第一個子節點：onImgReady 靠 firstElementChild 找它
        // 每張自己的標題（例如封面牆的片名）畫在格子底部，滑鼠停著也看得到全文
        const title = items[i].dataset.bvTitle;
        if (title) {
          const cap = document.createElement('span');
          cap.className = 'bv-gtitle';
          const win = document.createElement('span');    // 兩行高的窗
          win.className = 'bv-gtitle-win';
          const text = document.createElement('span');   // 跑馬燈動的是裡面這層
          text.textContent = title;
          win.appendChild(text);
          cap.appendChild(win);
          tile.appendChild(cap);
          tile.title = title;
        }
        ui.gridInner.appendChild(tile);
        watchLazy(gridLazy, tile);
      }
      relayoutGrid();
    }

    /* ── 滑鼠停在總覽的某一格 ─────────────────────────────
       標題兩行放不下就上下來回捲（跑馬燈），宿主的 tileHover 可以在格子裡放東西（例如預覽影片）。
       同時只有一格；滑鼠離開、總覽關掉（resetGrid）都會收掉 */
    let hoverTile = null;
    let hoverStop = null;
    const reduced = () => (host.reduced ? host.reduced() : matchMedia('(prefers-reduced-motion: reduce)').matches);

    function tileEnter(tile) {
      if (tile === hoverTile) return;
      tileLeave();
      hoverTile = tile;
      const box = tile.querySelector('.bv-gtitle');
      const win = box?.firstElementChild;
      if (win && !reduced()) {
        // 截成兩行時量到的是截過的高度，先放開（data-mq）量全文，放得下再收回去
        box.dataset.mq = '';
        const over = win.firstElementChild.offsetHeight - win.clientHeight;
        if (over > 2) {
          box.style.setProperty('--bv-mq-y', `${-over}px`);
          box.style.setProperty('--bv-mq-t', `${Math.max(3, over / 16 + 2).toFixed(1)}s`);   // 約一秒一行，兩頭各停一下
        } else {
          delete box.dataset.mq;
        }
      }
      const item = items[Number(tile.dataset.i)];
      try { hoverStop = (item && host.tileHover?.(item, tile)) || null; } catch { hoverStop = null; }
    }

    function tileLeave() {
      if (!hoverTile) return;
      const box = hoverTile.querySelector('.bv-gtitle');
      if (box) delete box.dataset.mq;
      try { hoverStop?.(); } catch { /* 宿主收不乾淨也不影響 viewer */ }
      hoverTile = null;
      hoverStop = null;
    }

    /* ── 單張時滑鼠停在圖上 ─────────────────────────────
       宿主的 imageHover 可以在疊在圖上的那一層（.bv-layer）放東西（例如預覽影片）。
       「在圖上」是指標落在圖實際畫出來的範圍裡（縮放 / 平移後的），不是整個舞台 */
    let imageItem = null;
    let imageStop = null;
    let pointer = null;        // 最後一次在舞台上的指標位置；換張後用它判斷是不是還停在圖上

    function imageCheck() {
      if (!host.imageHover || !open || !ui.grid.hidden || !pointer || !ui.img.naturalWidth) { imageLeave(); return; }
      const r = ui.img.getBoundingClientRect();
      const inside = pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
      if (!inside) { imageLeave(); return; }
      const item = items[index];
      if (item === imageItem) return;
      imageLeave();
      imageItem = item;
      try { imageStop = host.imageHover(item, ui.layer) || null; } catch { imageStop = null; }
    }

    function imageLeave() {
      if (!imageItem) return;
      try { imageStop?.(); } catch { /* 宿主收不乾淨也不影響 viewer */ }
      ui.layer.textContent = '';
      imageItem = null;
      imageStop = null;
    }

    // ms = 0：一直留著（批次下載進度用），等下一個 toast 蓋掉
    function toast(msg, ms = 1400) {
      if (!ui) return;
      ui.toast.textContent = msg;
      ui.toast.dataset.show = '1';
      clearTimeout(toastTimer);
      toastTimer = ms ? setTimeout(() => { ui.toast.dataset.show = '0'; }, ms) : 0;
    }

    /* ── 下載 ──────────────────────────────────────────── */

    // 20260802-143012-345：到毫秒，所以同一批不會撞名
    function stamp() {
      const d = new Date();
      const p = (n, w = 2) => String(n).padStart(w, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
        + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
        + `-${p(d.getMilliseconds(), 3)}`;
    }

    // 檔名用下載時間而不是清單位置：同一站的第 2、3 頁常常同名，
    // 資料夾名（這一輪的標題）一樣時用 index 會蓋到前一頁的檔案
    function fileNameFor(i) {
      const url = viewSrc(items[i]);
      const ext = (url.split('?')[0].match(/\.(jpe?g|png|gif|webp|avif|bmp)$/i) || [, 'jpg'])[1];
      const base = (roundTitle || document.title || 'image')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || 'image';
      return `${base}/${stamp()}.${ext}`;
    }

    async function downloadOne(i) {
      if (!host.download) return false;
      try { return !!(await host.download(viewSrc(items[i]), fileNameFor(i))); } catch { return false; }
    }

    async function download() {
      const i = index;
      toast(await downloadOne(i) ? T.downloaded(i + 1, items.length) : T.dlFail);
    }

    // 從第 from 張一路下載到最後；一張一張排隊，Esc 可中斷
    async function downloadAll(from = 0) {
      if (batch) { toast(T.dlBusy); return; }
      if (items.length - from <= 0) return;

      batch = { cancel: false };
      // 只下載到「目前接到的那一頁」很容易漏，先把剩下的分頁補完
      if (pager && !pager.done) {
        toast(T.dlCrawl, 0);
        await crawlRest();
      }

      let ok = 0;
      let fail = 0;

      for (let i = from; i < items.length; i++) {
        if (batch.cancel) break;
        toast(T.dlProgress(i - from + 1, items.length - from), 0);
        (await downloadOne(i)) ? ok++ : fail++;
        await sleep(120);   // 一次一張，別把下載那一端塞爆
      }

      const cancelled = batch.cancel;
      batch = null;
      toast(cancelled ? T.dlCancelled(ok) : fail ? T.dlDoneFail(ok, fail) : T.dlDone(ok));
    }

    /* ── 複製網址 ──────────────────────────────────────── */

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // clipboard API 被擋（非 https / 視窗沒 focus）就退回舊招
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        ta.remove();
        return ok;
      }
    }

    async function copyUrl() {
      const ok = await copyText(viewSrc(items[index]));
      toast(ok ? T.copied(index + 1) : T.copyFail);
    }

    async function copyAllUrls() {
      const text = items.map(viewSrc).join('\n');   // 一行一個，好餵給外部下載器
      const ok = await copyText(text);
      toast(ok ? T.copiedAll(items.length) : T.copyFail);
    }

    /* ── 事件綁定 ──────────────────────────────────────── */

    function bindUI() {
      ui.img.addEventListener('load', onImgReady);
      ui.img.addEventListener('error', () => {
        // 改寫後的網址掛了就退回頁面原本那個，並記下來，之後不再改寫這張
        const src = items[index] && srcOf(items[index]);
        if (src && ui.img.src !== src && !badRewrite.has(src)) {
          markBadRewrite(src);
          ui.img.src = src;
          return;                        // spinner 留著，等這次結果
        }
        ui.spinner.hidden = true;
        toast(T.imgFail);
        scheduleSlide(); // 壞圖不該讓輪播卡住
      });

      ui.tools.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        e.stopPropagation();
        doAction(btn.dataset.act);
      });

      ui.thumbs.addEventListener('click', (e) => {
        if (thumbDragged) { thumbDragged = false; return; }   // 剛剛是拖曳，不要當成點選
        const t = e.target.closest('.bv-thumb');
        if (t) goTo(Number(t.dataset.i));
      });

      /* 縮圖列：按住左鍵左右拖曳捲動 */
      let thumbDrag = null;      // 只在按著的時候存在
      let thumbDragged = false;  // 這次放開之後那個 click 要不要吃掉
      ui.thumbs.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        thumbDrag = { id: e.pointerId, x: e.clientX, left: ui.thumbs.scrollLeft, moved: false };
        thumbDragged = false;
      });
      ui.thumbs.addEventListener('pointermove', (e) => {
        if (!thumbDrag || e.pointerId !== thumbDrag.id) return;
        const dx = e.clientX - thumbDrag.x;
        // 超過門檻才算拖曳，否則單純點一下也會被吃掉
        if (!thumbDrag.moved && Math.abs(dx) < 4) return;
        if (!thumbDrag.moved) {
          thumbDrag.moved = true;
          ui.thumbs.dataset.dragging = '1';
          // 捕捉之後 click 會派送到縮圖列本身，順便讓上面那個判斷不會誤觸縮圖
          ui.thumbs.setPointerCapture(e.pointerId);
        }
        ui.thumbs.scrollLeft = thumbDrag.left - dx;
        poke();
      });
      const endThumbDrag = (e) => {
        if (!thumbDrag || e.pointerId !== thumbDrag.id) return;
        if (ui.thumbs.hasPointerCapture(e.pointerId)) ui.thumbs.releasePointerCapture(e.pointerId);
        delete ui.thumbs.dataset.dragging;
        // click 在 pointerup 之後才來，用另一個旗標傳給它，thumbDrag 本身一定要清掉
        thumbDragged = thumbDrag.moved;
        thumbDrag = null;
      };
      ui.thumbs.addEventListener('pointerup', endThumbDrag);
      ui.thumbs.addEventListener('pointercancel', endThumbDrag);

      // 總覽底下的宿主區塊（推薦卡）由宿主自己掛 listener，這裡只管格子
      ui.gridInner.addEventListener('pointerover', (e) => {
        const tile = e.target.closest('.bv-gtile');
        if (tile) tileEnter(tile);
      });
      ui.gridInner.addEventListener('pointerout', (e) => {
        if (hoverTile && !hoverTile.contains(e.relatedTarget)) tileLeave();
      });

      ui.grid.addEventListener('click', (e) => {
        const tile = e.target.closest('.bv-gtile');
        if (!tile) return;
        goTo(Number(tile.dataset.i));
        closeGrid();                 // 點了就進單圖，再按 G 可以退回總覽
      });
      ui.grid.addEventListener('scroll', poke, { passive: true });
      // 跟舞台一樣不讓右鍵冒到頁面上，網站若擋右鍵，宿主放在底下的連結才叫得出右鍵選單
      ui.grid.addEventListener('contextmenu', (e) => e.stopPropagation());

      /* 正在看總覽底下的宿主區塊（推薦）時，上面的格子還在長（續頁一頁一頁接上來、縮圖載好校正高度），
         那一區會被一路往下推，一頁就兩千多 px，滑鼠瞄好的那張一點下去已經不在那裡了。
         瀏覽器的 scroll anchoring 在這裡沒有作用（量過 scrollTop 一動不動），所以自己補：
         格子區長高多少，捲動位置就跟著往下多少。只在畫面已經看到格子區底下時才補，
         還在看圖的人不受影響。ResizeObserver 在 layout 之後、paint 之前回呼，看不到跳動 */
      // 「在看那一區」= 捲下來過、而且格子區的底已經在畫面上半部。光看「畫面碰得到格子區底下」不夠：
      // 剛開的時候格子還很短、那一區本來就在畫面裡，那樣判斷會被一路補到最底下。
      // 第一次量（innerH 還是 0）和換一輪清空重長也都不補
      let innerH = 0;
      new ResizeObserver(() => {
        const h = ui.gridInner.offsetHeight;
        const prev = innerH;
        innerH = h;
        const d = h - prev;
        if (!prev || !h || !d || ui.grid.hidden || ui.foot.hidden) return;
        const st = ui.grid.scrollTop;
        const oldBottom = ui.gridInner.offsetTop + prev;
        if (st > 0 && oldBottom < st + ui.grid.clientHeight / 2) ui.grid.scrollTop = st + d;
      }).observe(ui.gridInner);

      // Ctrl+滾輪調縮圖大小，跟單圖的 Ctrl+滾輪縮放是同一個手勢。
      // 沒按 Ctrl 就不攔，原生捲動照跑
      ui.grid.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        poke();
        resizeGrid(e.deltaY < 0 ? 1 : -1);
      }, { passive: false });

      ui.help.addEventListener('click', () => { ui.help.hidden = true; });

      /* 滑鼠靜止 or 移出視窗就把 UI 收起來 */
      ui.overlay.addEventListener('pointermove', poke);
      ui.overlay.addEventListener('pointerdown', poke);
      // overlay 撐滿整個視窗，離開它就等於滑鼠不在視窗裡
      ui.overlay.addEventListener('pointerleave', () => hideUI(true));
      ui.dlMenu.addEventListener('click', (e) => {
        const mi = e.target.closest('[data-act]');
        if (!mi) return;
        e.stopPropagation();
        doAction(mi.dataset.act);
      });

      for (const el of [ui.tools, ui.thumbs, ui.dlMenu]) {
        el.addEventListener('pointerenter', () => { overUI = true; });
        el.addEventListener('pointerleave', () => { overUI = false; });
      }

      /* 滾輪：能捲就捲，捲到底再翻頁；Ctrl+滾輪縮放 */
      ui.stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        poke();
        const r = stageRect();

        if (e.ctrlKey) {
          zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12,
                 e.clientX - r.left - r.width / 2,
                 e.clientY - r.top - r.height / 2);
          return;
        }

        if (panLimits()[1] > 1) {
          const before = panY;
          panY -= e.deltaY;
          clampPan();
          applyTransform();
          if (Math.abs(panY - before) > 0.5) return; // 還捲得動就不翻頁
        }
        e.deltaY > 0 ? next() : prev();
      }, { passive: false });

      /* 左右箭頭：跟 home 的焦點輪播一樣，滑鼠離那一側不到 NAV_NEAR 才浮出來（CSS 的 [data-near]）。
         量的是指標到舞台左右緣的距離，不是到按鈕；點左右 35% 翻頁的舊行為照舊，箭頭只是看得到的那一塊。
         按鈕放在 .bv-stage 裡面，滾輪才會冒泡到舞台照常捲 / 翻頁 */
      const NAV_NEAR = 180;
      let nearTick = false;
      ui.stage.addEventListener('pointermove', (e) => {
        if (nearTick || e.pointerType !== 'mouse') return;
        nearTick = true;
        requestAnimationFrame(() => {
          nearTick = false;
          if (drag || !ui.stage.matches(':hover')) { ui.overlay.dataset.near = ''; return; }
          const r = stageRect();
          const near = Math.min(NAV_NEAR, r.width / 4);   // 窄視窗別讓兩邊的感應區疊在一起
          ui.overlay.dataset.near = e.clientX - r.left < near ? 'prev' : r.right - e.clientX < near ? 'next' : '';
        });
      });
      ui.stage.addEventListener('pointerleave', () => { ui.overlay.dataset.near = ''; pointer = null; imageLeave(); });
      ui.stage.addEventListener('pointermove', (e) => {
        pointer = { x: e.clientX, y: e.clientY };
        imageCheck();
      });
      for (const [btn, go] of [[ui.navPrev, () => prev()], [ui.navNext, () => next()]]) {
        btn.addEventListener('click', (e) => { e.stopPropagation(); if (btn.dataset.off !== '1') go(); });
        btn.addEventListener('dblclick', (e) => e.stopPropagation());   // 連點翻兩張，不是切縮放模式
      }

      /* 拖曳平移 + 點左右半邊翻頁（用位移量區分點擊與拖曳） */
      let drag = null;
      ui.stage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.bv-nav')) return;   // 箭頭自己處理 click，別讓舞台抓走指標當拖曳
        drag = { x: e.clientX, y: e.clientY, px: panX, py: panY, moved: 0 };
        ui.stage.setPointerCapture(e.pointerId);
        ui.stage.dataset.dragging = '1';
      });

      ui.stage.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
        panX = drag.px + dx;
        panY = drag.py + dy;
        clampPan();
        applyTransform();
      });

      ui.stage.addEventListener('pointerup', (e) => {
        if (!drag) return;
        const wasClick = drag.moved < 6;
        drag = null;
        ui.stage.dataset.dragging = '0';

        if (!wasClick) return;
        if (!ui.help.hidden) { ui.help.hidden = true; return; }
        if (!ui.dlMenu.hidden) { closeMenu(); return; }   // 點畫面先收下拉，不翻頁

        const r = stageRect();
        const x = (e.clientX - r.left) / r.width;
        if (x < 0.35) prev();
        else if (x > 0.65) next();
      });

      ui.stage.addEventListener('pointercancel', () => {
        drag = null;
        ui.stage.dataset.dragging = '0';
      });

      ui.stage.addEventListener('dblclick', (e) => {
        e.preventDefault();
        setMode(mode === 'fit' ? 'actual' : 'fit');
      });

      ui.stage.addEventListener('contextmenu', (e) => e.stopPropagation());
    }

    function doAction(act) {
      if (act !== 'dlmenu') closeMenu();     // 選了任何一項就把下拉收掉
      switch (act) {
        case 'mode': {
          const i = MODES.indexOf(mode);
          setMode(MODES[(i + 1) % MODES.length]); // free 時 indexOf 為 -1 → 回到 fit
          break;
        }
        // 總覽開著時 ＋ / − 調的是縮圖大小，不是那張看不見的單圖
        case 'zoomin':  ui.grid.hidden ? zoomBy(1.25) : resizeGrid(1); break;
        case 'zoomout': ui.grid.hidden ? zoomBy(1 / 1.25) : resizeGrid(-1); break;
        case 'rotate':  rotate(-90); break;  // 預設逆時針
        case 'slideshow': toggleSlideshow(); break;
        case 'shuffle': toggleShuffle(); break;
        case 'thumbs':  toggleThumbs(); break;
        case 'grid':    toggleGrid(); break;
        case 'download': download(); break;
        case 'dlmenu':  toggleMenu(); break;
        case 'download-all':  downloadAll(0); break;
        case 'download-rest': downloadAll(index); break;
        case 'copy':     copyUrl(); break;
        case 'copy-all': copyAllUrls(); break;
        case 'full':    toggleFullscreen(); break;
        case 'help':
          ui.help.hidden = !ui.help.hidden;
          break;
        case 'close':   closeOrBack(); break;
        case 'go':      runItemAction(); break;
        default:        host.action?.(act);   // 宿主自己的按鈕
      }
    }

    // 這一張的動作（宿主的 itemAction）；回傳有沒有做事：沒有的話 Enter 不攔，照原本的行為
    function runItemAction() {
      const act = items[index] && host.itemAction?.(items[index]);
      if (!act) return false;
      act.run();
      return true;
    }

    function rotate(deg) {
      rotation = (rotation + deg + 360) % 360;

      const src = srcOf(items[index]);
      if (rotation) rotations.set(src, rotation);
      else rotations.delete(src);           // 轉回 0 就不用記了

      setMode(mode === 'free' ? 'fit' : mode);
    }

    function toggleMenu() {
      ui.dlMenu.hidden = !ui.dlMenu.hidden;
      ui.dlMenuBtn.dataset.on = ui.dlMenu.hidden ? '0' : '1';
    }

    function closeMenu() {
      if (ui.dlMenu.hidden) return;
      ui.dlMenu.hidden = true;
      ui.dlMenuBtn.dataset.on = '0';
    }

    function toggleThumbs() {
      ui.thumbs.hidden = !ui.thumbs.hidden;
      ui.thumbsBtn.dataset.on = ui.thumbs.hidden ? '0' : '1';
      if (!ui.thumbs.hidden) { syncThumbs(); updateUI(); }
    }

    const toggleGrid = () => (ui.grid.hidden ? openGrid() : closeGrid());

    function openGrid() {
      if (!ui.grid.hidden) return;
      imageLeave();
      ui.grid.hidden = false;
      ui.gridBtn.dataset.on = '1';
      ui.overlay.dataset.grid = '1';
      closeMenu();
      applyGridCol();    // 沿用上次調的大小
      syncGrid();        // 第一次開才真的建格子
      relayoutGrid();    // 關著的時候載好的縮圖沒排到，補算一次
      syncClose();
      updateUI();
      crawlRest();       // 總覽要看得到整本；單飛的，重複呼叫不會多抓

      const tile = ui.gridInner.children[index];
      if (tile) tile.scrollIntoView({ block: 'center' });
      poke();
    }

    function closeGrid() {
      if (ui.grid.hidden) return;
      resetGrid();
      poke();            // 閒置計時在總覽開著時是停的，回單圖要重新算
    }

    function resetGrid() {
      tileLeave();       // 換一輪、關 viewer、回單圖都會走這裡
      ui.grid.hidden = true;
      ui.gridBtn.dataset.on = '0';
      ui.overlay.dataset.grid = '0';
      syncClose();
    }

    /* 右上角 ✕（和 Esc 最後那一步）是「退一層」：總覽是這一輪的起點（gridHome）時，
       單圖是疊在總覽上面的那層，✕ 就是回總覽，總覽裡的 ✕ 才是關閉。
       起點是單圖（設定關掉「點圖片先開格狀總覽」）時反過來，總覽才是上面那層，
       由 gridKey 的 Esc 收掉；單圖的 ✕ 照舊關閉，不然兩邊會互相退來退去 */
    const backToGrid = () => gridHome && ui.grid.hidden;

    function closeOrBack() {
      if (backToGrid()) openGrid();
      else closeViewer();
    }

    function syncClose() {
      ui.closeBtn.title = backToGrid() ? T.tBack : T.tClose;
    }

    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else ui.host.requestFullscreen?.().catch(() => toast(T.noFull));
    }

    /* ── 鍵盤 ──────────────────────────────────────────── */

    function onKey(e) {
      if (!open) return;
      poke();                    // 按鍵也算有在用，UI 先回來
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // Ctrl+C / Ctrl+S 之類留給瀏覽器
      const k = e.key;

      // 總覽開著的時候方向鍵 / 空白鍵是捲總覽，不是翻圖
      if (!ui.grid.hidden && gridKey(k)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      let handled = true;

      switch (k) {
        case 'Escape':
          if (!ui.help.hidden) ui.help.hidden = true;
          else if (!ui.dlMenu.hidden) closeMenu();
          else if (batch) batch.cancel = true;
          else if (playing) stopSlideshow();
          else if (document.fullscreenElement) document.exitFullscreen();
          else closeOrBack();
          break;
        case 'Enter': if (!ui.grid.hidden || !runItemAction()) handled = false; break;   // 總覽裡沒有「這一張」
        case 'ArrowRight': case 'PageDown': case ' ': next(); break;
        case 'ArrowLeft':  case 'PageUp':          prev(); break;
        case 'Home': goTo(0); break;
        case 'End':  goTo(items.length - 1); break;
        case 'ArrowUp':   panY += 80; clampPan(); applyTransform(); break;
        case 'ArrowDown': panY -= 80; clampPan(); applyTransform(); break;
        case '+': case '=': zoomBy(1.25); break;
        case '-': case '_': zoomBy(1 / 1.25); break;
        case '0': setMode('fit'); break;
        case '1': setMode('actual'); break;
        case 'w': case 'W': setMode('width'); break;
        case 'r': rotate(-90); break;  // 預設逆時針
        case 'R': rotate(90); break;   // Shift+R 順時針
        case 'p': toggleSlideshow(); break;
        case 'P': toggleShuffle(); break;   // 跟 r/R、s/S、c/C 一樣，Shift 是同一件事的變體
        case '[': bumpSlideDelay(-500); break;
        case ']': bumpSlideDelay(500); break;
        case 't': case 'T': toggleThumbs(); break;
        case 'g': case 'G': toggleGrid(); break;
        case 's': case 'S': case 'c': case 'C':
          if (!host.download) { handled = false; break; }   // 沒有下載就整組不接，按鍵留給頁面
          if (k === 's') download();
          else if (k === 'S') downloadAll(0);
          else if (k === 'c') copyUrl();
          else copyAllUrls();
          break;
        case 'f': case 'F': toggleFullscreen(); break;
        case '?': case '/': ui.help.hidden = !ui.help.hidden; break;
        default:
          if (host.keys?.[k]) host.action?.(host.keys[k]);   // 宿主自己的快速鍵
          else handled = false;
      }

      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    // 總覽開著時先攔下來的按鍵；回傳有沒有吃掉
    function gridKey(k) {
      const page = ui.grid.clientHeight * 0.9;
      switch (k) {
        case 'Escape':
          // 說明 / 下拉還開著就讓原本的剝層順序先處理
          if (!ui.help.hidden || !ui.dlMenu.hidden) return false;
          // 總覽是預設進入點時它就是最外層，Esc 該直接關掉（不然會退到一個根本沒去過的單圖）；
          // 交回主 switch 的 Esc 串鏈，順便保留「批次下載中先取消下載」那一段
          if (prefs.openInGrid) return false;
          closeGrid();
          return true;
        case 'ArrowDown': ui.grid.scrollBy({ top: 120 }); return true;
        case 'ArrowUp':   ui.grid.scrollBy({ top: -120 }); return true;
        case 'PageDown': case ' ': ui.grid.scrollBy({ top: page, behavior: 'smooth' }); return true;
        case 'PageUp':             ui.grid.scrollBy({ top: -page, behavior: 'smooth' }); return true;
        case 'Home': ui.grid.scrollTo({ top: 0, behavior: 'smooth' }); return true;
        case 'End':  ui.grid.scrollTo({ top: ui.grid.scrollHeight, behavior: 'smooth' }); return true;
        case '+': case '=': resizeGrid(1); return true;
        case '-': case '_': resizeGrid(-1); return true;
        case 'ArrowRight': case 'ArrowLeft': return true;   // 總覽裡不翻圖
        default: return false;
      }
    }

    function onResize() {
      if (!open) return;
      relayoutGrid();                 // 欄數變了，所有格子的 row span 要重算
      if (mode !== 'free') setMode(mode);
      else { clampPan(); applyTransform(); }
    }

    /* ── 開 / 關 ───────────────────────────────────────── */

    let scrollLock = null;

    async function openViewer(list, i, source) {
      // booting 是必要的：下面兩個 await 之間 open 還是 false，連點兩下會跑進來兩次、
      // 蓋掉第一次建好的 ui
      if (open || booting) return;
      booting = true;
      try {
        // 設定 / 收藏還沒讀回來就先等；下面本來就要 await 一次 CSS
        await host.ready?.();
        if (!ui) await buildUI();
      } finally {
        booting = false;
      }
      if (open) return;         // 等的期間被別人搶先開了

      open = true;
      document.documentElement.appendChild(ui.host);

      scrollLock = {
        html: document.documentElement.style.overflow,
        body: document.body.style.overflow,
      };
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';

      beginRound(list, i, source);

      window.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', onResize);
      window.addEventListener('blur', onBlur);
      poke();

      if (!sessionStorage.getItem('bv-seen-help')) {
        sessionStorage.setItem('bv-seen-help', '1');
        toast(T.helpHint);
      }
    }

    /* 「一輪」的開始：清單、續頁、縮圖列、總覽全部換成這一輪的。
       openViewer 開 viewer 時跑一次，宿主在 viewer 裡換本（replace）時再跑一次；
       掛 host、鎖捲動、註冊 listener 這些「整個 viewer 一次」的事留在 openViewer */
    function beginRound(list, i, source) {
      items = list;
      bag = [];                 // 換一輪，上一輪的抽牌袋作廢（startSlideshow 會重洗）
      bagLen = items.length;
      stopWarm();               // 上一輪還沒抓完的就不補了；goTo 會替這一輪開始抓

      initPager(source);
      thumbIO?.disconnect();            // 上一輪的節點要拿掉，observer 不用再盯著
      ui.thumbs.textContent = '';       // 上一輪的清單不要留著
      syncThumbs();                     // 縮圖列上次是開著的才會真的建
      ui.thumbsBtn.dataset.on = ui.thumbs.hidden ? '0' : '1';
      gridIO?.disconnect();             // 同上（宿主在 onRound 裡掛的推薦卡要排在這之後）
      ui.gridInner.textContent = '';    // 總覽同理
      gridHome = prefs.openInGrid;      // 這一輪從哪一層開始；中途改設定不影響已經開著的這輪
      resetGrid();
      // 宿主換它那邊的「這一輪」（收藏、推薦…），順便給上方列 / 下載資料夾的標題
      roundTitle = host.onRound?.(items) || '';
      // index / 旋轉角度 / 預載都先照剛才點的那張設好，總覽點下去才會是接得上的
      goTo(i);
      if (prefs.openInGrid) openGrid();   // 預設先看總覽，點格子（或按 G）才進單圖
      else ui.grid.scrollTop = 0;
      crawlRest();   // 不 await：背景慢慢接，使用者不用等
    }

    function closeViewer() {
      if (!open) return;
      open = false;
      stopWarm();

      playing = false;
      clearTimeout(slideTimer);
      slideTimer = 0;
      stopProgress();

      clearTimeout(idleTimer);
      idleTimer = 0;
      overUI = false;
      ui.overlay.dataset.idle = '0';

      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);

      ui.host.remove();
      ui.help.hidden = true;
      closeMenu();
      resetGrid();

      if (scrollLock) {
        document.documentElement.style.overflow = scrollLock.html;
        document.body.style.overflow = scrollLock.body;
        scrollLock = null;
      }

      imageLeave();
      pointer = null;
      host.onClose?.(items, index);   // 捲回頁面上剛才在看的那張之類，由宿主決定
    }

    return {
      prefs,
      setPrefs,
      open: openViewer,
      // viewer 開著時換成另一輪（不關 viewer）
      replace: (list, i, source) => { if (open) beginRound(list, i, source); },
      close: closeViewer,
      isOpen: () => open,
      busy: () => open || booting,
      current: () => items[index],
      gridOpen: () => !!ui && !ui.grid.hidden,
      refresh: () => { if (open) goTo(index); },
      update: () => { if (open && ui) updateUI(); },
      toast,
      stopSlideshow,
      // 總覽底下留給宿主的區塊（.bv-next）；viewer 第一次開之前是 null
      footer: () => ui?.foot || null,
      // 宿主放在總覽裡的 <img>（或包著它的節點）交給總覽的預載 observer
      lazy: (node) => gridLazy().observe(node),
      queueFix,
      tool: (act) => ui?.tools.querySelector(`[data-act="${act}"]`) || null,
    };
  }

  globalThis.BV_VIEWER = { create, srcOf };
})();

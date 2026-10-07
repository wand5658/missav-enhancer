// 設定 popup。畫面從 GROUPS 產生，值讀寫 settings.js 的 VHS（chrome.storage.sync）。
// 開著的網站分頁透過 storage.onChanged 即時套用；VHS.RELOAD 裡的設定要重新整理分頁才生效。
(async () => {
    await VHS.ready;

    // ── 文字（繁中 / English）───────────────────────────────────
    const T = {
        zh: {
            applied: "已套用", notApplied: "此分頁未套用",
            reloadNeeded: "部分變更要重新整理分頁才會生效", reloadBtn: "重新整理",
            reset: "恢復預設", export: "匯出設定", import: "匯入設定",
            saved: "已套用", resetDone: "已恢復預設", imported: "已匯入", importBad: "檔案格式不對",
            atLeastOne: "至少要選一個", reloadTag: "重新整理後生效",
            sec: "秒",
        },
        en: {
            applied: "Active", notApplied: "Not on this tab",
            reloadNeeded: "Some changes apply after reloading the tab", reloadBtn: "Reload",
            reset: "Reset", export: "Export", import: "Import",
            saved: "Applied", resetDone: "Reset to defaults", imported: "Imported", importBad: "Not a valid settings file",
            atLeastOne: "Pick at least one", reloadTag: "after reload",
            sec: "s",
        },
    };
    const lang = () => {
        const l = VHS.get("lang");
        if (l === "zh" || l === "en") return l;
        return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
    };
    const t = k => T[lang()][k];
    const L = pair => pair[lang()] ?? pair.zh;     // { zh, en } → 目前語言

    // ── 項目描述 ──────────────────────────────────────────────
    // sw：開關；range：滑桿（pct 表示存 0–1、顯示 0–100%）；seg：單選；multi：複選陣列；flags：每個選項各是一個布林 key
    // hint 是標籤下的一行小字；note 是整列下方較長的說明（可換行）
    const o = (v, zh, en = zh) => ({ v, zh, en });
    const GROUPS = [
        { id: "general", ico: "⚙", title: o(0, "一般", "General"), items: [
            { type: "seg", key: "lang", label: o(0, "介面語言", "Language"),
              options: [o("auto", "自動", "Auto"), o("zh", "繁中"), o("en", "English")] },
            { type: "seg", key: "motion", label: o(0, "動態效果", "Motion"), hint: o(0, "「減少」會關掉所有動畫", "“Reduce” turns off all animation"),
              options: [o("system", "跟隨系統", "System"), o("full", "完整", "Full"), o("reduce", "減少", "Reduce")] },
        ] },
        { id: "antiPause", ico: "⏵", title: o(0, "防止自動暫停", "Anti auto-pause"), items: [
            { type: "range", key: "gestureMs", label: o(0, "手動暫停判定時間", "Manual pause window"),
              hint: o(0, "點擊或按鍵後多久內的暫停算你自己按的", "A pause this soon after a click or key counts as yours"),
              min: 300, max: 2000, step: 100, unit: "ms" },
            { type: "sw", key: "fallbackResume", label: o(0, "備援：自動恢復播放", "Fallback: resume playback"),
              hint: o(0, "攔不到時，偵測到暫停就接著播（會頓一下）", "Resumes if a pause slips through (brief stutter)") },
        ] },
        { id: "hero", ico: "◧", title: o(0, "封面輪播", "Cover carousel"), items: [
            { type: "flags", label: o(0, "顯示在", "Show on"), options: [o("heroHome", "首頁", "Home"), o("heroList", "列表頁", "Lists")] },
            { type: "seg", key: "heroHeight", label: o(0, "高度", "Height"), options: [o("full", "滿版", "Full screen"), o("short", "較矮", "Shorter")] },
            { type: "range", key: "heroSeconds", label: o(0, "每張停留", "Time per slide"), min: 5, max: 30, step: 1, unit: "sec" },
            { type: "multi", key: "heroFx", label: o(0, "切換動畫", "Transitions"), hint: o(0, "每次從勾選的裡面隨機挑", "One picked at random each time"),
              options: [o("parallax", "視差", "Parallax"), o("zoom", "穿越", "Zoom"), o("flip", "3D 翻卡", "3D flip"), o("push", "推進", "Push")] },
            { type: "range", key: "heroSpeed", label: o(0, "切換速度", "Transition speed"), min: 300, max: 1500, step: 50, unit: "ms" },
            { type: "sw", key: "heroPreview", label: o(0, "播放預覽影片", "Play preview clips"), hint: o(0, "關掉只顯示封面，省流量", "Off: covers only, saves data") },
            { type: "sw", key: "heroHD", label: o(0, "高畫質預覽", "HD previews"), hint: o(0, "從正片挑片段播放；拿不到時用原本的預覽", "Plays clips picked from the full video; falls back to the normal preview") },
            { type: "seg", key: "heroHDQuality", label: o(0, "畫質", "Quality"),
              hint: o(0, "自動：依畫框大小選 480p 或 720p。越高越清楚，也越耗流量", "Auto picks 480p or 720p by frame size. Higher looks sharper and uses more data"),
              options: [o("auto", "自動", "Auto"), o("480p", "480p", "480p"), o("720p", "720p", "720p"), o("1080p", "1080p", "1080p")] },
            { type: "seg", key: "heroHDPick", label: o(0, "片段", "Clip"),
              hint: o(0, "自動挑選：從預覽縮圖找有人物、有動作的段落。平均分布：固定取 10%～80% 的位置，跟網站原本的預覽一樣",
                         "Auto-pick looks for scenes with people and motion in the scrub thumbnails. Evenly spaced takes fixed spots from 10% to 80%, like the site's own preview"),
              options: [o("smart", "自動挑選", "Auto-pick"), o("even", "平均分布", "Evenly spaced")] },
            { type: "range", key: "heroHDWait", label: o(0, "高畫質等待上限", "HD wait limit"), min: 1, max: 8, step: 0.5, unit: "sec",
              hint: o(0, "等不到就先播原本的預覽", "Then plays the normal preview"),
              note: o(0, "每張出現後，最多等這麼久讓高畫質開始播（找串流＋載入），等待時畫面是封面慢慢放大。\n・常看到低畫質預覽 → 調長（網路慢建議 4～6 秒）\n・覺得封面停太久才開始動 → 調短",
                         "How long each slide waits for the HD clip to start (finding the stream and loading it); meanwhile the cover slowly zooms.\n• Often get the low-res preview → raise it (4–6 s on a slow connection)\n• Cover sits too long before moving → lower it") },
            { type: "sw", key: "heroTint", label: o(0, "背景跟著封面換色", "Tint page from the cover") },
        ] },
        { id: "home", ico: "▤", title: o(0, "首頁", "Home page"), items: [
            { type: "sw", key: "homeRows", label: o(0, "橫向捲動列", "Scrolling rows"), hint: o(0, "關掉維持網站原本的網格", "Off: keep the site's grid") },
            { type: "seg", key: "homePer", label: o(0, "每列卡片", "Cards per row"),
              options: [o("auto", "自動", "Auto"), o("3", "3"), o("4", "4"), o("5", "5"), o("6", "6")] },
            { type: "range", key: "homeZoom", label: o(0, "滑鼠停留放大", "Hover zoom"), min: 1, max: 1.5, step: 0.05, unit: "x" },
            { type: "sw", key: "homeHideSearch", label: o(0, "隱藏首頁大搜尋框", "Hide the big search box") },
        ] },
        { id: "list", ico: "▦", title: o(0, "列表頁", "List pages"), items: [
            { type: "sw", key: "listChips", label: o(0, "篩選 / 排序改成按鈕", "Filter and sort as chips") },
            { type: "sw", key: "listPager", label: o(0, "新版分頁列", "New pagination"), hint: o(0, "工具列翻頁器＋底部大按鈕", "Toolbar pager and large buttons") },
            { type: "seg", key: "listCols", label: o(0, "每列欄數（寬螢幕）", "Columns (wide screens)"),
              options: [o("site", "網站預設", "Site default"), o("2", "2"), o("3", "3"), o("4", "4")] },
        ] },
        { id: "video", ico: "▶", title: o(0, "影片頁", "Video page"), items: [
            { type: "sw", key: "videoTheater", label: o(0, "劇院式版面", "Theater layout"), hint: o(0, "播放器滿版、填滿視窗高度", "Full-width player that fills the window height") },
            { type: "range", key: "videoGap", label: o(0, "播放器下方留白", "Space below the player"), min: 0, max: 80, step: 4, unit: "px" },
            { type: "sw", key: "videoHidePromo", label: o(0, "隱藏推廣連結", "Hide promo links") },
        ] },
        { id: "look", ico: "✦", title: o(0, "外觀與動畫", "Look and motion"), items: [
            { type: "sw", key: "ambient", label: o(0, "環境光（影片頁）", "Ambient light (video page)") },
            { type: "range", key: "ambientAlpha", label: o(0, "環境光強度", "Ambient strength"), min: 0, max: 100, step: 5, unit: "%", pct: true },
            { type: "sw", key: "breathe", label: o(0, "光暈呼吸", "Breathing glow") },
            { type: "range", key: "washAlpha", label: o(0, "全頁背景染色", "Page tint"), min: 0, max: 100, step: 5, unit: "%", pct: true },
            { type: "sw", key: "glass", label: o(0, "玻璃面板", "Glass panels") },
            { type: "sw", key: "reveal", label: o(0, "捲動時卡片依序浮出", "Cards fade up on scroll") },
            { type: "range", key: "revealGap", label: o(0, "浮出間隔", "Stagger"), min: 0, max: 300, step: 10, unit: "ms" },
            { type: "range", key: "revealMs", label: o(0, "浮出長度", "Duration"), min: 200, max: 1500, step: 50, unit: "ms" },
        ] },
        { id: "ads", ico: "⊘", title: o(0, "廣告", "Ads"), items: [
            { type: "sw", key: "hideAds", label: o(0, "隱藏頁面廣告", "Hide page ads"),
              hint: o(0, "首頁、列表頁、影片頁的橫幅與右下角廣告", "Banners and the corner ad") },
        ] },
    ];

    // ── 畫面 ──────────────────────────────────────────────────
    const $ = id => document.getElementById(id);
    const body = $("body");
    const opened = new Set(["general", "antiPause", "hero"]);
    let reloadNeeded = false;

    const fmt = (it, v) => {
        if (it.pct) return `${Math.round(v * 100)}%`;
        if (it.unit === "x") return `${Number(v).toFixed(2)}×`;
        if (it.unit === "sec") return `${v} ${t("sec")}`;
        return `${v} ${it.unit}`;
    };
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const reloadTag = key => key && VHS.RELOAD.has(key) ? `<span class="tag">${t("reloadTag")}</span>` : "";

    const note = it => it.note ? `<p class="note">${esc(L(it.note))}</p>` : "";

    function itemHtml(it) {
        const lab = `<span class="label">${esc(L(it.label))}${reloadTag(it.key)}${it.hint ? `<span class="hint">${esc(L(it.hint))}</span>` : ""}</span>`;
        const v = it.key ? VHS.get(it.key) : null;
        if (it.type === "sw")
            return `<div class="row">${lab}<label class="sw"><input type="checkbox" data-key="${it.key}" ${v ? "checked" : ""} aria-label="${esc(L(it.label))}"><span></span></label></div>`;
        if (it.type === "range") {
            const shown = it.pct ? Math.round(v * 100) : v;
            return `<div class="row">${lab}<input type="range" data-key="${it.key}" min="${it.min}" max="${it.max}" step="${it.step}" value="${shown}" aria-label="${esc(L(it.label))}"><span class="val">${fmt(it, v)}</span></div>${note(it)}`;
        }
        if (it.type === "seg")
            return `<div class="row">${lab}<div class="seg" data-key="${it.key}" data-mode="one">${it.options.map(op =>
                `<button type="button" data-v="${op.v}" aria-pressed="${v === op.v}">${esc(L(op))}</button>`).join("")}</div></div>`;
        if (it.type === "multi")
            return `<div class="row">${lab}<div class="seg" data-key="${it.key}" data-mode="many">${it.options.map(op =>
                `<button type="button" data-v="${op.v}" aria-pressed="${v.includes(op.v)}">${esc(L(op))}</button>`).join("")}</div></div>`;
        if (it.type === "flags")
            return `<div class="row">${lab}<div class="seg" data-mode="flags">${it.options.map(op =>
                `<button type="button" data-flag="${op.v}" aria-pressed="${Boolean(VHS.get(op.v))}">${esc(L(op))}</button>`).join("")}</div></div>`;
        return "";
    }

    // 每次存檔都會經 storage.onChanged 重畫；記住焦點在哪個控制項，重畫後放回去，鍵盤操作才不會跳掉
    function focusKey() {
        const el = document.activeElement;
        if (!el || !body.contains(el)) return null;
        const seg = el.closest(".seg");
        if (seg) return `.seg[data-${seg.dataset.key ? "key" : "mode"}="${seg.dataset.key || seg.dataset.mode}"] button[data-${el.dataset.flag ? "flag" : "v"}="${el.dataset.flag || el.dataset.v}"]`;
        if (el.dataset.key) return `input[data-key="${el.dataset.key}"]`;
        if (el.matches("summary")) return `details[data-g="${el.parentElement.dataset.g}"] > summary`;
        return null;
    }

    function render() {
        const refocus = focusKey();
        document.documentElement.lang = lang() === "zh" ? "zh-Hant" : "en";
        body.innerHTML = GROUPS.map(g => {
            const master = g.id in VHS.GROUPS;
            const on = master ? VHS.get(g.id) : true;
            return `<details data-g="${g.id}" ${opened.has(g.id) ? "open" : ""} class="${on ? "" : "off"}">
  <summary><span class="ico" aria-hidden="true">${g.ico}</span>${esc(L(g.title))}${master ? reloadTag(g.id) : ""}
    ${master ? `<label class="sw"><input type="checkbox" data-key="${g.id}" ${on ? "checked" : ""} aria-label="${esc(L(g.title))}"><span></span></label>` : ""}
    <span class="chev" aria-hidden="true">›</span></summary>
  <div class="items">${g.items.map(itemHtml).join("")}</div>
</details>`;
        }).join("");
        $("reset").textContent = t("reset");
        $("export").textContent = t("export");
        $("import").textContent = t("import");
        $("reloadText").textContent = t("reloadNeeded");
        $("reloadBtn").textContent = t("reloadBtn");
        $("reload").hidden = !reloadNeeded;
        renderSite();
        if (refocus) body.querySelector(refocus)?.focus();
    }

    // ── 寫入 ──────────────────────────────────────────────────
    let toastTimer;
    function toast(msg) {
        const el = $("toast");
        el.textContent = msg;
        el.classList.add("on");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove("on"), 1200);
    }

    async function save(patch) {
        if (Object.keys(patch).some(k => VHS.RELOAD.has(k))) reloadNeeded = true;
        await VHS.set(patch);
        toast(t("saved"));
    }

    // 總開關的勾選框包在 <summary> 裡的 <label>：點擊由 label 轉給勾選框，不會觸發 summary 的收合
    body.addEventListener("click", e => {
        const b = e.target.closest(".seg button");
        if (!b) return;
        const seg = b.parentElement;
        const mode = seg.dataset.mode;
        if (mode === "one") return save({ [seg.dataset.key]: b.dataset.v });
        if (mode === "flags") return save({ [b.dataset.flag]: b.getAttribute("aria-pressed") !== "true" });
        const key = seg.dataset.key;
        const list = VHS.get(key).slice();
        const i = list.indexOf(b.dataset.v);
        if (i >= 0) {
            if (list.length === 1) { toast(t("atLeastOne")); return; }
            list.splice(i, 1);
        } else list.push(b.dataset.v);
        save({ [key]: list });
    });

    body.addEventListener("toggle", e => {
        const g = e.target.dataset?.g;
        if (!g) return;
        if (e.target.open) opened.add(g); else opened.delete(g);
    }, true);

    // 滑桿拖動時只更新數字，放開才寫（storage.sync 有每分鐘寫入次數上限）
    const findItem = key => GROUPS.flatMap(g => g.items).find(it => it.key === key);
    body.addEventListener("input", e => {
        const el = e.target;
        if (el.type !== "range") return;
        const it = findItem(el.dataset.key);
        el.nextElementSibling.textContent = fmt(it, it.pct ? el.value / 100 : Number(el.value));
    });
    body.addEventListener("change", e => {
        const el = e.target;
        const key = el.dataset.key;
        if (!key) return;
        if (el.type === "checkbox") save({ [key]: el.checked });
        else if (el.type === "range") {
            const it = findItem(key);
            save({ [key]: it.pct ? Number(el.value) / 100 : Number(el.value) });
        }
    });

    // 別處（另一個視窗的 popup、恢復預設、匯入）改了設定就重畫
    VHS.subscribe(() => render());

    $("reset").addEventListener("click", async () => {
        if (Object.keys(VHS.DEFAULTS).some(k => VHS.RELOAD.has(k) && VHS.get(k) !== VHS.DEFAULTS[k])) reloadNeeded = true;
        await VHS.reset();
        toast(t("resetDone"));
    });

    $("export").addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(VHS.all(), null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "video-helper-settings.json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    $("import").addEventListener("click", () => $("file").click());
    $("file").addEventListener("change", async e => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        try {
            const data = VHS.clean(JSON.parse(await f.text()));
            if (!Object.keys(data).length) throw new Error("empty");
            await save(data);
            toast(t("imported"));
        } catch {
            toast(t("importBad"));
        }
    });

    // ── 目前分頁 ──────────────────────────────────────────────
    // host_permissions 涵蓋的網域才看得到 tab.url，不需要 tabs 權限
    let activeTab = null;
    const SITE = /^https:\/\/missav\.(ai|ws)\//;
    function renderSite() {
        const on = Boolean(activeTab?.url && SITE.test(activeTab.url));
        $("site").classList.toggle("on", on);
        $("siteText").textContent = on ? `${new URL(activeTab.url).host} ${t("applied")}` : t("notApplied");
    }
    $("reloadBtn").addEventListener("click", () => {
        if (activeTab) chrome.tabs.reload(activeTab.id);
        reloadNeeded = false;
        $("reload").hidden = true;
    });

    $("ver").textContent = `v${chrome.runtime.getManifest().version}`;
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    render();
})();

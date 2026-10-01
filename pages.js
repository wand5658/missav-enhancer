// hero.js 和 browse.js 共用的頁面判斷。同一個 content_scripts 條目裡的腳本共用 isolated world，
// 所以掛在 globalThis 上就讀得到；這支要排在它們前面載入。
globalThis.VH = {
    // 列表頁靠網址認：影片頁底下的推薦卡片也是 .thumbnail，不能看到卡片就當列表頁。
    // dm 後面的數字會換（dm635、dm539…）
    LIST_PAGES: [/^\/dm\d+(\/|$)/, /^\/saved\/?$/],

    LAYOUT_ROOT: "div.content-without-search, div.content-with-search",

    // 首頁的 layout root 帶伺服器端就有的 is-home class，不用管網址或語系路徑
    kind() {
        if (document.querySelector("div.is-home")) return "home";
        if (this.LIST_PAGES.some(re => re.test(location.pathname))) return "list";
        return null;
    },
};

(function () {
    function applyStyles() {
        // 第一個 div（匹配有特定 class 的元素）
        document.querySelectorAll("div.content-without-search, div.content-with-search").forEach(div => {
            div.style.paddingLeft = "0px";
            div.style.paddingRight = "0px";
            div.style.marginLeft = "auto";
            div.style.marginRight = "auto";
            div.style.maxWidth = "150vh";
        });

        // 第二個 div（匹配有 x-data 屬性的元素）
        document.querySelectorAll("div[x-data].flex").forEach(div => {
            div.style.display = "flex";
            div.style.flexDirection = "column";
        });
    }

    // 初次加載時應用樣式
    applyStyles();

    // 監聽 DOM 變化，確保新載入的元素也會被修改
    const observer = new MutationObserver(() => {
        applyStyles();
    });

    observer.observe(document.body, { childList: true, subtree: true });
})();


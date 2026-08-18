(function () {
    function applyStyles() {
        const layoutRoots = document.querySelectorAll("div.content-without-search, div.content-with-search");

        // 第一個 div（版面容器本身，加寬並置中）
        layoutRoots.forEach(div => {
            div.style.paddingLeft = "0px";
            div.style.paddingRight = "0px";
            div.style.marginLeft = "auto";
            div.style.marginRight = "auto";
            div.style.maxWidth = "150vh";
        });

        // 第二個 div（版面容器內的 Alpine 元件，改成直排）
        //
        // 必須限制在 layout 容器內，而且要跳過 Alpine 用 x-show 控制的元素。
        // 全站掃 div[x-data].flex 會打到登入 modal —— x-show 是靠寫 inline
        // display 開關元素的，這裡再把 display 寫回去就等於跟 Alpine 搶同一個
        // 屬性，加上下面的 MutationObserver 每次 DOM 變動都會重搶一次，
        // 結果是 modal 卡住打不開。
        layoutRoots.forEach(root => {
            root.querySelectorAll("div[x-data].flex").forEach(div => {
                if (div.hasAttribute("x-show")) return;
                if (getComputedStyle(div).position === "fixed") return;
                div.style.display = "flex";
                div.style.flexDirection = "column";
            });
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


export function listHTML(page = 1, mode = 'replyTime') {
  const ids = page === 1 ? [101, 102] : page === 2 ? [102, 103, 104] : [105, 106];
  return (
    '<!doctype html><html><head><title>NodeSeek · 测试列表</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header id="nsk-head">NodeSeek · 本地测试（不会访问论坛）</header><div id="nsk-frame"><div id="nsk-body"><main id="nsk-body-left"><div class="post-list-controler"><div class="sorter"><a href="/?sortBy=replyTime" data-sort="replyTime" class="' +
    (mode === 'replyTime' ? 'selected' : '') +
    '">新评论</a><a href="/?sortBy=postTime" data-sort="postTime" class="' +
    (mode === 'postTime' ? 'selected' : '') +
    '">新帖子</a></div></div><ul class="post-list">' +
    ids
      .map(
        (id) =>
          '<li class="post-list-item"><a href="/space/12"><img class="avatar-normal" src="/avatar/12.png" alt="测试作者"></a><div class="post-list-content"><div class="post-title"><a href="/post-' +
          id +
          '-1">' +
          [
            '给阅读留一点空间',
            '自己的小站，慢慢搭建',
            '十月的使用记录',
            '分享一个好用的小工具',
            '继续阅读，无需重新加载',
            '周末的网络实验',
          ][id - 101] +
          '</a></div><div class="post-info"><span class="info-author"><a href="/space/12">测试作者</a></span><span class="info-comments-count">' +
          (id - 90) +
          '</span><time datetime="2026-10-01T06:00:00Z">刚刚</time></div></div></li>',
      )
      .join('') +
    '</ul><div class="nsk-pager">' +
    (page < 3
      ? '<a href="/page-' + (page + 1) + '?sortBy=' + mode + '" rel="next">下一页</a>'
      : '') +
    '</div></main><aside id="nsk-right-panel-container"><div class="user-card"><div class="user-head"><a href="/space/999">测试账号</a><button class="color-theme-switcher" onclick="document.body.classList.toggle(\'dark-layout\')">亮 / 暗</button></div></div><div><a href="/new-discussion">＋ 发帖</a></div><div class="nsk-panel quick-access">快捷功能区</div><div class="nsk-panel">目前论坛共有 100 位 seeker</div><div class="nsk-panel">欢迎新用户</div></aside></div></div></body></html>'
  );
}
export function postHTML(page = 1) {
  const ids = page === 1 ? [42, 1, 2] : page === 2 ? [42, 3, 4] : [5, 6];
  return (
    '<!doctype html><html><head><title>给阅读留一点空间</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header id="nsk-head"><a href="/?sortBy=replyTime">NodeSeek 首页</a></header><div id="nsk-frame"><div id="nsk-body"><main id="nsk-body-left"><div class="nsk-post-wrapper"><div class="nsk-post"><div class="post-title"><h1><a class="post-title-link" href="/post-101-1">给阅读留一点空间</a></h1></div><div class="content-item" id="0"><article class="post-content"><p>这是本地模拟文章，用于测试续页缓存与阅读恢复，不会提交任何论坛内容。</p></article></div></div></div><ul class="comments">' +
    ids
      .map(
        (id) =>
          '<li class="content-item" id="' +
          id +
          '" data-comment-id="' +
          (1000 + id) +
          '"><div class="nsk-content-meta-info"><div class="avatar-wrapper"><a href="/space/12"><img class="avatar-normal" src="/avatar/12.png" alt="测试作者"></a></div><div><div class="author-info"><a class="author-name" href="/space/12">测试作者</a><span class="author-role">楼主</span></div><time datetime="2026-10-01T06:00:00Z">刚刚</time></div><div class="floor-link-wrapper"><a class="floor-link" href="#' +
          id +
          '">#' +
          id +
          '</a></div></div><article class="post-content"><p>第 ' +
          id +
          ' 楼：先看到缓存，再安静地更新。' +
          '让长帖的阅读连贯起来。'.repeat(8) +
          '</p></article><div class="comment-menu">网站原生菜单</div></li>',
      )
      .join('') +
    '</ul><div class="nsk-pager">' +
    (page < 3 ? '<a href="/post-101-' + (page + 1) + '" rel="next">下一页</a>' : '') +
    '</div><div id="editor"><textarea placeholder="本地测试回复框，不会发布"></textarea></div></main><aside id="nsk-right-panel-container"><div class="user-card"><div class="user-head"><a href="/space/999">测试账号</a><button class="color-theme-switcher" onclick="document.body.classList.toggle(\'dark-layout\')">亮 / 暗</button></div></div><div><a href="/new-discussion">＋ 发帖</a></div></aside></div></div><script id="temp-script" type="application/octet-stream">' +
    Buffer.from(
      JSON.stringify({
        postData: {
          comments: ids.map((floorIndex) => ({
            commentId: 1000 + floorIndex,
            floorIndex,
            content: '本地评论',
          })),
        },
      }),
    ).toString('base64') +
    '</script></body></html>'
  );
}

// Synthetic native component contract, only for local integration tests.
export function nativeMock() {
  return (
    '(' +
    (() => {
      const encoded = document.querySelector('#temp-script')?.textContent;
      window.__config__ = encoded ? JSON.parse(atob(encoded)) : { postData: { comments: [] } };
      class Menu {
        constructor() {
          this.$options = {};
        }
        setIndex(index) {
          this.index = index;
        }
        $mount() {
          const c = window.__config__.postData.comments[this.index];
          const menu = document.createElement('div');
          menu.className = 'comment-menu';
          menu.dataset.testCommentId = String(c.commentId);
          for (const title of ['点赞', '加鸡腿', '反对', '引用', '回复']) {
            const b = document.createElement('button');
            b.className = 'menu-item';
            b.title = title;
            b.textContent = title;
            b.addEventListener('click', () => {
              document.querySelector('textarea').value = title + ' #' + c.floorIndex;
            });
            menu.append(b);
          }
          menu.__vue__ = this;
          this.$el = menu;
        }
        $destroy() {}
      }
      for (const node of document.querySelectorAll('.comments > .content-item')) {
        const menu = new Menu();
        menu.setIndex(
          window.__config__.postData.comments.findIndex(
            (c) => String(c.commentId) === node.dataset.commentId,
          ),
        );
        menu.$mount();
        node.querySelector('.comment-menu').replaceWith(menu.$el);
      }
    }).toString() +
    ')();'
  );
}

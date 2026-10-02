import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
import {
  createState,
  edit,
  mergeOps,
  entities,
  validateOps,
  settingsFrom,
  DEFAULTS,
  routeKey,
  canonicalPage,
  ruleMatch,
  importLegacy,
} from '../src/core';
import { davBase, davFiles, syncDav } from '../src/dav';
import { parsePage, sanitize, safeShell, uniqueItems, renderItem } from '../src/adapter';
import { listHTML, postHTML, nativeMock } from './fixtures.mjs';
import { indexedDB } from 'fake-indexeddb';
import { getRow, setRow, rows, prune, removeRows } from '../src/db';
test('thread title matches never mark or block unrelated comments, including cached metadata', () => {
  const item = { title: 'aaitr 47段中午崩了', body: '现在还没有好的迹象', author: '测试', authorId: '12', kind: 'post' as const, floor: 2 };
  for (const action of ['mark', 'block'] as const) {
    const rule = { target: 'keyword' as const, text: 'ai', label: 'AI', color: '#123456', action, scope: 'title' as const };
    assert.equal(ruleMatch(rule, item), false);
    assert.equal(ruleMatch(rule, { ...item, floor: 0 }), true);
    assert.equal(ruleMatch(rule, { ...item, kind: 'list' }), true);
    assert.equal(ruleMatch(rule, { ...item, body: 'AI 回复' }), false);
    assert.equal(ruleMatch({ ...rule, scope: 'all' }, item), false);
    assert.equal(ruleMatch({ ...rule, scope: 'all' }, { ...item, body: 'AI 回复' }), true);
    assert.equal(ruleMatch({ ...rule, scope: 'body' }, { ...item, body: 'AI 回复' }), true);
    assert.equal(ruleMatch({ ...rule, areas: {title:true,post:false,comment:false} }, item), false);
  }
});

test('跨设备独立新增可以合并，且合并满足交换、幂等', () => {
  const a = edit(createState('a'), 'phrases', 'p1', '电脑');
  const b = edit(createState('b'), 'phrases', 'p2', '手机');
  const ab = mergeOps(a.ops, b.ops);
  assert.deepEqual(ab, mergeOps(b.ops, a.ops));
  assert.deepEqual(ab, mergeOps(ab, ab));
  assert.equal(entities(ab, 'phrases').length, 2);
});
test('同一短语的并发修改保留两版本，显式解决后消除冲突', () => {
  let a = edit(createState('a'), 'phrases', 'p', '初始');
  let b = { ...createState('b'), ops: a.ops };
  a = edit(a, 'phrases', 'p', '电脑编辑');
  b = edit(b, 'phrases', 'p', '手机编辑');
  a = { ...a, ops: mergeOps(a.ops, b.ops) };
  assert.equal(entities(a.ops, 'phrases')[0].conflicts.length, 2);
  a = edit(a, 'phrases', 'p', '合并后的内容');
  assert.equal(entities(a.ops, 'phrases')[0].conflicts.length, 0);
});
test('删除不会被离线设备的旧值复活，删改冲突可恢复', () => {
  let a = edit(createState('a'), 'phrases', 'p', '原内容');
  let b = { ...createState('b'), ops: a.ops };
  a = edit(a, 'phrases', 'p', null);
  assert.equal(entities(mergeOps(a.ops, b.ops), 'phrases').length, 0);
  b = edit(b, 'phrases', 'p', '离线修改');
  const result = entities(mergeOps(a.ops, b.ops), 'phrases', true)[0];
  assert.equal(result.value, null);
  assert.equal(result.conflicts.length, 2);
});
test('不依赖设备时间比较编辑先后', () => {
  let a = edit(createState('a'), 'settings', 'theme', 'dark');
  a.ops[0].at = 9999999999999;
  let b = { ...createState('b'), ops: a.ops };
  b = edit(b, 'settings', 'theme', 'light');
  b.ops[1].at = 1;
  assert.equal(settingsFrom(b.ops).theme, 'light');
});
test('拒绝操作 ID 碰撞和未知设置注入', () => {
  const a = edit(createState('a'), 'phrases', 'p', 'A');
  const b = structuredClone(a.ops);
  b[0].value = 'B';
  assert.throws(() => mergeOps(a.ops, b));
  assert.throws(() => edit(createState('a'), 'settings', '__proto__', 'x'));
  assert.throws(() => validateOps([{ ...a.ops[0], ctx: { a: 1 } }]));
});
test('本机主题覆盖不改变共享配置', () => {
  const a = edit(createState('a'), 'settings', 'theme', 'dark');
  assert.equal(settingsFrom(a.ops, { theme: 'light' }).theme, 'light');
  assert.equal(settingsFrom(a.ops).theme, 'dark');
});
test('排序、分类与帖子路由分隔', () => {
  assert.notEqual(
    routeKey('https://www.nodeseek.com/?sortBy=replyTime'),
    routeKey('https://www.nodeseek.com/?sortBy=postTime'),
  );
  assert.equal(
    routeKey('https://www.nodeseek.com/page-2?sortBy=replyTime'),
    routeKey('https://www.nodeseek.com/?sortBy=replyTime'),
  );
  assert.notEqual(
    routeKey('https://www.nodeseek.com/categories/tech'),
    routeKey('https://www.nodeseek.com/categories/trade'),
  );
  assert.equal(routeKey('https://www.nodeseek.com/post-123-2#20'), 'post:123');
});
test('分类分页的末尾斜线不分裂同一列表', () => {
  assert.equal(
    routeKey('https://www.nodeseek.com/categories/tech/page-2?sortBy=postTime'),
    routeKey('https://www.nodeseek.com/categories/tech?sortBy=postTime'),
  );
});
test('规则区分标题和正文，用户 ID 精确匹配', () => {
  const i = { title: '普通标题', body: '广告', author: 'A', authorId: '12', kind: 'post' as const };
  const r = {
    target: 'keyword' as const,
    text: '广告',
    action: 'block' as const,
    scope: 'title' as const,
    label: '',
    color: '#112233',
  };
  assert.equal(ruleMatch(r, i), false);
  assert.equal(ruleMatch({ ...r, scope: 'body' }, i), true);
  assert.equal(ruleMatch({ ...r, target: 'user', text: '12' }, i), true);
});
test('旧配置导入不带入图床密钥', () => {
  const r = importLegacy({
    options: {
      blockedKeywords: ['广告'],
      blockedUsers: ['12'],
      quickPhrases: ['你好'],
      apiKey: 'never-export',
    },
  });
  assert.equal(r.length, 3);
  assert.ok(!JSON.stringify(r).includes('never-export'));
});
function installDOM() {
  const w = new Window({ url: 'https://www.nodeseek.com/' });
  Object.assign(globalThis, { document: w.document, DOMParser: w.DOMParser });
  return w;
}
test('真实结构列表解析排除轮播，并保留排序 next', () => {
  const w = installDOM();
  w.document.write(listHTML(1, 'postTime'));
  const p = parsePage(w.document as any, 'https://www.nodeseek.com/', 'postTime');
  assert.deepEqual(
    p.items.map((x) => x.id),
    ['101', '102'],
  );
  assert.equal(new URL(p.next).searchParams.get('sortBy'), 'postTime');
  w.happyDOM.abort();
});
test('热门评论按稳定 ID 去重，保留后续楼层', () => {
  const w = installDOM();
  const p1 = parsePage(
    new w.DOMParser().parseFromString(postHTML(1), 'text/html') as any,
    'https://www.nodeseek.com/post-101-1',
  );
  const p2 = parsePage(
    new w.DOMParser().parseFromString(postHTML(2), 'text/html') as any,
    'https://www.nodeseek.com/post-101-2',
  );
  assert.deepEqual(
    uniqueItems([p1, p2]).map((x) => x.floor),
    [42, 1, 2, 3, 4],
  );
  w.happyDOM.abort();
});
test('缓存正文净化去除脚本、事件、危险链接、表单', () => {
  const w = installDOM();
  const html = sanitize(
    '<p onclick="evil()">正文<script>alert(1)</script><a href="javascript:evil()">链接</a><img src="https://img.example/a.png" onerror="evil()"><iframe src="https://evil.test"></iframe><input value="secret"></p>',
    'https://www.nodeseek.com/post-1-1',
  );
  assert.ok(html.includes('正文'));
  assert.ok(!/onclick|onerror|script|iframe|secret/.test(html));
  assert.ok(sanitize(html, 'https://www.nodeseek.com/', false).indexOf('<img') < 0);
  w.happyDOM.abort();
});
test('缓存评论保留头像、身份和右侧楼层；原生菜单不可用时显示原楼层入口', () => {
  const w = installDOM();
  const p = parsePage(
    new w.DOMParser().parseFromString(postHTML(2), 'text/html') as any,
    'https://www.nodeseek.com/post-101-2',
  );
  const e = renderItem(p.items[1]);
  assert.equal(e.querySelectorAll('[data-nf-action]').length, 0);
  assert.equal(
    e.querySelector('img')?.getAttribute('src'),
    'https://www.nodeseek.com/avatar/12.png',
  );
  assert.equal(e.querySelector('.author-role')?.textContent, '楼主');
  assert.ok(e.querySelector('.floor-link-wrapper .floor-link'));
  assert.match(e.querySelector('article.post-content')?.textContent || '', /第 3 楼/);
  assert.equal(
    e.querySelector('.nf-native-fallback')?.getAttribute('href'),
    'https://www.nodeseek.com/post-101-2#3',
  );
  w.happyDOM.abort();
});
test('WebDAV 基址限制 HTTPS，拒绝 URL 凭据与查询', () => {
  assert.throws(() => davBase('http://example.test/'));
  assert.throws(() => davBase('https://u:p@example.test/'));
  assert.throws(() => davBase('https://example.test/?token=x'));
  assert.equal(davBase('https://example.test/dav/flow').href, 'https://example.test/dav/flow/');
});

test('原生布局净化保留 scoped CSS 和图标，移除事件、外部 SVG 和表单', () => {
  const w = installDOM();
  const html = safeShell(
    '<div data-v-abc123 class="author-info"><a onclick="bad()" href="javascript:bad()">A</a><svg><use href="#quote"></use><use href="https://evil.test/x.svg"></use><foreignObject><input value="secret"></foreignObject></svg><img src="/avatar/12.png" onerror="bad()"><script>bad()</script></div>',
    'https://www.nodeseek.com/',
  );
  assert.ok(html.includes('data-v-abc123'));
  assert.ok(html.includes('#quote'));
  assert.ok(!/bad\(|evil.test|secret|onerror|onclick|foreignObject/i.test(html));
  w.happyDOM.abort();
});

test('旧标签导入保留排序、字号、颜色、禁用状态及稳定分组 ID', () => {
  const data = {
    options: {
      profileLabelKeys: ['coin', 'rank', 'stardust'],
      profileLabelSize: 'small',
      levelColors: { '6': '#fb8500' },
      followRules: {
        keywordGroups: [
          {
            id: 'group1',
            name: '关注',
            enabled: false,
            items: ['AI', 'GPT'],
            styles: { showGroupName: true, groupNameColor: { enabled: true, color: '#008017' } },
          },
        ],
      },
    },
  };
  const a = importLegacy(data),
    b = importLegacy(data);
  assert.deepEqual(a, b);
  assert.deepEqual(a.find((x) => x.key === 'profileLabelKeys')?.value, [
    'coin',
    'rank',
    'stardust',
  ]);
  const rules = a.filter((x) => x.collection === 'rules').map((x) => x.value as any);
  assert.equal(rules[0].color, '#008017');
  assert.equal(rules[0].enabled, false);
  assert.equal(rules[0].group, 'group1');
  assert.equal(
    ruleMatch(rules[0], { title: 'AI', body: '', author: '', authorId: '', kind: 'list' }),
    false,
  );
  assert.throws(() => importLegacy({ profileLabelKeys: ['password'] }));
  assert.throws(() => importLegacy({ levelColors: { '6': 'url(https://evil.test)' } }));
});

test('原生亮暗切换同步本机主题，热榜位于发帖按钮下，分组命中去重', async () => {
  const bundle = await readFile('dist/content.js', 'utf8');
  const w = new Window({ url: 'https://www.nodeseek.com/' });
  w.document.write(listHTML());
  const calls: any[] = [];
  const rule = {
    target: 'keyword',
    action: 'mark',
    scope: 'title',
    color: '#008017',
    label: '阅读',
    group: 'same',
  };
  Object.assign(w, {
    chrome: {
      runtime: {
        sendMessage: async (m: any) => {
          calls.push(m);
          let result: any = true;
          if (m.type === 'snapshot')
            result = {
              settings: { ...DEFAULTS, theme: 'light', listPaging: false, profiles: false },
              rules: [
                { id: 'a', value: { ...rule, text: '阅读' } },
                { id: 'b', value: { ...rule, text: '空间' } },
              ],
              phrases: [],
              progress: [],
            };
          if (m.type === 'hot')
            result = {
              posts: [{ id: '101', title: '热榜测试', author: '作者', score: 10 }],
              at: Date.now(),
            };
          return { ok: true, result };
        },
        onMessage: { addListener: () => {} },
      },
    },
  });
  w.eval(bundle);
  await until(() => !!w.document.querySelector('#nf-hot-panel .nf-hot li'));
  assert.ok(
    w.document
      .querySelector('#nf-hot-panel')
      ?.previousElementSibling?.querySelector('[href="/new-discussion"]'),
  );
  assert.equal(
    w.document.querySelector('.post-list-item')?.querySelectorAll('.nf-rule-label').length,
    1,
  );
  const toggle = w.document.querySelector('.color-theme-switcher')!;
  toggle.addEventListener('click', () => w.document.body.classList.toggle('dark-layout'));
  toggle.removeAttribute('onclick');
  (toggle as any).click();
  await until(() => calls.some((m) => m.type === 'themeChoice'));
  assert.equal(w.document.documentElement.dataset.nfTheme, 'dark');
  assert.equal(calls.find((m) => m.type === 'themeChoice').payload.theme, 'dark');
  await w.happyDOM.abort();
});
test('WebDAV 目录只接受专用路径内的变更文件', () => {
  const base = davBase('https://example.test/dav/flow/');
  const xml =
    '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/flow/flow-a-b.json</d:href></d:response><d:href>https://evil.test/dav/flow/flow-a-c.json</d:href><d:href>/dav/flow/../flow-a-c.json</d:href><d:href>/dav/flow/other.json</d:href></d:multistatus>';
  assert.deepEqual(davFiles(xml, base), ['https://example.test/dav/flow/flow-a-b.json']);
  assert.throws(() => davFiles('<!DOCTYPE x><multistatus/>', base));
});
function fakeDav() {
  const files = new Map<string, string>();
  let failPut = false,
    corrupt = false;
  const requests: any[] = [];
  const fetcher = async (url: any, opts: any) => {
    requests.push({ url, method: opts.method, redirect: opts.redirect });
    if (opts.method === 'PROPFIND')
      return new Response(
        '<d:multistatus xmlns:d="DAV:">' +
          [...files.keys()]
            .map((x) => '<d:response><d:href>' + new URL(x).pathname + '</d:href></d:response>')
            .join('') +
          '</d:multistatus>',
        { status: 207 },
      );
    if (opts.method === 'PUT') {
      if (failPut) return new Response('', { status: 503 });
      files.set(String(url), opts.body);
      return new Response('', { status: 201 });
    }
    if (opts.method === 'GET')
      return new Response(corrupt ? '{}' : files.get(String(url)), {
        status: files.has(String(url)) ? 200 : 404,
      });
    throw Error('unexpected');
  };
  return {
    files,
    requests,
    fetcher: fetcher as typeof fetch,
    setFail: (v: boolean) => (failPut = v),
    setCorrupt: (v: boolean) => (corrupt = v),
  };
}
const davConfig = {
  url: 'https://example.test/dav/flow/',
  username: 'test',
  password: 'not-real',
  enabled: true,
  progress: false,
};
test('WebDAV 上传后回读，两设备来回同步无丢失', async () => {
  const f = fakeDav();
  const a = edit(createState('a'), 'phrases', 'p1', '电脑');
  let b = edit(createState('b'), 'phrases', 'p2', '手机');
  await syncDav(davConfig, a.ops, f.fetcher);
  const r = await syncDav(davConfig, b.ops, f.fetcher);
  assert.equal(entities(r.ops, 'phrases').length, 2);
  const back = await syncDav(davConfig, a.ops, f.fetcher);
  assert.equal(entities(back.ops, 'phrases').length, 2);
  assert.equal(f.files.size, 2);
  assert.ok(f.requests.every((r) => r.redirect === 'error'));
});
test('重复同步幂等，不重复上传', async () => {
  const f = fakeDav();
  const a = edit(createState('a'), 'phrases', 'p', 'A');
  await syncDav(davConfig, a.ops, f.fetcher);
  await syncDav(davConfig, a.ops, f.fetcher);
  assert.equal(f.files.size, 1);
});
test('远端损坏或写入失败不会产生成功结果', async () => {
  const f = fakeDav();
  const a = edit(createState('a'), 'phrases', 'p', 'A');
  f.setFail(true);
  await assert.rejects(() => syncDav(davConfig, a.ops, f.fetcher), /503/);
  f.setFail(false);
  f.setCorrupt(true);
  await assert.rejects(() => syncDav(davConfig, a.ops, f.fetcher));
  assert.equal(a.ops[0].value, 'A');
});
test('阅读进度关闭时不上传，也不吸收远端进度', async () => {
  const f = fakeDav();
  const a = edit(createState('a'), 'progress', '999:101', {
    floor: 3,
    seen: 3,
    url: 'https://www.nodeseek.com/post-101-1#3',
    title: '测试',
    at: Date.now(),
  });
  await syncDav(davConfig, a.ops, f.fetcher);
  assert.equal(f.files.size, 0);
  await syncDav({ ...davConfig, progress: true }, a.ops, f.fetcher);
  const b = await syncDav(davConfig, [], f.fetcher);
  assert.equal(b.ops.length, 0);
});
test('同时上传不同操作使用独立文件，下一次收敛', async () => {
  const f = fakeDav();
  const a = edit(createState('a'), 'phrases', 'a', 'A');
  const b = edit(createState('b'), 'phrases', 'b', 'B');
  await Promise.all([syncDav(davConfig, a.ops, f.fetcher), syncDav(davConfig, b.ops, f.fetcher)]);
  const r = await syncDav(davConfig, [], f.fetcher);
  assert.equal(entities(r.ops, 'phrases').length, 2);
});
const delay = (n: number) => new Promise((r) => setTimeout(r, n));
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(10);
  }
  assert.ok(fn(), '等待本地页面状态超时');
}
test('内容脚本集成：列表追加去重、保存、刷新恢复且不重复请求', async () => {
  const bundle = await readFile('dist/content.js', 'utf8');
  const cache = new Map<string, any>();
  let fetchCount = 0;
  const open = () => {
    const w = new Window({ url: 'https://www.nodeseek.com/?sortBy=replyTime' });
    w.document.write(listHTML());
    const snap = {
      settings: { ...DEFAULTS, profiles: false, hot: false },
      rules: [],
      phrases: [],
      progress: [],
    };
    Object.assign(w, {
      chrome: {
        runtime: {
          sendMessage: async (m: any) => {
            const p = m.payload || {};
            let result: any = true;
            if (m.type === 'snapshot') result = snap;
            if (m.type === 'cacheGet') result = cache.get(p.kind + '|' + p.key) || null;
            if (m.type === 'cachePut') cache.set(p.kind + '|' + p.key, structuredClone(p.value));
            if (m.type === 'lease') result = { token: 'lease' };
            return { ok: true, result };
          },
          onMessage: { addListener: () => {} },
        },
      },
      fetch: async (url: any) => {
        fetchCount++;
        const n = Number(String(url).match(/page-(\d+)/)?.[1] || 1);
        return new Response(listHTML(n), { status: 200 });
      },
    });
    w.eval(bundle);
    return w;
  };
  const w = open();
  await until(() => !!w.document.querySelector('.nf-pager'));
  await delay(30);
  const load = [...w.document.querySelectorAll('.nf-btn')].find(
    (x) => x.textContent === '加载下一页',
  ) as any;
  load.click();
  await until(() => w.document.querySelectorAll('.post-list-item').length >= 4);
  assert.equal(
    new Set([...w.document.querySelectorAll('.post-title a')].map((e) => e.getAttribute('href')))
      .size,
    w.document.querySelectorAll('.post-title a').length,
  );
  w.dispatchEvent(new w.Event('pagehide'));
  await delay(40);
  assert.ok([...cache.keys()].some((k) => k.startsWith('session|')));
  await w.happyDOM.abort();
  const count = fetchCount;
  const w2 = open();
  await until(() => w2.document.querySelectorAll('.post-list-item').length >= 4);
  assert.equal(fetchCount, count);
  await w2.happyDOM.abort();
  // A pre-0.1.1 cache must be upgraded without losing saved page URLs.
  for (const [k, v] of cache)
    if (v.items) {
      delete v.renderer;
      for (const item of v.items) delete item.shell;
    }
  const w3 = open();
  await until(() => w3.document.querySelectorAll('.post-list-item img').length >= 4);
  assert.ok(fetchCount > count);
  await w3.happyDOM.abort();
});
test('IndexedDB 页面与评论持久写入、账号隔离和容量淘汰', async () => {
  Object.assign(globalThis, { indexedDB });
  await setRow('a|page|one', 'page', 'a', { items: ['a'] });
  await setRow('b|page|one', 'page', 'b', { items: ['b'] });
  assert.equal((await getRow('a|page|one'))?.value.items[0], 'a');
  assert.equal((await getRow('b|page|one'))?.value.items[0], 'b');
  await removeRows(['a|page|one']);
  assert.equal(await getRow('a|page|one'), undefined);
  assert.ok(await getRow('b|page|one'));
  await prune(0, 7);
  assert.equal((await rows()).length, 0);
});
test('内容脚本集成：评论续页原生菜单按 ID 挂接，刷新恢复后引用指向正确楼层', async () => {
  const bundle = await readFile('dist/content.js', 'utf8');
  const bridge = await readFile('dist/bridge.js', 'utf8');
  const cache = new Map<string, any>();
  let fetchCount = 0;
  const open = () => {
    const w = new Window({ url: 'https://www.nodeseek.com/post-101-1' });
    w.document.write(postHTML());
    Object.assign(w, {
      chrome: {
        runtime: {
          sendMessage: async (m: any) => {
            const p = m.payload || {};
            let result: any = true;
            if (m.type === 'snapshot')
              result = {
                settings: { ...DEFAULTS, profiles: false },
                rules: [],
                phrases: [],
                progress: [],
              };
            if (m.type === 'cacheGet') result = cache.get(p.kind + '|' + p.key) || null;
            if (m.type === 'cachePut') cache.set(p.kind + '|' + p.key, structuredClone(p.value));
            if (m.type === 'lease') result = { token: 'token' };
            return { ok: true, result };
          },
          onMessage: { addListener: () => {} },
        },
      },
      fetch: async (url: any) => {
        fetchCount++;
        return new Response(postHTML(Number(String(url).match(/post-101-(\d+)/)?.[1] || 1)));
      },
    });
    w.eval(nativeMock());
    w.eval(bridge);
    w.eval(bundle);
    return w;
  };
  const w = open();
  await until(() => !!w.document.querySelector('.nf-pager'));
  await delay(20);
  (
    [...w.document.querySelectorAll('.nf-btn')].find((e) => e.textContent === '加载下一页') as any
  ).click();
  await until(() => w.document.querySelectorAll('.comments > .content-item').length >= 5);
  assert.equal(w.document.querySelectorAll('[data-comment-id="1042"]').length, 1);
  await until(() => !!w.document.querySelector('[data-comment-id="1003"] .comment-menu'));
  assert.match(w.document.querySelector('[id="3"] article')?.textContent || '', /第 3 楼/);
  (w.document.querySelector('[data-comment-id="1003"] [title="引用"]') as any).click();
  await until(() => !!(w.document.querySelector('textarea') as any).value);
  assert.match((w.document.querySelector('textarea') as any).value, /#3/);
  w.dispatchEvent(new w.Event('pagehide'));
  await delay(40);
  await w.happyDOM.abort();
  const count = fetchCount;
  const w2 = open();
  await until(() => w2.document.querySelectorAll('.comments > .content-item').length >= 5);
  assert.equal(fetchCount, count);
  await until(() => !!w2.document.querySelector('[data-comment-id="1003"] .comment-menu'));
  assert.match(w2.document.querySelector('[id="3"] article')?.textContent || '', /第 3 楼/);
  assert.equal(
    (w2.document.querySelector('[data-comment-id="1003"] .comment-menu') as any).dataset
      .testCommentId,
    '1003',
  );
  (w2.document.querySelector('[data-comment-id="1004"] [title="回复"]') as any).click();
  assert.match((w2.document.querySelector('textarea') as any).value, /#4/);
  await w2.happyDOM.abort();
});
test('过期资料先显示，网络刷新未完成时保留旧值', async () => {
  const bundle = await readFile('dist/content.js', 'utf8');
  const w = new Window({ url: 'https://www.nodeseek.com/post-101-1' });
  w.document.write(postHTML());
  const callbacks: any[] = [];
  class IO {
    callback: any;
    constructor(cb: any) {
      this.callback = cb;
      callbacks.push(this);
    }
    observe(target: any) {
      if (target.matches('.author-name')) this.callback([{ target, isIntersecting: true }]);
    }
    unobserve() {}
    disconnect() {}
  }
  let started = false;
  let resolveFetch: any;
  const waiting = new Promise<Response>((r) => (resolveFetch = r));
  Object.assign(w, {
    IntersectionObserver: IO,
    chrome: {
      runtime: {
        sendMessage: async (m: any) => {
          let result: any = true;
          if (m.type === 'snapshot')
            result = {
              settings: { ...DEFAULTS, profiles: true },
              rules: [],
              phrases: [],
              progress: [],
            };
          if (m.type === 'cacheGet')
            result =
              m.payload.kind === 'profile'
                ? { at: Date.now() - 172800000, detail: { rank: 2, coin: 100, nPost: 5 } }
                : null;
          if (m.type === 'lease') result = { token: 't' };
          return { ok: true, result };
        },
        onMessage: { addListener: () => {} },
      },
    },
    fetch: async () => {
      started = true;
      return waiting;
    },
  });
  w.eval(bundle);
  await until(() => started);
  assert.match(w.document.querySelector('.nf-profile')?.textContent || '', /鸡腿 100/);
  resolveFetch(
    new Response(JSON.stringify({ success: true, detail: { rank: 3, coin: 150, nPost: 6 } })),
  );
  await until(() => w.document.querySelector('.nf-profile')?.textContent?.includes('150') || false);
  await w.happyDOM.abort();
});
test('下一页 403 后暂停自动重试，已有评论不丢失', async () => {
  const bundle = await readFile('dist/content.js', 'utf8');
  const w = new Window({ url: 'https://www.nodeseek.com/post-101-1' });
  w.document.write(postHTML());
  let requests = 0;
  let releases: any[] = [];
  Object.assign(w, {
    chrome: {
      runtime: {
        sendMessage: async (m: any) => {
          let result: any = true;
          if (m.type === 'snapshot')
            result = {
              settings: { ...DEFAULTS, profiles: false },
              rules: [],
              phrases: [],
              progress: [],
            };
          if (m.type === 'cacheGet') result = null;
          if (m.type === 'lease') result = { token: 't' };
          if (m.type === 'release') releases.push(m.payload);
          return { ok: true, result };
        },
        onMessage: { addListener: () => {} },
      },
    },
    fetch: async () => {
      requests++;
      return new Response('Forbidden', { status: 403 });
    },
  });
  w.eval(bundle);
  await until(() => !!w.document.querySelector('.nf-pager'));
  await delay(20);
  (
    [...w.document.querySelectorAll('.nf-btn')].find((e) => e.textContent === '加载下一页') as any
  ).click();
  await until(() => !!w.document.querySelector('.nf-pager')?.textContent?.includes('403'));
  assert.equal(requests, 1);
  assert.equal(w.document.querySelectorAll('.comments > .content-item').length, 3);
  assert.equal(releases[0].status, 403);
  await delay(30);
  assert.equal(requests, 1);
  await w.happyDOM.abort();
});
test('后台集成：消息边界、跨页请求租约、账号/标签页缓存隔离、密钥不导出', async () => {
  Object.assign(globalThis, { indexedDB });
  const local: any = {},
    session: any = {};
  let listener: any;
  let denyWrite = false;
  const area = (data: any) => ({
    setAccessLevel: async () => {},
    get: async (keys: any) => {
      const result: any = {};
      for (const k of typeof keys === 'string'
        ? [keys]
        : Array.isArray(keys)
          ? keys
          : Object.keys(keys || data))
        result[k] = structuredClone(data[k]);
      return result;
    },
    set: async (values: any) => {
      if (denyWrite && data === local) throw Error('模拟存储空间不足');
      Object.assign(data, structuredClone(values));
    },
    remove: async (key: string) => {
      delete data[key];
    },
  });
  Object.assign(globalThis, {
    chrome: {
      storage: { local: area(local), session: area(session) },
      runtime: {
        id: 'test',
        getURL: (p: string) => 'chrome-extension://test/' + p,
        onMessage: { addListener: (fn: any) => (listener = fn) },
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        openOptionsPage: async () => {},
      },
      tabs: { query: async () => [], sendMessage: async () => {} },
      alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener: () => {} } },
      action: { onClicked: { addListener: () => {} } },
      permissions: { contains: async () => true },
    },
  });
  await import('../src/background');
  const sender = { id: 'test', url: 'chrome-extension://test/flow-settings.html' };
  const site = (id: number) => ({ id: 'test', url: 'https://www.nodeseek.com/', tab: { id } });
  const call = (type: string, payload: any = {}, from: any = sender) =>
    new Promise<any>((resolve) => listener({ type, payload }, from, resolve));
  const first = await call('snapshot');
  assert.equal(first.ok, true);
  assert.equal(first.result.settings.theme, 'system');
  assert.equal((await call('davInfo', {}, site(1))).ok, false);
  assert.equal((await call('snapshot', {}, { id: 'other', url: sender.url })).ok, false);
  const lease = await call('lease', {}, site(1));
  assert.ok(lease.result.token);
  assert.ok((await call('lease', {}, site(2))).result.wait > 0);
  assert.equal((await call('release', { token: lease.result.token }, site(2))).result, false);
  await call('release', { token: lease.result.token, status: 429 }, site(1));
  assert.equal((await call('lease', {}, site(2))).ok, false);
  await call(
    'cachePut',
    { account: '1', kind: 'page', key: 'page', value: { text: '账号一' } },
    site(1),
  );
  assert.equal(
    (await call('cacheGet', { account: '2', kind: 'page', key: 'page' }, site(2))).result,
    null,
  );
  await call('cachePut', { account: '1', kind: 'session', key: 'home', value: { at: 1 } }, site(1));
  assert.equal(
    (await call('cacheGet', { account: '1', kind: 'session', key: 'home' }, site(2))).result,
    null,
  );
  await call('edit', { collection: 'settings', key: 'theme', value: 'dark' });
  denyWrite = true;
  assert.equal(
    (await call('edit', { collection: 'settings', key: 'theme', value: 'light' })).ok,
    false,
  );
  denyWrite = false;
  assert.equal((await call('snapshot')).result.settings.theme, 'dark');
  assert.equal((await call('importApply', { data: { quickPhrases: ['导入测试短语'] } })).ok, true);
  assert.equal((await call('snapshot')).result.phrases.length, 1);
  assert.equal((await call('recoveryRestore')).ok, true);
  assert.equal((await call('snapshot')).result.phrases.length, 0);
  assert.equal((await call('snapshot')).result.settings.theme, 'dark');
  assert.equal(
    (
      await call('davSave', {
        url: 'https://example.test/private/',
        username: 'user',
        password: 'SECRET-TEST',
        progress: false,
      })
    ).ok,
    true,
  );
  assert.ok(!JSON.stringify((await call('export')).result).includes('SECRET-TEST'));
  assert.ok(!JSON.stringify((await call('davInfo')).result).includes('SECRET-TEST'));
  assert.equal(
    (
      await call('davSave', {
        url: 'https://different.test/private/',
        username: 'user',
        password: '',
        progress: false,
      })
    ).ok,
    false,
  );
});

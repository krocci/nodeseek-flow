import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { DEFAULTS, importLegacy, ruleMatch, type Rule } from '../src/core';
import { parsePage, renderItem, safeShell, upgradePage, RENDERER } from '../src/adapter';
import { listHTML, postHTML } from './fixtures.mjs';

// Independent desktop-only regression suite. No browser, forum or DAV requests.
const artifacts = process.env.NSFLOW_REVIEW_BUNDLE_DIR || resolve('dist');
const content = await readFile(resolve(artifacts, 'content.js'), 'utf8');
const options = await readFile(resolve(artifacts, 'options.js'), 'utf8');
const pause = (n = 10) => new Promise(r => setTimeout(r, n));
async function until(fn: () => unknown, label = 'condition') {
  for (let n = 0; n < 150; n++) { if (fn()) return; await pause(); }
  assert.ok(fn(), 'timeout: ' + label);
}
function useDOM() {
  const w = new Window({ url: 'https://www.nodeseek.com/' });
  Object.assign(globalThis, { document: w.document, DOMParser: w.DOMParser });
  return w;
}
const ids = (w: Window) => [...w.document.querySelectorAll('.post-list>.post-list-item .post-title a')]
  .map(e => e.getAttribute('href')!.match(/post-(\d+)/)?.[1]);
const click = (w: Window, text: string) => {
  const b = [...w.document.querySelectorAll('button')].find(e => e.textContent === text);
  assert.ok(b, 'missing button: ' + text); b.click();
};
function backend() {
  const cache = new Map<string, any>();
  const writes: any[] = [];
  const b = { cache, writes, beforePut: null as null | ((p: any, tab: number) => Promise<void>) };
  return b;
}
const cacheKey = (tab: number, p: any) => p.account + '|' + p.kind + '|' + (p.kind === 'session' ? tab + '|' : '') + p.key;
const pointer = (b: ReturnType<typeof backend>, tab = 1) => [...b.cache.entries()].find(([k]) => k.startsWith('999|session|' + tab + '|list:'))?.[1];
const newHome = () => listHTML().replaceAll('post-101-1', 'post-999-1').replaceAll('给阅读留一点空间', '新服务器首屏');
async function open(b: ReturnType<typeof backend>, cfg: any = {}) {
  const tab = cfg.tab || 1;
  const w = new Window({ url: cfg.url || 'https://www.nodeseek.com/?sortBy=replyTime' });
  w.document.write(cfg.html || listHTML());
  if (cfg.fast) for (const [k, v] of Object.entries(cfg.fast)) w.sessionStorage.setItem(k, String(v));
  let snap: any = { settings: { ...DEFAULTS, profiles: false, hot: false }, rules: cfg.rules || [], phrases: [], progress: [] };
  const listeners: Function[] = [];
  const requests: string[] = [];
  Object.assign(w, {
    chrome: { runtime: { sendMessage: async (m: any) => {
      const p = m.payload || {}; let result: any = true;
      try {
        if (m.type === 'snapshot') result = snap;
        if (m.type === 'cacheGet') result = structuredClone(b.cache.get(cacheKey(tab, p)) || null);
        if (m.type === 'cachePut') {
          await b.beforePut?.(p, tab);
          b.cache.set(cacheKey(tab, p), structuredClone(p.value));
          b.writes.push({ tab, ...structuredClone(p) });
        }
        if (m.type === 'lease') result = { token: 'local-only' };
        return { ok: true, result };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    }, onMessage: { addListener: (fn: Function) => listeners.push(fn) } } },
    fetch: async (url: any) => {
      requests.push(String(url));
      const html = cfg.fetch ? await cfg.fetch(String(url)) : String(url).includes('/post-') ? postHTML(2) : listHTML(2);
      return new Response(html);
    },
  });
  w.eval(content);
  await until(() => !!w.document.querySelector('.nf-pager'), 'pager');
  await pause(40);
  return { w, requests, updateRules: async (rules: any[]) => {
    snap = { ...snap, rules };
    listeners.forEach(fn => fn({ type: 'flow:changed' })); await pause(40);
  } };
}
async function close(w: Window) { await w.happyDOM.abort(); }

test('desktop renderer3 keeps article/text/media and strips active markup through repeated sanitation', () => {
  const w = useDOM();
  const hostile = '<section><article class="post-content" onclick="attack()"><x-safe><p>正文<b>粗体</b></p></x-safe><img src="/ok.png" onerror="attack()"><a href="javascript:attack()">链接</a><script>attack()</script><iframe src="/bad"></iframe><template>模板污染</template><svg><foreignObject><p>外部污染</p></foreignObject><use href="https://evil.test/a.svg#x"></use></svg></article></section>';
  const twice = safeShell(safeShell(hostile, w.location.href), w.location.href);
  const d = w.document.createElement('div'); d.innerHTML = twice;
  assert.equal(RENDERER, 4);
  assert.match(d.querySelector('article')!.textContent, /正文粗体/);
  assert.equal(d.querySelector('img')!.src, 'https://www.nodeseek.com/ok.png');
  assert.equal(d.querySelectorAll('script,iframe,template,foreignObject,[onclick],[onerror]').length, 0);
  assert.equal(d.querySelector('a')!.getAttribute('href'), null);
  assert.doesNotMatch(d.textContent, /模板污染|外部污染|attack/);
});

test('desktop v2 cache upgrade repairs missing body without mutating cached input or refetching', () => {
  const w = useDOM(); w.document.write(postHTML(2));
  const p = parsePage(w.document as any, 'https://www.nodeseek.com/post-101-2');
  p.renderer = 2;
  for (const i of p.items) i.shell = i.shell!.replace(/<article\b[^>]*>[\s\S]*?<\/article>/g, '');
  const old = JSON.stringify(p); const upgraded = upgradePage(p)!;
  assert.equal(upgraded.renderer, RENDERER); assert.equal(JSON.stringify(p), old);
  for (const i of upgraded.items) {
    const dom = renderItem(i);
    assert.ok(dom.querySelector('article.post-content'));
    assert.match(dom.querySelector('.post-content')!.textContent!, new RegExp('第 ' + i.floor + ' 楼'));
    assert.ok(dom.querySelector('img.avatar-normal'));
    assert.equal(dom.querySelectorAll('.post-content').length, 1);
  }
});

test('desktop main0 parsed separately and renderer repair does not duplicate existing article', () => {
  const w = useDOM(); w.document.write(postHTML());
  const p = parsePage(w.document as any, 'https://www.nodeseek.com/post-101-1');
  assert.equal(p.main?.floor, 0); assert.ok(p.items.every(i => i.floor !== 0));
  for (const i of p.items) assert.equal(renderItem(i).querySelectorAll('article.post-content').length, 1);
});

test('desktop repeated restore stays on committed snapshot after server first page changes', async () => {
  const b = backend(); let { w } = await open(b);
  try {
    click(w, '加载下一页'); await until(() => pointer(b)?.urls.length === 2, 'two-page snapshot');
    assert.deepEqual(ids(w), ['101', '102', '103', '104']);
  } finally { await close(w); }
  for (let pass = 0; pass < 3; pass++) {
    ({ w } = await open(b, { html: newHome() }));
    try { assert.deepEqual(ids(w), ['101', '102', '103', '104']); }
    finally { await close(w); }
  }
});

test('desktop other-tab shared page write cannot replace a committed reading snapshot', async () => {
  const b = backend(); const a = await open(b, { tab: 11 });
  click(a.w, '加载下一页'); await until(() => pointer(b, 11)?.urls.length === 2);
  await close(a.w);
  const other = await open(b, { tab: 22, html: newHome() }); await close(other.w);
  const restored = await open(b, { tab: 11, html: newHome() });
  try { assert.deepEqual(ids(restored.w), ['101', '102', '103', '104']); }
  finally { await close(restored.w); }
});

test('desktop snapshot write failure keeps old durable and synchronous pointers; retry recovers', async () => {
  const b = backend(); const { w } = await open(b);
  try {
    await until(() => pointer(b)); const initial = structuredClone(pointer(b));
    b.beforePut = async p => { if (p.kind === 'session' && p.key.startsWith('snapshot:') && p.key.includes('/page-2')) throw Error('quota-test'); };
    click(w, '加载下一页'); await until(() => ids(w).length === 4);
    await until(() => w.document.querySelector('#nf-toast')?.textContent?.includes('quota-test'));
    assert.deepEqual(pointer(b).urls, initial.urls);
    for (let n = 0; n < w.sessionStorage.length; n++) {
      const raw = w.sessionStorage.getItem(w.sessionStorage.key(n)!)!;
      assert.deepEqual(JSON.parse(raw).urls, initial.urls);
    }
    b.beforePut = null; w.dispatchEvent(new w.Event('pagehide'));
    await until(() => pointer(b).urls.length === 2);
  } finally { await close(w); }
});

test('desktop pagehide during delayed snapshot never publishes dangling page references', async () => {
  const b = backend(); const { w } = await open(b); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; }); let blocked = false;
  try {
    await until(() => pointer(b));
    b.beforePut = async p => { if (p.kind === 'session' && p.key.startsWith('snapshot:') && p.key.includes('/page-2')) { blocked = true; await gate; } };
    click(w, '加载下一页'); await until(() => blocked);
    w.dispatchEvent(new w.Event('pagehide')); await pause(20);
    assert.equal(pointer(b).urls.length, 1);
    for (let n = 0; n < w.sessionStorage.length; n++) assert.equal(JSON.parse(w.sessionStorage.getItem(w.sessionStorage.key(n)!)!).urls.length, 1);
    release(); await until(() => pointer(b).urls.length === 2);
    for (const u of pointer(b).urls) assert.ok(b.cache.has('999|session|1|snapshot:' + pointer(b).snapshot + ':' + u));
  } finally { release(); await close(w); }
});

test('desktop explicit latest commits fresh snapshot and pagehide cannot overwrite it', async () => {
  const b = backend(); const { w } = await open(b, { fetch: () => newHome() });
  try {
    await until(() => pointer(b));
    click(w, '检查更新'); await until(() => [...w.document.querySelectorAll('button')].some(e => e.textContent === '发现更新 · 点击查看最新'));
    assert.deepEqual(ids(w), ['101', '102']); const old = pointer(b).snapshot;
    click(w, '发现更新 · 点击查看最新'); await until(() => pointer(b).snapshot !== old);
    const fresh = structuredClone(pointer(b)); w.dispatchEvent(new w.Event('pagehide')); await pause(60);
    assert.equal(pointer(b).snapshot, fresh.snapshot);
    assert.deepEqual(pointer(b).urls, fresh.urls);
    assert.deepEqual(pointer(b).boundary, fresh.boundary);
    assert.deepEqual(ids(w), ['999', '101', '102']);
    assert.deepEqual(b.cache.get('999|session|1|snapshot:' + fresh.snapshot + ':' + fresh.urls[0]).items.map((i: any) => i.id), ['999', '101', '102']);
  } finally { await close(w); }
});

test('desktop explicit latest pointer failure leaves old session and permits retry', async () => {
  const b = backend(); const { w } = await open(b, { fetch: () => newHome() });
  try {
    await until(() => pointer(b)); const old = structuredClone(pointer(b));
    click(w, '检查更新'); await until(() => [...w.document.querySelectorAll('button')].some(e => e.textContent === '发现更新 · 点击查看最新'));
    b.beforePut = async p => { if (p.kind === 'session' && !p.key.startsWith('snapshot:') && p.value.snapshot !== old.snapshot) throw Error('pointer-failure'); };
    click(w, '发现更新 · 点击查看最新'); await until(() => w.document.querySelector('#nf-toast')?.textContent?.includes('pointer-failure'));
    assert.equal(pointer(b).snapshot, old.snapshot);
    assert.equal([...w.document.querySelectorAll('button')].find(e => e.textContent === '发现更新 · 点击查看最新')!.disabled, false);
    b.beforePut = null; click(w, '发现更新 · 点击查看最新'); await until(() => pointer(b).snapshot !== old.snapshot);
  } finally { await close(w); }
});

test('desktop latest detection includes main-post body-only edits', async () => {
  const original = postHTML();
  const changed = original.replace('这是本地模拟文章', '主帖正文已经修改');
  const b = backend(); const { w } = await open(b, { html: original, url: 'https://www.nodeseek.com/post-101-1', fetch: () => changed });
  try {
    click(w, '检查更新'); await pause(100);
    assert.ok([...w.document.querySelectorAll('button')].some(e => e.textContent === '发现更新 · 点击查看最新'), 'main-only edit was missed');
  } finally { await close(w); }
});

test('desktop latest detection includes title-only edits with unchanged IDs and reply counts', async () => {
  const b = backend(); const { w } = await open(b, { fetch: () => listHTML().replace('给阅读留一点空间', '只改标题') });
  try {
    click(w, '检查更新'); await pause(100);
    assert.ok([...w.document.querySelectorAll('button')].some(e => e.textContent === '发现更新 · 点击查看最新'), 'title-only edit was missed');
  } finally { await close(w); }
});

test('desktop legacy scopes retain all eight area combinations without main/comment spillover', () => {
  for (let mask = 0; mask < 8; mask++) {
    const areas = { title: !!(mask & 1), post: !!(mask & 2), comment: !!(mask & 4) };
    const r = importLegacy({ blockedKeywords: ['needle'], blockedKeywordScopes: { needle: areas } })[0].value as Rule;
    assert.deepEqual(r.areas, areas);
    const item = { title: '', body: '', author: '', authorId: '', kind: 'post' as const, floor: 0 };
    assert.equal(ruleMatch(r, { ...item, kind: 'list', title: 'needle' }), areas.title);
    assert.equal(ruleMatch(r, { ...item, title: 'needle' }), areas.title);
    assert.equal(ruleMatch(r, { ...item, body: '<p>needle</p>' }), areas.post);
    assert.equal(ruleMatch(r, { ...item, floor: 3, body: '<p>needle</p>' }), areas.comment);
    assert.equal(ruleMatch(r, { ...item, floor: 3, title: 'needle' }), false);
  }
});

test('desktop legacy partial scopes retain old normalize defaults for omitted fields', () => {
  const r = importLegacy({ blockedKeywords: ['needle'], blockedKeywordScopes: { needle: { title: false } } })[0].value as Rule;
  assert.deepEqual(r.areas, { title: false, post: true, comment: true });
});

test('desktop comment-only blocking does not block main0; post-only blocks main0 only', async () => {
  const html = postHTML().replace('这是本地模拟文章', 'needle 主帖').replaceAll('先看到缓存', 'needle 评论');
  for (const area of ['comment', 'post']) {
    const r = importLegacy({ blockedKeywords: ['needle'], blockedKeywordScopes: { needle: { title: false, post: area === 'post', comment: area === 'comment' } } })[0].value;
    const { w } = await open(backend(), { html, url: 'https://www.nodeseek.com/post-101-1', rules: [{ id: 'r', value: r }] });
    try {
      assert.equal(w.document.querySelector('[id="0"]')!.classList.contains('nf-blocked'), area === 'post');
      assert.equal(w.document.querySelector('[id="1"]')!.classList.contains('nf-blocked'), area === 'comment');
    } finally { await close(w); }
  }
});

test('desktop rule edit preserves disabled flag, group, styles and explicit areas', async () => {
  const w = new Window({ url: 'https://extension.test/flow-settings.html' });
  w.document.write(await readFile('public/flow-settings.html', 'utf8'));
  const rule: Rule = { target: 'keyword', action: 'mark', scope: 'all', text: '旧词', label: '旧组', color: '#123456', enabled: false, group: 'group-x', styles: { showGroupName: false, backgroundColor: { enabled: true, color: '#abcdef' } }, areas: { title: false, post: false, comment: true } };
  let snapshot: any = { settings: { ...DEFAULTS }, overrides: {}, rules: [{ id: 'rule-x', value: rule }], phrases: [], progress: [], conflicts: [], device: 'qa', opCount: 1 };
  let saved: any;
  Object.assign(w, { chrome: { runtime: { sendMessage: async (m: any) => {
    if (m.type === 'snapshot') return { ok: true, result: snapshot };
    if (m.type === 'edit') { saved = m.payload; snapshot = { ...snapshot, rules: [{ id: 'rule-x', value: saved.value }] }; return { ok: true, result: snapshot }; }
    if (m.type === 'davInfo') return { ok: true, result: {} };
    if (m.type === 'cacheInfo') return { ok: true, result: { count: 0, bytes: 0 } };
    return { ok: true, result: true };
  }, onMessage: { addListener() {} } } } });
  w.eval(options);
  try {
    await until(() => !!w.document.querySelector('.rule-group-card')); await pause(30);
    (w.document.querySelector('.rule-group-card') as any).click();
    (w.document.querySelector('.nf-group-members button') as any).click();
    (w.document.querySelector('[name="ruleText"]') as any).value = '新词';
    w.document.querySelector('#rule-form')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => saved);
    assert.equal(saved.value.text, '新词'); assert.equal(saved.value.enabled, false);
    assert.equal(saved.value.group, rule.group); assert.deepEqual(saved.value.styles, rule.styles);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.value.areas)), rule.areas);
  } finally { await close(w); }
});

test('desktop disabling a mark rule removes its previous inline highlight', async () => {
  const rule: Rule = { target: 'keyword', action: 'mark', scope: 'title', text: '阅读', label: 'QA', color: '#123456', styles: { titleColor: { enabled: true, color: '#ff0000' } } };
  const { w, updateRules } = await open(backend(), { rules: [{ id: 'mark', value: rule }] });
  try {
    const title = w.document.querySelector('.post-title a') as any;
    assert.equal(title.style.color, '#ff0000');
    await updateRules([{ id: 'mark', value: { ...rule, enabled: false } }]);
    assert.equal(title.style.color, '', 'disabled rule left inline color behind');
  } finally { await close(w); }
});

test('desktop background CSS contract assigns one token to page/post/banner for all palettes', async () => {
  const css = await readFile('public/content.css', 'utf8');
  // happy-dom drops multiline :is() rules in its stylesheet parser; verify the
  // source declaration contract only. Actual colors, images and specificity
  // require the parent's desktop browser check and are not claimed here.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1], declarations: m[2].replace(/\s+/g, ' ') }));
  for (const selector of ['body', '#nsk-frame', '#nsk-head', '.nsk-post', '.content-item', '.topic-carousel-wrapper', '.topic-carousel-panel']) {
    assert.ok(rules.some(r => r.selector.includes(selector) && r.declarations.includes('background: var(--nf-bg) !important;')), 'missing unified rule: ' + selector);
  }
  for (const theme of ['light', 'dark']) {
    const matching = rules.filter(r => r.selector.includes("data-nf-theme='" + theme + "'") && r.declarations.includes('--nf-bg:'));
    assert.equal(matching.length, 2, theme + ' must have plain and paper definitions');
    for (const r of matching) assert.ok(r.declarations.includes('--nf-panel: var(--nf-bg);'));
  }
});

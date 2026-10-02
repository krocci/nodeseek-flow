import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { DEFAULTS, canonicalPage, routeKey } from '../src/core';
import { type Page, type Item, parsePage, uniqueItems, RENDERER } from '../src/adapter';
import { planRefresh } from '../src/refresh';
import { listHTML, postHTML, nativeMock } from './fixtures.mjs';

// 0.1.3 incremental UI contract. All RPC/network/media are synthetic.
const dir = process.env.NSFLOW_UI_BUNDLE_DIR || resolve('dist');
const bundle = await readFile(resolve(dir, 'content.js'), 'utf8');
const bridge = await readFile(resolve(dir, 'bridge.js'), 'utf8');
const pause = (n = 10) => new Promise(r => setTimeout(r, n));
async function until(fn: () => unknown, message = 'condition') {
  for (let n = 0; n < 180; n++) { if (fn()) return; await pause(); }
  assert.ok(fn(), 'timeout: ' + message);
}
function item(id: number, kind: 'list' | 'post' = 'list', extra: Partial<Item> = {}): Item {
  return { id: String(id), floor: kind === 'post' ? id : 0, url: 'https://www.nodeseek.com/post-' + (kind === 'list' ? id : 101) + '-1#' + id,
    title: '标题' + id, author: '作者', authorId: '12', body: kind === 'post' ? '<p>正文' + id + '</p>' : '', summary: '正文' + id, replies: 0, time: '', kind, ...extra };
}
function page(n: number, rows: Item[], kind: 'list' | 'post' = 'list'): Page {
  const url = canonicalPage('https://www.nodeseek.com/' + (kind === 'post' ? 'post-101-' + n : n === 1 ? '' : 'page-' + n));
  return { renderer: RENDERER, url, route: routeKey(url), mode: 'replyTime', kind, items: rows, next: '', at: Date.now() };
}
function domParse(html: string, url: string) {
  const w = new Window({ url }); w.document.write(html);
  Object.assign(globalThis, { document: w.document, DOMParser: w.DOMParser });
  return parsePage(w.document as any, url);
}
const key = (p: any) => p.account + '|' + p.kind + '|' + (p.kind === 'session' ? '1|' : '') + p.key;
function backend() {
  return { rows: new Map<string, any>(), beforePut: null as null | ((p: any) => Promise<void>), themeCalls: [] as string[], overrides: {} as any };
}
type Backend = ReturnType<typeof backend>;
const pointer = (b: Backend) => [...b.rows.entries()].find(([k]) => k.startsWith('999|session|1|') && !k.includes('|snapshot:'))?.[1];
function seed(b: Backend, pages: Page[], boundary?: any) {
  const s = { urls: pages.map(p => p.url), snapshot: 'seed', anchor: null, at: Date.now(), boundary };
  b.rows.set('999|session|1|' + pages[0].route + '|start:1', s);
  for (const p of pages) b.rows.set('999|session|1|snapshot:seed:' + p.url, structuredClone(p));
}
const ids = (w: Window) => [...w.document.querySelectorAll('.post-list>.post-list-item')].map(e => (e as any).dataset.nfId || e.querySelector('.post-title a')?.getAttribute('href')?.match(/post-(\d+)/)?.[1]);
const click = (w: Window, text: string) => { const e = [...w.document.querySelectorAll('button')].find(e => e.textContent === text); assert.ok(e, text); e.click(); };
const nav = '<div id="fast-nav-button-group"><button class="nav-item-btn" id="native-up">上</button><button class="nav-item-btn" id="native-down">下</button></div>';
async function open(b: Backend, cfg: any = {}) {
  const url = cfg.url || 'https://www.nodeseek.com/?sortBy=replyTime';
  const w = new Window({ url });
  w.document.write(cfg.html || listHTML());
  if (cfg.nav) w.document.body.insertAdjacentHTML('beforeend', nav);
  let legacy = 0;
  const themeControl = w.document.querySelector('.color-theme-switcher') as any;
  themeControl?.addEventListener('click', () => { legacy++; w.document.body.classList.toggle('dark-layout'); });
  const listeners: Function[] = [];
  const mediaCallbacks: Function[] = [];
  const media = { matches: false, addEventListener: (_: string, f: Function) => mediaCallbacks.push(f) };
  const requests: string[] = [];
  const snapshot = () => ({ settings: { ...DEFAULTS, profiles: false, hot: cfg.hot ?? false, ...b.overrides }, rules: [], phrases: [], progress: [] });
  Object.assign(w, {
    matchMedia: () => media,
    chrome: { runtime: { sendMessage: async (m: any) => {
      const p = m.payload || {}; let result: any = true;
      try {
        if (m.type === 'snapshot') result = snapshot();
        if (m.type === 'cacheGet') result = structuredClone(b.rows.get(key(p)) || null);
        if (m.type === 'cachePut') { await b.beforePut?.(p); b.rows.set(key(p), structuredClone(p.value)); }
        if (m.type === 'lease') result = { token: 'ui-qa-only' };
        if (m.type === 'hot') result = { posts: cfg.hotPosts || [{ id: 101, title: 'QA热榜', author: '示例', score: 1 }], at: Date.now() };
        if (m.type === 'themeChoice') { b.themeCalls.push(p.theme); b.overrides.theme = p.theme; }
        return { ok: true, result };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    }, onMessage: { addListener: (f: Function) => listeners.push(f) } } },
    fetch: async (url: any) => {
      requests.push(String(url));
      return new Response(cfg.fetch ? await cfg.fetch(String(url)) : String(url).includes('/post-') ? postHTML(Number(String(url).match(/post-101-(\d+)/)?.[1] || 1)) : listHTML(Number(String(url).match(/page-(\d+)/)?.[1] || 1)));
    },
  });
  if (cfg.native) { w.eval(nativeMock()); w.eval(bridge); }
  w.eval(bundle);
  await until(() => !!w.document.querySelector('#nf-refresh'), 'refresh navigation');
  await pause(45);
  return { w, requests, legacy: () => legacy, mediaChange: async (dark: boolean) => { media.matches = dark; mediaCallbacks.forEach(f => f({ matches: dark })); await pause(20); }, broadcast: async () => { listeners.forEach(f => f({ type: 'flow:changed' })); await pause(30); } };
}
async function close(w: Window) { await w.happyDOM.abort(); }
const freshHome = () => listHTML().replaceAll('post-101-1', 'post-999-1').replace('给阅读留一点空间', '新帖999').replace('自己的小站，慢慢搭建', '更新标题102');
async function refresh(w: Window) { (w.document.querySelector('#nf-refresh') as any).click(); await pause(40); }

test('ui plan prepends new and edited list IDs while retaining old pages/order without mutation', () => {
  const old = [page(1, [item(1), item(2)]), page(2, [item(3), item(4)])];
  const incoming = [page(1, [item(9), item(3, 'list', { replies: 7 }), item(2)])];
  const prior = JSON.stringify(old); const p = planRefresh(old, incoming);
  assert.deepEqual(uniqueItems(p.pages).map(i => i.id), ['9', '3', '1', '2', '4']);
  assert.equal(p.pages.length, 2); assert.deepEqual(p.boundary.ids, ['9', '3']);
  assert.equal(p.boundary.added, 1); assert.equal(p.boundary.edited, 1); assert.equal(JSON.stringify(old), prior);
});

test('ui plan identical repeated refresh has no new changes or duplicate IDs', () => {
  const old = [page(1, [item(1), item(2)]), page(2, [item(3)])];
  const fresh = [page(1, [item(9), item(2)])]; const once = planRefresh(old, fresh);
  const twice = planRefresh(once.pages, fresh);
  assert.equal(twice.changed, false); assert.equal(twice.boundary.added, 0); assert.equal(twice.boundary.edited, 0);
  assert.deepEqual(uniqueItems(twice.pages).map(i => i.id), ['9', '1', '2', '3']);
});

test('ui plan preserves all 40 loaded pages and places incremental list rows before old chain', () => {
  const old = Array.from({ length: 40 }, (_, n) => page(n + 1, [item(n + 1)]));
  const p = planRefresh(old, [page(1, [item(999), item(1)])]);
  assert.equal(p.pages.length, 40); assert.deepEqual(p.pages.map(x => x.url), old.map(x => x.url));
  assert.equal(uniqueItems(p.pages).length, 41); assert.deepEqual(uniqueItems(p.pages).slice(1).map(i => i.id), old.flatMap(p => p.items.map(i => i.id)));
});

test('ui plan updates comment in place and deduplicates repeated hot comments', () => {
  const old = [page(1, [item(42, 'post'), item(1, 'post')], 'post'), page(2, [item(3, 'post')], 'post')];
  const fresh = [page(1, [item(42, 'post'), item(1, 'post', { body: '<p>新正文</p>' })], 'post'), page(2, [item(42, 'post'), item(3, 'post'), item(4, 'post')], 'post')];
  const p = planRefresh(old, fresh);
  assert.deepEqual(uniqueItems(p.pages).map(i => i.id), ['42', '1', '3', '4']);
  assert.equal(p.pages[0].items[1].body, '<p>新正文</p>'); assert.deepEqual(p.boundary.ids, ['4']);
});

test('ui incremental refresh persists divider and restores old pagination; repeated refresh is idempotent', async () => {
  const b = backend(); const old = [1, 2].map(n => domParse(listHTML(n), 'https://www.nodeseek.com/' + (n === 1 ? '?sortBy=replyTime' : 'page-2?sortBy=replyTime'))); seed(b, old);
  let h = await open(b, { nav: true, fetch: () => freshHome() });
  try {
    await refresh(h.w); await until(() => pointer(b)?.boundary);
    assert.deepEqual(ids(h.w), ['999', '102', '101', '103', '104']); assert.equal(pointer(b).urls.length, 2);
    const divider = h.w.document.querySelector('.nf-update-divider')!;
    assert.equal((divider.previousElementSibling as any).dataset.nfId, '102'); assert.equal((divider.nextElementSibling as any).dataset.nfId, '101');
    const boundary = JSON.stringify(pointer(b).boundary); await refresh(h.w);
    await until(() => /当前(页|内容)没有变化/.test(h.w.document.querySelector('#nf-toast')?.textContent || ''), 'no-op refresh completed');
    assert.equal(h.w.document.querySelectorAll('.nf-update-divider').length, 1); assert.equal(JSON.stringify(pointer(b).boundary), boundary);
  } finally { await close(h.w); }
  h = await open(b, { nav: true });
  try { assert.deepEqual(ids(h.w), ['999', '102', '101', '103', '104']); assert.equal(h.w.document.querySelectorAll('.nf-update-divider').length, 1); }
  finally { await close(h.w); }
});

test('ui commit failure keeps visible rows and old boundary/pointer; retry commits atomically', async () => {
  const b = backend(); const h = await open(b, { nav: true, fetch: () => freshHome() });
  try {
    await until(() => pointer(b)); const original = structuredClone(pointer(b));
    b.beforePut = async p => { if (p.kind === 'session' && !p.key.startsWith('snapshot:') && p.value.snapshot !== original.snapshot) throw Error('UI_COMMIT_FAILURE'); };
    await refresh(h.w); await until(() => h.w.document.querySelector('#nf-toast')?.textContent?.includes('UI_COMMIT_FAILURE'));
    assert.deepEqual(ids(h.w), ['101', '102']); assert.equal(h.w.document.querySelectorAll('.nf-update-divider').length, 0); assert.equal(pointer(b).snapshot, original.snapshot);
    assert.equal((h.w.document.querySelector('#nf-refresh') as any).disabled, false);
    b.beforePut = null; await refresh(h.w); await until(() => pointer(b).snapshot !== original.snapshot); assert.deepEqual(ids(h.w), ['999', '102', '101']);
  } finally { await close(h.w); }
});

test('ui loading next page cannot be lost while incremental snapshot commit is pending', async () => {
  const b = backend(); let release!: () => void; const gate = new Promise<void>(r => release = r); let blocked = false;
  const h = await open(b, { nav: true, fetch: (url: string) => url.includes('page-2') ? listHTML(2) : freshHome() });
  try {
    await until(() => pointer(b));
    b.beforePut = async p => { if (p.kind === 'session' && p.key.startsWith('snapshot:') && p.value.items?.some((i: any) => i.id === '999')) { blocked = true; await gate; } };
    (h.w.document.querySelector('#nf-refresh') as any).click(); await until(() => blocked);
    click(h.w, '加载下一页'); await pause(70);
    const appendedDuringCommit = ids(h.w).includes('103'); release();
    await until(() => pointer(b).boundary);
    if (appendedDuringCommit) { assert.ok(ids(h.w).includes('103'), 'refresh overwrote a page appended during commit'); assert.equal(pointer(b).urls.length, 2); }
    else { click(h.w, '加载下一页'); await until(() => ids(h.w).includes('103')); await until(() => pointer(b).urls.length === 2, 'deferred append committed'); assert.equal(pointer(b).urls.length, 2); }
  } finally { release(); await close(h.w); }
});

test('ui comment refresh preserves native menu identity, local state and editor draft', async () => {
  const b = backend(); const changed = postHTML().replace('第 1 楼：先看到缓存', '第 1 楼：已修改正文');
  const h = await open(b, { html: postHTML(), url: 'https://www.nodeseek.com/post-101-1', native: true, nav: true, fetch: () => changed });
  try {
    const menu = h.w.document.querySelector('[data-comment-id="1001"] .comment-menu')!;
    (menu as any).localState = 'keep'; const editor = h.w.document.querySelector('textarea') as any; editor.value = '未提交草稿'; editor.setSelectionRange(2, 4);
    await refresh(h.w); await until(() => pointer(b)?.boundary);
    assert.strictEqual(h.w.document.querySelector('[data-comment-id="1001"] .comment-menu'), menu); assert.equal((menu as any).localState, 'keep');
    assert.strictEqual(h.w.document.querySelector('textarea'), editor); assert.equal(editor.value, '未提交草稿'); assert.equal(editor.selectionStart, 2);
    assert.match(h.w.document.querySelector('[data-comment-id="1001"] article')!.textContent!, /已修改正文/);
  } finally { await close(h.w); }
});

test('ui refresh checks edits on a middle loaded comment page', async () => {
  const b = backend(); const pages = [1, 2, 3].map(n => domParse(postHTML(n), 'https://www.nodeseek.com/post-101-' + n)); seed(b, pages);
  const h = await open(b, { html: postHTML(), url: 'https://www.nodeseek.com/post-101-1', nav: true, native: true, fetch: (url: string) => {
    const n = Number(url.match(/post-101-(\d+)/)?.[1]); return postHTML(n).replace(n === 2 ? '第 3 楼：先看到缓存' : 'NEVERMATCH', '第 3 楼：中间页已修改');
  } });
  try { await refresh(h.w); await until(() => pointer(b)?.snapshot !== 'seed', 'middle-page refresh committed'); assert.match(h.w.document.querySelector('[data-comment-id="1003"] article')!.textContent!, /中间页已修改/, 'refresh skipped a loaded middle page'); }
  finally { await close(h.w); }
});

test('ui refreshing a 40-page comment session never fetches page41 or loses prior pages', async () => {
  const b = backend(); const pages = Array.from({ length: 40 }, (_, n) => page(n + 1, [item(n + 1, 'post')], 'post'));
  seed(b, pages);
  const h = await open(b, { html: postHTML(), url: 'https://www.nodeseek.com/post-101-1', nav: true, fetch: (url: string) => {
    const n = Number(url.match(/post-101-(\d+)/)?.[1]);
    return postHTML(n === 1 ? 1 : 3).replace('</main>', '<div class="nsk-pager"><a rel="next" href="/post-101-41">继续</a></div></main>');
  } });
  try {
    await refresh(h.w); await until(() => pointer(b)?.snapshot !== 'seed', '40-page refresh committed');
    assert.equal(pointer(b).urls.length, 40); assert.equal(new Set(h.requests).size, 40);
    assert.ok(!h.requests.some(u => /post-101-41/.test(u)));
    const committed = pointer(b);
    const kept = committed.urls.flatMap((u: string) => b.rows.get('999|session|1|snapshot:' + committed.snapshot + ':' + u).items.map((i: Item) => i.id));
    for (let id = 1; id <= 40; id++) assert.ok(kept.includes(String(id)), 'lost prior comment ' + id);
  }
  finally { await close(h.w); }
});

test('ui theme capture suppresses old target handler and persists sequential local choices', async () => {
  const b = backend(); const h = await open(b);
  try {
    const control = h.w.document.querySelector('.color-theme-switcher') as any;
    control.click(); assert.equal(h.w.document.documentElement.dataset.nfTheme, 'dark'); assert.equal(h.legacy(), 0);
    control.click(); assert.equal(h.w.document.documentElement.dataset.nfTheme, 'light'); assert.equal(h.legacy(), 0);
    await until(() => b.themeCalls.length === 2); assert.deepEqual(b.themeCalls, ['dark', 'light']);
    h.w.document.body.classList.add('dark-layout'); await pause(30); assert.equal(h.w.document.body.classList.contains('dark-layout'), false);
    await h.broadcast(); assert.equal(h.w.document.documentElement.dataset.nfTheme, 'light');
  } finally { await close(h.w); }
  const reloaded = await open(b); try { assert.equal(reloaded.w.document.documentElement.dataset.nfTheme, 'light'); } finally { await close(reloaded.w); }
});

test('ui system theme continues following media until manual native-button override', async () => {
  const h = await open(backend());
  try {
    await h.mediaChange(true); assert.equal(h.w.document.documentElement.dataset.nfTheme, 'dark');
    await h.mediaChange(false); assert.equal(h.w.document.documentElement.dataset.nfTheme, 'light');
    (h.w.document.querySelector('.color-theme-switcher') as any).click(); assert.equal(h.w.document.documentElement.dataset.nfTheme, 'dark');
    await h.mediaChange(false); assert.equal(h.w.document.documentElement.dataset.nfTheme, 'dark');
  } finally { await close(h.w); }
});

test('ui native navigation gets one refresh button alongside existing arrows and one hot entry', async () => {
  const h = await open(backend(), { nav: true, hot: true });
  try {
    assert.equal(h.w.document.querySelectorAll('#fast-nav-button-group #nf-refresh').length, 1);
    assert.ok(h.w.document.querySelector('#native-up')); assert.ok(h.w.document.querySelector('#native-down'));
    assert.equal(h.w.document.querySelectorAll('#nf-reading-nav').length, 0);
    assert.ok(h.w.document.querySelector('#nf-hot-panel')); assert.equal([...h.w.document.querySelectorAll('#nf-tools button')].filter(e => e.textContent === '热榜').length, 1);
  } finally { await close(h.w); }
});

test('ui absent navigation gets fallback and late native navigation receives the same refresh control', async () => {
  const h = await open(backend());
  try {
    const control = h.w.document.querySelector('#nf-refresh');
    assert.ok(h.w.document.querySelector('#nf-reading-nav #nf-refresh'));
    assert.equal(h.w.document.querySelectorAll('#nf-reading-nav > button').length, 3);
    const toolbar = h.w.document.querySelector('#nf-reading-nav > #nf-tools');
    assert.ok(toolbar);
    assert.equal(toolbar.querySelectorAll('.nf-tools-menu > button').length, 4);
    h.w.document.body.insertAdjacentHTML('beforeend', nav);
    await until(() => !!h.w.document.querySelector('#fast-nav-button-group #nf-refresh'));
    assert.strictEqual(h.w.document.querySelector('#fast-nav-button-group > #nf-tools'), toolbar);
    assert.strictEqual(h.w.document.querySelector('#nf-refresh'), control); assert.equal(h.w.document.querySelectorAll('#nf-refresh').length, 1); assert.equal(h.w.document.querySelectorAll('#nf-reading-nav').length, 0);
  } finally { await close(h.w); }
});

test('ui hot ranking expands all received rows, collapses to ten, and resets on tab change', async () => {
  const h = await open(backend(), { hot: true, hotPosts: Array.from({ length: 25 }, (_, i) => ({ id: i + 1, title: '榜单' + i, author: '示例', score: 25 - i })) });
  try {
    await until(() => h.w.document.querySelectorAll('#nf-hot-panel li').length === 25);
    const visible = () => [...h.w.document.querySelectorAll('#nf-hot-panel li')].filter(e => !e.hasAttribute('hidden')).length;
    assert.equal(visible(), 10);
    click(h.w, '展开全部 ▼'); assert.equal(visible(), 25);
    assert.equal(h.w.document.querySelector('.nf-hot-expand')?.getAttribute('aria-expanded'), 'true');
    click(h.w, '收起榜单 ▲'); assert.equal(visible(), 10);
    click(h.w, '展开全部 ▼'); click(h.w, '日榜');
    await until(() => visible() === 10);
    assert.equal(h.w.document.querySelectorAll('#nf-hot-panel li').length, 25);
  } finally { await close(h.w); }
});

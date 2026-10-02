import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { DEFAULTS, type Entity, type Rule } from '../src/core';
import { listHTML, postHTML } from './fixtures.mjs';

// Runs the main task's built JS and actual CSS. Visibility/geometry need browser QA:
// happy-dom 20.14.5 caches ancestor-class matches after classList changes, and
// :has(.post-title a[href$='/post-832584-1']) incorrectly matches /post-101-1.
// Consequently getComputedStyle(display) is not a reliable visibility oracle here.
const artifacts = process.env.NSFLOW_UI_BUNDLE_DIR || resolve('dist');
const [bundle, css] = await Promise.all(
  ['content.js', 'content.css'].map((name) => readFile(resolve(artifacts, name), 'utf8')),
);
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(predicate: () => unknown, label: string) {
  for (let n = 0; n < 180; n++) {
    if (predicate()) return;
    await pause();
  }
  assert.ok(predicate(), 'timeout: ' + label);
}
const rule = (id: string, text: string, extra: Partial<Rule> = {}): Entity<Rule> => ({
  id,
  conflicts: [],
  value: {
    target: 'keyword',
    text,
    action: 'block',
    scope: 'all',
    label: '测试屏蔽',
    color: '#336699',
    ...extra,
  },
});

async function open(
  t: TestContext,
  rules: Entity<Rule>[],
  options: { post?: boolean; width?: number; hot?: boolean; hiddenSidebar?: boolean } = {},
) {
  const w = new Window({
    url: options.post
      ? 'https://www.nodeseek.com/post-101-1'
      : 'https://www.nodeseek.com/?sortBy=replyTime',
    width: options.width ?? 1024,
    height: 800,
  });
  t.after(() => w.happyDOM.abort());
  w.document.write(options.post ? postHTML() : listHTML());
  const style = w.document.createElement('style');
  style.textContent = css;
  w.document.head.append(style);
  if (options.hiddenSidebar)
    (w.document.querySelector('#nsk-right-panel-container') as any).style.display = 'none';
  const snapshot = {
    settings: { ...DEFAULTS, profiles: false, hot: !!options.hot },
    rules: structuredClone(rules),
    ruleGroups: [],
    phrases: [],
    progress: [],
  };
  const cache = new Map<string, unknown>();
  const messages: any[] = [];
  const listeners: Array<(message: any) => unknown> = [];
  Object.assign(w, {
    chrome: {
      runtime: {
        onMessage: { addListener: (fn: (message: any) => unknown) => listeners.push(fn) },
        sendMessage: async (message: any) => {
          messages.push(structuredClone(message));
          const p = message.payload || {};
          const key = [p.account, p.kind, p.key].join('|');
          let result: unknown = true;
          if (message.type === 'snapshot') result = structuredClone(snapshot);
          if (message.type === 'cacheGet') result = structuredClone(cache.get(key) ?? null);
          if (message.type === 'cachePut') cache.set(key, structuredClone(p.value));
          if (message.type === 'lease') result = { token: 'responsive-blocking-test' };
          if (message.type === 'hot')
            result = {
              posts: [{ id: 900, title: '菜单热榜测试', author: '示例', score: 1 }],
              at: Date.now(),
            };
          return { ok: true, result };
        },
      },
    },
    fetch: async (input: any) => {
      const url = String(input);
      return new Response(
        options.post
          ? postHTML(Number(url.match(/post-101-([0-9]+)/)?.[1] || 1))
          : listHTML(Number(url.match(/page-([0-9]+)/)?.[1] || 1)),
      );
    },
  });
  w.eval(bundle);
  await until(
    () => !!w.document.querySelector('#nf-tools') && !!w.document.querySelector('.nf-pager'),
    'Flow and feed initialized',
  );
  const matched = () => [...w.document.querySelectorAll('.nf-blocked')];
  const toggle = () => {
    const button = w.document.querySelector('#nf-blocked-toggle');
    assert.ok(button, 'global blocked-items control exists');
    assert.equal(button.tagName, 'BUTTON');
    assert.ok(button.closest('#nf-tools .nf-tools-menu'), 'restore belongs to Flow menu');
    return button as any;
  };
  const reveal = (count: number, shown: boolean) => {
    assert.equal(
      toggle().textContent,
      (shown ? '重新隐藏屏蔽项' : '恢复显示屏蔽项') + '（' + count + '）',
    );
    assert.equal(w.document.documentElement.classList.contains('nf-show-blocked'), shown);
  };
  const clickToggle = () => {
    const disclosure = w.document.querySelector('#nf-tools details') as any;
    assert.ok(disclosure);
    disclosure.open = true;
    toggle().click();
  };
  const broadcast = async () => {
    const before = messages.filter((m) => m.type === 'snapshot').length;
    listeners.forEach((fn) => fn({ type: 'flow:changed' }));
    await until(
      () => messages.filter((m) => m.type === 'snapshot').length > before,
      'configuration reloaded',
    );
    await pause();
  };
  const loadNext = () => {
    const button = [...w.document.querySelectorAll('.nf-pager button')].find(
      (b) => b.textContent === '加载下一页',
    );
    assert.ok(button, 'next-page action');
    button.click();
  };
  return { w, snapshot, messages, matched, toggle, reveal, clickToggle, broadcast, loadNext };
}

for (const width of [1024, 560])
  test(
    'blocking ' + width + 'px: global restore preserves matched node, full content and rules',
    async (t) => {
      const h = await open(t, [rule('first', '给阅读'), rule('overlap', '空间')], { width });
      await until(() => h.matched().length === 1, 'one matched row for overlapping rules');
      const row = h.matched()[0];
      const title = row.querySelector('.post-title a')!;
      const author = row.querySelector('.info-author a')!;
      const originalHTML = row.innerHTML;
      const originalRules = structuredClone(h.snapshot.rules);
      assert.ok(row.isConnected);
      assert.equal(h.w.document.querySelectorAll('.post-list-item').length, 2);
      assert.equal(h.w.document.querySelectorAll('.nf-block-toggle').length, 0);
      h.reveal(1, false);
      const before = h.messages.length;
      h.clickToggle();
      await until(
        () => h.w.document.documentElement.classList.contains('nf-show-blocked'),
        'global restore enabled',
      );
      h.reveal(1, true);
      assert.deepEqual(h.matched(), [row], 'restoring must retain matching class');
      assert.strictEqual(row.querySelector('.post-title a'), title);
      assert.strictEqual(row.querySelector('.info-author a'), author);
      assert.equal(row.innerHTML, originalHTML);
      h.clickToggle();
      await until(
        () => !h.w.document.documentElement.classList.contains('nf-show-blocked'),
        'global restore disabled',
      );
      h.reveal(1, false);
      assert.deepEqual(h.snapshot.rules, originalRules);
      assert.deepEqual(
        h.messages
          .slice(before)
          .filter((m) => /^(edit|save|settings|rule|import|sync)/i.test(m.type)),
        [],
        'temporary display must not write configuration',
      );
    },
  );

test('blocking: later pages inherit global restore and hide state, with deduplicated node count', async (t) => {
  const h = await open(t, [rule('author', '12', { target: 'user' })]);
  await until(() => h.matched().length === 2, 'initial rows matched');
  h.clickToggle();
  h.reveal(2, true);
  const first = h.matched()[0];
  h.loadNext();
  await until(() => h.matched().length === 4, 'second page matched, repeated 102 deduplicated');
  h.reveal(4, true);
  assert.ok(h.matched().includes(first));
  for (const row of h.matched())
    assert.ok(row.querySelector('.post-title a'), 'restored rows retain full content');
  h.clickToggle();
  h.reveal(4, false);
  h.loadNext();
  await until(() => h.matched().length === 6, 'third page matched while globally hidden');
  h.reveal(6, false);
  for (const row of h.matched()) assert.ok(row.isConnected, 'hidden rows remain in DOM');
  assert.equal(h.w.document.querySelectorAll('.nf-block-toggle').length, 0);
});

test('blocking: rule removal and disabling update matched count and restore unmatched full rows', async (t) => {
  const h = await open(t, [rule('first', '给阅读'), rule('second', '自己的小站')]);
  await until(() => h.matched().length === 2, 'two rules matched');
  const first = h.w.document.querySelector('[data-nf-id="101"]')!;
  const second = h.w.document.querySelector('[data-nf-id="102"]')!;
  h.snapshot.rules = [h.snapshot.rules[1]];
  await h.broadcast();
  await until(() => h.matched().length === 1, 'removed rule no longer matches');
  h.reveal(1, false);
  assert.equal(first.classList.contains('nf-blocked'), false);
  assert.equal(second.classList.contains('nf-blocked'), true);
  h.snapshot.rules[0].value.enabled = false;
  await h.broadcast();
  await until(() => h.matched().length === 0, 'disabled rule no longer matches');
  assert.equal(second.classList.contains('nf-blocked'), false);
  assert.match(h.toggle().textContent, /（0）$/);
  h.snapshot.rules[0].value.enabled = true;
  await h.broadcast();
  await until(() => h.matched().length === 1, 'reenabled rule matches');
  h.reveal(1, false);
  assert.equal(second.classList.contains('nf-blocked'), true);
  h.clickToggle();
  h.snapshot.rules = [];
  await h.broadcast();
  await until(() => h.matched().length === 0, 'rule removal while showing');
  assert.match(h.toggle().textContent, /（0）$/);
  assert.ok(first.isConnected && second.isConnected);
  assert.equal(first.classList.contains('nf-blocked'), false);
  assert.equal(second.classList.contains('nf-blocked'), false);
});

test('blocking: comments restore full native content and disabling Flow clears hidden state', async (t) => {
  const h = await open(t, [rule('comment', '第 1 楼')], { post: true });
  await until(() => h.matched().length === 1, 'comment matched');
  const row = h.matched()[0];
  const article = row.querySelector('article')!;
  const menu = row.querySelector('.comment-menu')!;
  const editor = h.w.document.querySelector('textarea')!;
  editor.value = '保留未提交草稿';
  let clicks = 0;
  menu.addEventListener('click', () => clicks++);
  h.reveal(1, false);
  h.clickToggle();
  h.reveal(1, true);
  assert.strictEqual(row.querySelector('article'), article);
  assert.strictEqual(row.querySelector('.comment-menu'), menu);
  (menu as any).click();
  assert.equal(clicks, 1);
  h.clickToggle();
  h.reveal(1, false);
  h.snapshot.settings.enabled = false;
  await h.broadcast();
  await until(() => !h.w.document.querySelector('#nf-tools'), 'Flow disabled');
  assert.equal(h.matched().length, 0);
  assert.equal(h.w.document.documentElement.classList.contains('nf-show-blocked'), false);
  assert.ok(row.isConnected);
  assert.strictEqual(row.querySelector('article'), article);
  assert.strictEqual(h.w.document.querySelector('textarea'), editor);
  assert.equal(editor.value, '保留未提交草稿');
  assert.equal(h.w.document.querySelectorAll('.nf-block-toggle').length, 0);
});

test('blocking: disabling Flow while globally restored clears the temporary root class', async (t) => {
  const h = await open(t, [rule('first', '给阅读')]);
  await until(() => h.matched().length === 1, 'row matched');
  const row = h.matched()[0];
  h.clickToggle();
  h.reveal(1, true);
  h.snapshot.settings.enabled = false;
  await h.broadcast();
  await until(() => !h.w.document.querySelector('#nf-tools'), 'Flow disabled');
  assert.equal(h.w.document.documentElement.classList.contains('nf-show-blocked'), false);
  assert.equal(h.matched().length, 0);
  assert.ok(row.isConnected);
});

test('responsive: hidden right sidebar retains Flow hot-ranking dialog access', async (t) => {
  const h = await open(t, [], { width: 560, hot: true, hiddenSidebar: true });
  const disclosure = h.w.document.querySelector('#nf-tools details') as any;
  assert.ok(disclosure);
  disclosure.open = true;
  const menu = h.w.document.querySelector('#nf-tools .nf-tools-menu')!;
  // Prefer a stable ID; the previous hot entry had no ID.
  const hot =
    menu.querySelector('#nf-hot-toggle,#nf-hot-button') ||
    [...menu.querySelectorAll('button')].find((b) => b.textContent === '热榜');
  assert.ok(hot, 'hot ranking remains available in Flow menu');
  (hot as any).click();
  await until(
    () => !!h.w.document.querySelector('dialog[open] .nf-hot li'),
    'hot dialog populated',
  );
  const dialog = h.w.document.querySelector('dialog[open]')!;
  assert.match(dialog.textContent!, /菜单热榜测试/);
  assert.equal(dialog.closest('#nsk-right-panel-container'), null);
  assert.ok(dialog.isConnected && dialog.hasAttribute('open'));
});

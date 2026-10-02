import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { listHTML, postHTML, nativeMock } from '../tests/fixtures.mjs';
const root = resolve(import.meta.dirname, '..');
const siteCSS = await readFile(resolve(root, 'tests/site.css'), 'utf8');
const mock = await readFile(resolve(root, 'tests/mock.js'), 'utf8');
let store = { schema: 1, device: 'preview-device', seq: 0, ops: [] };
const cache = new Map();
let overrides = {};
// Preview uses synthetic data; never contacts a forum or a real WebDAV service.
const core = await import('../.tests/preview-core.mjs');
store = core.edit(store, 'phrases', 'welcome', '谢谢分享！\n\n这是一条本地测试短语。');
store = core.edit(store, 'rules', 'example', {
  target: 'keyword',
  text: '小工具',
  action: 'mark',
  scope: 'all',
  label: '值得一读',
  color: '#347458',
});
function snapshot() {
  return {
    settings: core.settingsFrom(store.ops, { ...overrides, profiles: true }),
    rules: core.entities(store.ops, 'rules'),
    ruleGroups: core.entities(store.ops, 'ruleGroups'),
    phrases: core.entities(store.ops, 'phrases'),
    progress: core.entities(store.ops, 'progress'),
    conflicts: ['settings', 'rules', 'phrases', 'progress'].flatMap((c) =>
      core
        .entities(store.ops, c, true)
        .filter((e) => e.conflicts.length)
        .map((e) => ({ ...e, collection: c })),
    ),
    overrides,
    device: store.device,
    opCount: store.ops.length,
  };
}
async function rpc(m) {
  const p = m.payload || {};
  switch (m.type) {
    case 'attendanceInfo': return { enabled: false, latest: null };
    case 'attendanceConfigure': throw Error('此预览不执行签到，请使用本地专项测试页');
    case 'snapshot':
      return snapshot();
    case 'cacheGet':
      if (p.kind === 'profile')
        return {
          at: Date.now(),
          detail: {
            rank: 4,
            coin: 2345,
            nPost: 123,
            nComment: 678,
            created_at_str: '2 年',
            stardust: 8,
          },
        };
      return cache.get(p.account + '|' + p.kind + '|' + p.key) || null;
    case 'cachePut':
      cache.set(p.account + '|' + p.kind + '|' + p.key, p.value);
      return true;
    case 'cacheInfo':
      return { count: cache.size, bytes: JSON.stringify([...cache]).length };
    case 'cacheClear':
      cache.clear();
      return true;
    case 'lease':
      return { token: 'preview' };
    case 'release':
      return true;
    case 'progress':
      store = core.edit(store, 'progress', p.account + ':' + p.postId, p.value);
      return true;
    case 'edit':
      store = core.edit(store, p.collection, p.key, p.value);
      return snapshot();
    case 'editRuleBatch': {
      let next = store;
      for (const change of p.edits) next = core.edit(next, change.collection, change.key, change.value);
      store = next;
      return snapshot();
    }
    case 'override':
      if (p.value === null) delete overrides[p.key];
      else overrides[p.key] = p.value;
      return snapshot();
    case 'themeChoice':
      overrides.theme = p.theme;
      return true;
    case 'davInfo':
      return { dav: null, syncStatus: null };
    case 'sync':
      throw Error('本地演示不连接远端服务');
    case 'export':
      return { schema: 'nodeseek-flow-backup', version: 1, ops: store.ops };
    case 'hot':
      return {
        posts: [
          { id: '101', title: '热榜示例：让阅读连起来', author: '测试作者', score: 100 },
          { id: '102', title: '来自本地模拟数据', author: '示例', score: 80 },
        ],
        at: Date.now(),
      };
    default:
      throw Error('演示未启用此操作：' + m.type);
  }
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1:4318');
    if (u.pathname.startsWith('/avatar/')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="8" fill="#8250df"/><text x="24" y="33" text-anchor="middle" font-size="28" fill="white">N</text></svg>',
      );
      return;
    }
    if (u.pathname === '/mock-rpc') {
      let b = '';
      for await (const c of req) {
        b += c;
        if (b.length > 6e6) throw Error('too large');
      }
      let result;
      try {
        result = { ok: true, result: await rpc(JSON.parse(b)) };
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
      return;
    }
    if (u.pathname === '/mock.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(mock);
      return;
    }
    if (
      ['/content.js', '/bridge.js', '/options.js', '/content.css', '/options.css'].includes(
        u.pathname,
      )
    ) {
      res.setHeader('Content-Type', u.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(resolve(root, 'dist', u.pathname.slice(1))));
      return;
    }
    let html;
    if (u.pathname === '/flow-settings.html')
      html = (await readFile(resolve(root, 'dist/flow-settings.html'), 'utf8')).replace(
        '<script src="options.js">',
        '<script src="/mock.js"></script><script src="options.js">',
      );
    else {
      const p = Number(u.pathname.match(/(?:page-|post-101-)(\d+)/)?.[1] || 1);
      html = u.pathname.startsWith('/post-')
        ? postHTML(p)
        : listHTML(p, u.searchParams.get('sortBy') || 'replyTime');
      html = html
        .replaceAll('src="/avatar/', 'src="http://127.0.0.1:4318/avatar/')
        .replace(/href="([^\"]+)" rel="next"/g, 'href="https://www.nodeseek.com$1" rel="next"')
        .replace(
          '</head>',
          '<style>' +
            siteCSS +
            '</style><link rel="stylesheet" href="/content.css"><script src="/mock.js"></script></head>',
        )
        .replace(
          '</body>',
          '<script>' +
            nativeMock() +
            '</script><script src="/bridge.js"></script><script src="/content.js"></script></body>',
        );
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e.message));
  }
});
server.listen(4318, '127.0.0.1', () =>
  console.log('Local preview http://127.0.0.1:4318/flow-settings.html (synthetic data only)'),
);

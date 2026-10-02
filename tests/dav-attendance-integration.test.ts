import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import { DEFAULTS, createState, edit } from '../src/core';
import { syncDav } from '../src/dav';
import { attendanceDay } from '../src/attendance';
import { installAttendance } from '../src/attendance-content';

const delay = (n = 10) => new Promise((r) => setTimeout(r, n));
async function until(fn: () => unknown) {
  for (let n = 0; n < 150; n++) {
    if (fn()) return;
    await delay();
  }
  assert.ok(fn(), 'condition timed out');
}
const config = {
  url: 'https://dav.test/dav/',
  username: 'qa',
  password: 'fake',
  enabled: true,
  progress: false,
};
test('DAV compatibility follows GET only; directory and uploads remain strict', async () => {
  const ops = edit(createState('qa'), 'phrases', 'p', 'test').ops;
  let uploaded = '';
  const calls: any[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    calls.push(init);
    if (init?.method === 'PROPFIND') return new Response('<d:multistatus xmlns:d="DAV:"/>');
    if (init?.method === 'PUT') {
      uploaded = String(init.body);
      return new Response('');
    }
    return new Response(uploaded);
  };
  await syncDav({ ...config, oneDriveRedirects: true }, ops, fetcher);
  assert.deepEqual(
    calls.map((c) => [c.method, c.redirect]),
    [
      ['PROPFIND', 'error'],
      ['PUT', 'error'],
      ['GET', 'follow'],
    ],
  );
  assert.ok(calls.every((c) => c.credentials === 'omit'));
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  assert.match(manifest.content_security_policy.extension_pages, /connect-src https:/);
});
test('DAV network, timeout and authentication failures explain the failing stage', async () => {
  for (const [fetcher, expected] of [
    [
      async () => {
        throw new TypeError('Failed to fetch');
      },
      /PROPFIND.*OneDrive/,
    ],
    [
      async () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
      /PROPFIND.*超时/,
    ],
    [async () => new Response('', { status: 401 }), /401.*密码/],
    [async () => new Response('', { status: 404 }), /404.*目录/],
  ] as const)
    await assert.rejects(syncDav(config, [], fetcher as typeof fetch), expected);
});

test('DAV feedback stays beside controls; failure unlocks buttons and clears old preview', async (t) => {
  const w = new Window({ url: 'https://extension.test/flow-settings.html' });
  t.after(() => w.happyDOM.abort());
  w.document.write(await readFile('public/flow-settings.html', 'utf8'));
  let fail = false,
    resolvePreview: ((v: any) => void) | null = null;
  let enabled = false;
  let failAttendanceSave = false;
  let delayAttendanceInfo = false;
  let releaseStaleInfo: (() => void) | undefined;
  Object.assign(w, {
    chrome: {
      permissions: { request: async () => true },
      runtime: {
        sendMessage: async (m: any) => {
          let result: any = true;
          if (m.type === 'snapshot')
            result = {
              settings: DEFAULTS,
              overrides: {},
              rules: [],
              phrases: [],
              progress: [],
              conflicts: [],
              device: 'qa',
              opCount: 0,
            };
          if (m.type === 'davInfo') result = { dav: config };
          if (m.type === 'attendanceInfo') {
            result = { enabled };
            if (delayAttendanceInfo) {
              delayAttendanceInfo = false;
              return new Promise((resolve) => {
                releaseStaleInfo = () => resolve({ ok: true, result });
              });
            }
          }
          if (m.type === 'attendanceConfigure') {
            if (failAttendanceSave) return { ok: false, error: 'QA_ATTENDANCE_SAVE_FAILED' };
            enabled = m.payload.enabled;
          }
          if (m.type === 'cacheInfo') result = { count: 0, bytes: 0 };
          if (m.type === 'davPreview')
            return new Promise((resolve) => {
              resolvePreview = resolve;
            });
          if (m.type === 'sync' || m.type === 'davDisable') {
            if (fail) return { ok: false, error: 'QA_DAV_ERROR' };
          }
          return { ok: true, result };
        },
        onMessage: { addListener() {} },
      },
    },
  });
  w.eval(await readFile('dist/options.js', 'utf8'));
  await until(() => w.document.querySelector('#save-status')?.textContent?.includes('设置已就绪'));
  const globalStatus = w.document.querySelector('#save-status')!.textContent;
  const click = (id: string) => (w.document.getElementById(id) as any).click();
  click('dav-preview');
  await until(() => resolvePreview);
  assert.equal((w.document.getElementById('dav-preview') as any).disabled, true);
  assert.match(w.document.getElementById('dav-status')!.textContent, /读取远端/);
  resolvePreview!({ ok: true, result: { token: 'qa', remoteOps: 1, localOps: 1, conflicts: 0 } });
  await until(() => w.document.querySelector('#dav-confirm button'));
  assert.equal((w.document.getElementById('dav-preview') as any).disabled, false);
  fail = true;
  (w.document.querySelector('#dav-confirm button') as any).click();
  await until(() => w.document.getElementById('dav-status')!.textContent === 'QA_DAV_ERROR');
  assert.equal(w.document.querySelector('#save-status')!.textContent, globalStatus);
  assert.equal((w.document.getElementById('dav-sync') as any).disabled, false);
  click('dav-disable');
  await delay();
  assert.equal(w.document.getElementById('dav-status')!.textContent, 'QA_DAV_ERROR');
  click('dav-preview');
  await until(() => (w.document.getElementById('dav-preview') as any).disabled);
  resolvePreview!({ ok: false, error: 'QA_PREVIEW_ERROR' });
  await until(() => w.document.getElementById('dav-status')!.textContent === 'QA_PREVIEW_ERROR');
  assert.equal(w.document.querySelector('#dav-confirm button'), null);
  click('auto-attendance');
  await until(() => w.document.getElementById('attendance-status')!.textContent.includes('已开启'));
  assert.match(w.document.getElementById('attendance-status')!.textContent, /已开启/);
  failAttendanceSave = true;
  click('auto-attendance');
  await until(() =>
    w.document.getElementById('attendance-status')!.textContent.includes('修改未确认'),
  );
  assert.equal((w.document.getElementById('auto-attendance') as any).checked, true);
  assert.equal(enabled, true);
  failAttendanceSave = false;
  delayAttendanceInfo = true;
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await until(() => releaseStaleInfo);
  click('auto-attendance');
  await until(() => w.document.getElementById('attendance-status')!.textContent.includes('已关闭'));
  releaseStaleInfo!();
  await delay();
  assert.equal((w.document.getElementById('auto-attendance') as any).checked, false);
  assert.match(w.document.getElementById('attendance-status')!.textContent, /已关闭/);
});

test('Background attendance opt-in, global lease, ownership, records and export isolation', async () => {
  let clock = Date.parse('2026-10-01T15:59:59.500Z');
  class Clock extends Date {
    static now() {
      return clock;
    }
  }
  const local: any = {},
    session: any = {};
  let listener: any;
  const area = (data: any) => ({
    setAccessLevel: async () => {},
    get: async (keys: any) =>
      Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(data[k])]),
      ),
    set: async (v: any) => {
      Object.assign(data, structuredClone(v));
    },
  });
  const chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: {
      id: 'qa',
      getURL: (p: string) => 'chrome-extension://qa/' + p,
      onMessage: {
        addListener: (f: any) => {
          listener = f;
        },
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    tabs: { query: async () => [], sendMessage: async () => {} },
    permissions: { contains: async () => true },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
  };
  runInNewContext(await readFile('dist/background.js', 'utf8'), {
    chrome,
    crypto,
    console,
    Date: Clock,
    URL,
    setTimeout,
    clearTimeout,
  });
  const site = (id: number) => ({ id: 'qa', url: 'https://www.nodeseek.com/', tab: { id } });
  const options = { id: 'qa', url: 'chrome-extension://qa/flow-settings.html' };
  const call = (type: string, payload: any = {}, from: any = options) =>
    new Promise<any>((resolve) => listener({ type, payload }, from, resolve));
  assert.equal((await call('attendanceClaim', { account: '12' }, site(1))).result, null);
  assert.equal((await call('attendanceConfigure', { enabled: true }, site(1))).ok, false);
  await call('attendanceConfigure', { enabled: true });
  const token = (await call('attendanceClaim', { account: '12' }, site(1))).result.token;
  assert.ok(token);
  assert.equal((await call('attendanceClaim', { account: '13' }, site(2))).result, null);
  assert.equal((await call('attendanceCheck', { account: '12', token }, site(2))).ok, false);
  const state = {
    account: '12',
    day: attendanceDay(clock),
    status: 'signed',
    checkedAt: Date.now(),
    nextAttempt: 0,
  };
  clock += 1000; // Completion crosses UTC+8 midnight but belongs to the claimed day.
  assert.equal((await call('attendanceWrite', { account: '12', token, state }, site(1))).ok, true);
  assert.equal((await call('attendanceRead', { account: '13' }, site(2))).result, null);
  assert.equal((await call('attendanceRead', { account: '12' }, site(1))).result.status, 'signed');
  assert.ok(!JSON.stringify((await call('export')).result).includes('attendance'));
  await call('attendanceConfigure', { enabled: false });
  assert.equal((await call('attendanceCheck', { account: '12', token }, site(1))).result, false);
  await call('attendanceRelease', { account: '12', token }, site(1));
  assert.equal(session.attendanceLease, null);
});

for (const scenario of [
  'success',
  'error-envelope',
  'stale-account',
  'switch-after-post',
  'nested-error',
  'server-rejected',
  'html-board',
  'already-signed',
  'missing-record-after-post',
  'dom-switch-before-post',
] as const)
  test('Content adapter: ' + scenario, async () => {
    const w = new Window({ url: 'https://www.nodeseek.com/' });
    w.document.write('<meta name="csrf-token" content="qa-csrf">');
    let state: any = null;
    const calls: any[] = [];
    let submitted = false;
    let activeAccount = '12';
    let leases = 0;
    Object.assign(globalThis, {
      document: w.document,
      DOMParser: w.DOMParser,
      chrome: {
        runtime: {
          sendMessage: async (m: any) => {
            let result: any = true;
            if (m.type === 'attendanceClaim') result = { token: 'attendance-token' };
            if (m.type === 'attendanceRead') result = state;
            if (m.type === 'attendanceWrite') state = m.payload.state;
            if (m.type === 'lease') {
              leases++;
              if (scenario === 'dom-switch-before-post' && leases === 2) activeAccount = '13';
              result = { token: 'forum-token' };
            }
            return { ok: true, result };
          },
        },
      },
      fetch: async (url: string, init: any) => {
        calls.push({ url, init });
        assert.notEqual(url, '/', 'attendance must not depend on homepage HTML');
        if (init.method === 'POST') submitted = true;
        if (scenario === 'error-envelope')
          return new Response(JSON.stringify({ error: 'login_required', record: null }));
        if (scenario === 'nested-error')
          return new Response(JSON.stringify({ data: { success: false, record: null } }));
        if (scenario === 'html-board') return new Response('<html>需要网站验证</html>');
        if (url.includes('/api/attendance')) assert.equal(init.headers.Accept, 'application/json');
        if (init.method === 'POST' && scenario === 'server-rejected')
          return new Response(JSON.stringify({ success: false, message: '测试：签到被拒绝' }));
        if (init.method === 'POST' && scenario === 'already-signed')
          return new Response(JSON.stringify({ success: false, message: '今天已完成签到' }));
        return new Response(
          JSON.stringify(
            init.method === 'POST'
              ? { success: true }
              : {
                  list: [],
                  total: 0,
                  record:
                    scenario === 'stale-account' ||
                    (submitted && scenario !== 'missing-record-after-post')
                      ? {
                          member_id:
                            scenario === 'stale-account' || scenario === 'switch-after-post'
                              ? 13
                              : 12,
                          created_at: new Date().toISOString(),
                          gain: 5,
                        }
                      : null,
                  order: null,
                },
          ),
        );
      },
    });
    const scan = installAttendance(
      () => true,
      () => activeAccount,
    );
    scan();
    scan();
    await until(
      () =>
        state?.status === (['success', 'already-signed'].includes(scenario) ? 'signed' : 'failed'),
    );
    const posts = calls.filter((c) => c.init.method === 'POST');
    if (
      [
        'success',
        'switch-after-post',
        'server-rejected',
        'already-signed',
        'missing-record-after-post',
      ].includes(scenario)
    ) {
      assert.equal(posts.length, 1);
      assert.equal(posts[0].url, '/api/attendance?random=false');
      assert.equal(posts[0].init.headers['X-CSRF-Token'], 'qa-csrf');
      assert.equal(posts[0].init.credentials, 'same-origin');
    } else assert.equal(posts.length, 0);
    if (scenario === 'server-rejected') assert.match(state.message, /提交签到.*签到被拒绝/);
    if (scenario === 'html-board') assert.match(state.message, /读取签到记录.*非 JSON/);
    if (scenario === 'stale-account' || scenario === 'switch-after-post')
      assert.match(state.message, /账号不一致/);
    if (scenario === 'missing-record-after-post') assert.match(state.message, /尚未确认当前账号/);
    if (scenario === 'dom-switch-before-post') assert.match(state.message, /账号已改变/);
    await w.happyDOM.abort();
  });

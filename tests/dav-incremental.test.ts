import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';
import { syncDav, compactDav, emptyDavCache, packetHash } from '../src/dav';
import { createState, edit, mergeOps, stable, entities } from '../src/core';
const config = {
  url: 'https://dav.test/dav/flow/',
  username: 'qa',
  password: 'fake',
  enabled: true,
  progress: true,
};
const pause = (n = 1) => new Promise((r) => setTimeout(r, n));
function server() {
  const files = new Map<string, string>();
  const calls: { url: string; method: string }[] = [];
  let hook: ((url: string, method: string) => void) | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input),
      method = init?.method || 'GET';
    calls.push({ url, method });
    hook?.(url, method);
    if (method === 'PROPFIND')
      return new Response(
        '<d:multistatus xmlns:d="DAV:">' +
          [...files.keys()]
            .map(
              (u) =>
                '<d:response><d:href>' +
                new URL(u).pathname +
                '</d:href><d:propstat><d:prop><d:getetag>"same-unreliable-etag"</d:getetag></d:prop></d:propstat></d:response>',
            )
            .join('') +
          '</d:multistatus>',
        { status: 207 },
      );
    if (method === 'PUT') {
      files.set(url, String(init!.body));
      return new Response('', { status: 201 });
    }
    if (method === 'GET')
      return new Response(files.get(url) || '', { status: files.has(url) ? 200 : 404 });
    if (method === 'MKCOL') return new Response('', { status: 201 });
    if (method === 'MOVE') {
      const dest = new Headers(init!.headers).get('Destination')!;
      assert.equal(new Headers(init!.headers).get('Overwrite'), 'F');
      if (!files.has(url)) return new Response('', { status: 404 });
      files.set(dest, files.get(url)!);
      files.delete(url);
      return new Response(null, { status: 201 });
    }
    throw Error('unexpected ' + method);
  };
  const legacy = (name: string, ops: any[]) =>
    files.set(
      config.url + 'flow-' + name + '-old.json',
      JSON.stringify({ schema: 'nodeseek-flow-ops', version: 1, ops }),
    );
  return { files, calls, fetcher, legacy, setHook: (fn: typeof hook) => (hook = fn) };
}
const ops = (device = 'a', key = 'phrase', value: any = 'hello') =>
  edit(createState(device), 'phrases', key, value).ops;
test('DAV immutable delta uses content hash and hot sync requests directory only', async () => {
  const s = server(),
    cache = emptyDavCache();
  const local = ops();
  await syncDav(config, local, s.fetcher, cache);
  assert.match([...s.files.keys()][0], /flow-sha256-[a-f0-9]{64}\.json$/);
  s.calls.length = 0;
  const r = await syncDav(config, local, s.fetcher, cache);
  assert.deepEqual(
    s.calls.map((c) => c.method),
    ['PROPFIND'],
  );
  assert.equal(r.stats.reused, 1);
  assert.equal(r.stats.downloaded, 0);
  assert.deepEqual(r.ops, local);
});
test('DAV preview cache is reused and a later remote delta is still downloaded', async () => {
  const s = server();
  await syncDav(config, ops(), s.fetcher);
  const cache = emptyDavCache();
  await syncDav(config, [], s.fetcher, cache);
  await syncDav(config, ops('b', 'second'), s.fetcher);
  s.calls.length = 0;
  const r = await syncDav(config, [], s.fetcher, cache);
  assert.equal(r.stats.reused, 1);
  assert.equal(r.stats.downloaded, 1);
  assert.equal(r.ops.length, 2);
});
test('DAV legacy files are revalidated despite an unchanged ETag', async () => {
  const s = server(),
    cache = emptyDavCache();
  s.legacy('legacy', ops());
  await syncDav(config, [], s.fetcher, cache);
  s.legacy('legacy', ops('b', 'changed'));
  const r = await syncDav(config, [], s.fetcher, cache);
  assert.equal(r.stats.downloaded, 1);
  assert.equal(r.ops[0].device, 'b');
});
test('DAV corrupt filename hash rejects remote data without PUT', async () => {
  const s = server();
  s.files.set(
    config.url + 'flow-sha256-' + '0'.repeat(64) + '.json',
    JSON.stringify({ schema: 'nodeseek-flow-ops', version: 1, ops: ops() }),
  );
  await assert.rejects(syncDav(config, [], s.fetcher), /SHA-256/);
  assert.ok(!s.calls.some((c) => c.method === 'PUT'));
});
test('DAV corrupt local cache falls back to verified download', async () => {
  const s = server(),
    cache = emptyDavCache();
  await syncDav(config, ops(), s.fetcher, cache);
  Object.values(cache.files)[0].ops[0].value = 'corrupt';
  const r = await syncDav(config, [], s.fetcher, cache);
  assert.equal(r.stats.downloaded, 1);
  assert.equal(r.ops[0].value, 'hello');
});
test('DAV cache is URL scoped and removed files do not become phantom remote data', async () => {
  const s = server(),
    cache = emptyDavCache();
  await syncDav(config, ops(), s.fetcher, cache);
  s.files.clear();
  const r = await syncDav(config, [], s.fetcher, cache);
  assert.equal(r.ops.length, 0);
  assert.equal(Object.keys(cache.files).length, 0);
});
test('DAV compaction retains all operations, tombstones and offline conflicts; no DELETE', async () => {
  const s = server();
  const initial = edit(createState('a'), 'phrases', 'p', 'original');
  const removed = edit(initial, 'phrases', 'p', null);
  const offline = edit({ ...initial, device: 'offline', seq: 0 }, 'phrases', 'other', 'offline');
  s.legacy('one', initial.ops);
  s.legacy('two', removed.ops);
  const result = await compactDav(config, s.fetcher);
  assert.equal(result.archived, 2);
  assert.equal(result.remaining, 1);
  assert.ok(!s.calls.some((c) => c.method === 'DELETE'));
  const restored = await syncDav(config, offline.ops, s.fetcher);
  assert.equal(stable(restored.ops), stable(mergeOps(removed.ops, offline.ops)));
  assert.equal(
    entities(restored.ops, 'phrases').some((x) => x.id === 'p'),
    false,
  );
  assert.equal([...s.files.keys()].filter((u) => u.includes('flow-archive-')).length, 2);
});
test('DAV compaction snapshot must verify before any MOVE', async () => {
  const s = server();
  s.legacy('one', ops());
  s.legacy('two', ops('b'));
  s.setHook((url, method) => {
    if (method === 'GET' && url.includes('flow-sha256-')) s.files.set(url, '{}');
  });
  await assert.rejects(compactDav(config, s.fetcher));
  assert.ok(!s.calls.some((c) => c.method === 'MOVE'));
});
test('DAV compaction keeps files concurrently uploaded after initial listing', async () => {
  const s = server();
  s.legacy('one', ops());
  s.legacy('two', ops('b'));
  s.setHook((_url, method) => {
    if (method === 'MKCOL') s.legacy('later', ops('c'));
  });
  const r = await compactDav(config, s.fetcher);
  assert.equal(r.remaining, 2);
  assert.ok(s.files.has(config.url + 'flow-later-old.json'));
  assert.equal((await syncDav(config, [], s.fetcher)).ops.length, 3);
});
test('DAV partial archive failure preserves snapshot and original logs for next sync', async () => {
  const s = server();
  s.legacy('one', ops());
  s.legacy('two', ops('b'));
  let moves = 0;
  s.setHook((_u, m) => {
    if (m === 'MOVE' && ++moves === 2) throw Error('MOVE interrupted');
  });
  await assert.rejects(compactDav(config, s.fetcher), /WebDAV MOVE/);
  s.setHook(undefined);
  assert.equal((await syncDav(config, [], s.fetcher)).ops.length, 2);
});
test('DAV compaction skips a legacy file changed since initial read', async () => {
  const s = server();
  s.legacy('one', ops());
  s.legacy('two', ops('b'));
  s.setHook((_u, m) => {
    if (m === 'MKCOL') s.legacy('one', ops('c'));
  });
  const r = await compactDav(config, s.fetcher);
  assert.equal(r.archived, 1);
  assert.ok(s.files.has(config.url + 'flow-one-old.json'));
});
test('DAV a GET 404 during another device compaction retries the directory safely', async () => {
  const s = server();
  s.legacy('one', ops());
  let changed = false;
  s.setHook((url, m) => {
    if (m === 'GET' && !changed) {
      changed = true;
      const content = s.files.get(url)!;
      s.files.delete(url);
      s.files.set(config.url + 'flow-new-snapshot.json', content);
    }
  });
  const r = await syncDav(config, [], s.fetcher);
  assert.equal(r.ops.length, 1);
  assert.equal(s.calls.filter((c) => c.method === 'PROPFIND').length, 2);
});
test('DAV background persists preview cache across worker restart and reuses it after confirmation', async () => {
  const s = server();
  await syncDav(config, ops(), s.fetcher);
  const storage: any = { state: createState('local'), dav: config };
  const idb = new IDBFactory();
  const code = await readFile('dist/background.js', 'utf8');
  const area = {
    setAccessLevel: async () => {},
    get: async (keys: any) => {
      const names =
        typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(storage);
      return structuredClone(
        Object.fromEntries(names.filter((k) => k in storage).map((k) => [k, storage[k]])),
      );
    },
    set: async (value: any) => Object.assign(storage, structuredClone(value)),
    remove: async () => {},
  };
  function worker() {
    let listener: any;
    const chrome = {
      storage: { local: area, session: area },
      runtime: {
        id: 'qa',
        getURL: (p: string) => 'chrome-extension://qa/' + p,
        onMessage: { addListener: (f: any) => (listener = f) },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      permissions: { contains: async () => true },
      tabs: { query: async () => [], sendMessage: async () => {} },
      alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
      action: { onClicked: { addListener() {} } },
    };
    runInNewContext(code, {
      chrome,
      indexedDB: idb,
      fetch: s.fetcher,
      crypto,
      console,
      URL,
      Date,
      TextEncoder,
      TextDecoder,
      AbortSignal,
      btoa,
      setTimeout,
      clearTimeout,
    });
    return (type: string, payload: any = {}, site = false) =>
      new Promise<any>((resolve) =>
        listener(
          { type, payload },
          {
            id: 'qa',
            url: site ? 'https://www.nodeseek.com/' : 'chrome-extension://qa/flow-settings.html',
          },
          resolve,
        ),
      );
  }
  let call = worker();
  s.calls.length = 0;
  const first = await call('davPreview');
  assert.equal(first.ok, true, first.error);
  assert.equal(s.calls.filter((c) => c.method === 'GET').length, 1);
  call = worker();
  s.calls.length = 0;
  const second = await call('davPreview');
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(
    s.calls.map((c) => c.method),
    ['PROPFIND'],
  );
  assert.equal((await call('davConfirm', { token: second.result.token })).ok, true);
  s.calls.length = 0;
  const r = await call('sync');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(
    s.calls.map((c) => c.method),
    ['PROPFIND'],
  );
  assert.equal(storage.state.ops.length, 1);
  assert.equal(
    (await call('davCompact', {}, true)).ok,
    false,
    'web page must not invoke remote maintenance',
  );
});

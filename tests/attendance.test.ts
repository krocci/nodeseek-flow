import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAttendance,
  attendanceDay,
  ATTENDANCE_COOLDOWN_MS,
  ATTENDANCE_LOCK,
  type AttendanceDeps,
  type AttendanceState,
  type AttendanceRecord,
} from '../src/attendance.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const f = {
    now: Date.parse('2026-10-01T10:00:00Z'),
    enabled: true,
    visible: true,
    account: 'alice' as string | null,
    locked: false,
    board: null as AttendanceRecord | null,
    rows: new Map<string, AttendanceState>(),
    calls: [] as string[],
  };
  const deps: AttendanceDeps = {
    now: () => f.now,
    readEnabled: async () => f.enabled,
    currentAccount: () => f.account,
    isVisible: () => f.visible,
    readState: async (account) => {
      f.calls.push('read:' + account);
      return structuredClone(f.rows.get(account) ?? null);
    },
    writeState: async (account, state) => {
      assert.equal(account, state.account);
      f.calls.push('write:' + state.status);
      f.rows.set(account, structuredClone(state));
    },
    withLock: async (key, work) => {
      assert.equal(key, ATTENDANCE_LOCK);
      f.calls.push('claim');
      if (f.locked) return undefined;
      f.locked = true;
      try {
        return await work();
      } finally {
        f.locked = false;
        f.calls.push('finish');
      }
    },
    getBoard: async (account) => {
      assert.equal(account, f.account);
      f.calls.push('board');
      return f.board;
    },
    post: async (account, options) => {
      assert.equal(account, f.account);
      assert.deepEqual(options, { random: false });
      assert.equal(f.rows.get(account)?.status, 'pending');
      f.calls.push('post');
      return { success: true };
    },
  };
  return { f, deps, engine: () => createAttendance(deps) };
}

test('UTC+8 date boundary is independent of host timezone', () => {
  assert.equal(attendanceDay(Date.parse('2026-10-01T15:59:59.999Z')), '2026-10-01');
  assert.equal(attendanceDay(Date.parse('2026-10-01T16:00:00Z')), '2026-10-02');
});

for (const mode of ['disabled', 'hidden', 'logged-out', 'blank-account', 'truthy-setting']) {
  test('no RPC/network when ' + mode, async () => {
    const { f, deps, engine } = fixture();
    if (mode === 'disabled') f.enabled = false;
    if (mode === 'hidden') f.visible = false;
    if (mode === 'logged-out') f.account = null;
    if (mode === 'blank-account') f.account = ' ';
    if (mode === 'truthy-setting') deps.readEnabled = async () => 'true' as unknown as boolean;
    assert.equal((await engine().scan()).status, 'skipped');
    assert.deepEqual(f.calls, []);
  });
}

test('checks board and durable guard before fixed POST, persists across reloads without invented gain', async () => {
  const { f, engine } = fixture();
  const result = await engine().scan();
  assert.equal(result.status, 'signed');
  assert.equal(result.state?.day, '2026-10-01');
  assert.equal('gain' in result.state!, false);
  assert.deepEqual(f.calls, [
    'claim',
    'read:alice',
    'write:pending',
    'board',
    'write:pending',
    'post',
    'write:signed',
    'finish',
  ]);
  await engine().scan();
  assert.equal(f.calls.filter((x) => x === 'board').length, 1);
  assert.equal(f.calls.filter((x) => x === 'post').length, 1);
});

test('today board record prevents mutation and preserves only server gain', async () => {
  const { f, engine } = fixture();
  f.board = { createdAt: '2026-10-01T00:00:00+08:00', gain: 7 };
  const result = await engine().scan();
  assert.equal(result.status, 'signed');
  assert.equal(result.state?.gain, 7);
  assert.ok(!f.calls.includes('post'));
});

test('today record with no gain still prevents duplicate POST', async () => {
  const { f, engine } = fixture();
  f.board = { createdAt: '2026-10-01T00:00:00Z' };
  assert.equal((await engine().scan()).status, 'signed');
  assert.equal(f.rows.get('alice')?.gain, undefined);
  assert.ok(!f.calls.includes('post'));
});

test('old record is not today and its reward is not reused', async () => {
  const { f, engine } = fixture();
  f.board = { createdAt: '2026-09-30T00:00:00Z', gain: 99 };
  const result = await engine().scan();
  assert.equal(result.state?.gain, undefined);
  assert.ok(f.calls.includes('post'));
});

for (const createdAt of ['invalid', '2026-10-01T10:00:00']) {
  test('malformed/ambiguous board timestamp fails closed: ' + createdAt, async () => {
    const { f, engine } = fixture();
    f.board = { createdAt };
    assert.equal((await engine().scan()).status, 'failed');
    assert.ok(!f.calls.includes('post'));
    assert.equal((await engine().scan()).status, 'cooldown');
  });
}

for (const change of ['disable', 'account', 'hidden', 'midnight']) {
  test('rechecks immediately before POST after final storage wait: ' + change, async () => {
    const { f, deps, engine } = fixture();
    const write = deps.writeState;
    let count = 0;
    deps.writeState = async (account, state) => {
      await write(account, state);
      if (++count !== 2) return;
      if (change === 'disable') f.enabled = false;
      if (change === 'account') f.account = 'bob';
      if (change === 'hidden') f.visible = false;
      if (change === 'midnight') f.now = Date.parse('2026-10-01T16:00:00Z');
    };
    assert.equal((await engine().scan()).status, 'skipped');
    assert.ok(f.calls.includes('board'));
    assert.ok(!f.calls.includes('post'));
  });
}

for (const stage of ['board', 'post', 'unconfirmed']) {
  test(stage + ' failure persists cooldown and recovery checks board before retry', async () => {
    const { f, deps, engine } = fixture();
    if (stage === 'board')
      deps.getBoard = async () => {
        f.calls.push('board');
        throw new Error('HTTP/parse failure');
      };
    else
      deps.post = async () => {
        f.calls.push('post');
        if (stage === 'post') throw new Error('timeout: server may have committed');
        return { success: false };
      };
    assert.equal((await engine().scan()).status, 'failed');
    const count = f.calls.length;
    assert.equal((await engine().scan()).status, 'cooldown');
    assert.equal(f.calls.length, count + 3);
    assert.equal(f.rows.get('alice')?.status, 'failed');
    f.now += ATTENDANCE_COOLDOWN_MS;
    deps.getBoard = async () => {
      f.calls.push('recovery-board');
      return { createdAt: '2026-10-01T10:00:00Z', gain: 5 };
    };
    const posts = f.calls.filter((x) => x === 'post').length;
    assert.equal((await engine().scan()).status, 'signed');
    assert.ok(f.calls.includes('recovery-board'));
    assert.equal(f.calls.filter((x) => x === 'post').length, posts);
  });
}

test('cross-tab exclusion and same-instance concurrent scans allow only one POST', async () => {
  const { f, deps, engine } = fixture();
  const started = deferred<void>();
  const finish = deferred<AttendanceRecord | null>();
  deps.getBoard = async () => {
    f.calls.push('board');
    started.resolve();
    return finish.promise;
  };
  const a = engine();
  const b = engine();
  const first = a.scan();
  await started.promise;
  assert.equal((await a.scan()).status, 'busy');
  assert.equal((await b.scan()).status, 'busy');
  finish.resolve(null);
  assert.equal((await first).status, 'signed');
  assert.equal((await b.scan()).status, 'signed');
  assert.equal(f.calls.filter((x) => x === 'post').length, 1);
});

test('account-scoped results and subsequent day each get their own check', async () => {
  const { f, engine } = fixture();
  const a = engine();
  await a.scan();
  f.account = 'bob';
  await a.scan();
  assert.equal(f.rows.size, 2);
  f.account = 'alice';
  f.now += 24 * 60 * 60 * 1000;
  await a.scan();
  assert.equal(f.rows.get('alice')?.day, '2026-10-02');
  assert.equal(f.calls.filter((x) => x === 'post').length, 3);
});

test('pending crash guard persists across engine recreation and midnight', async () => {
  const { f, engine } = fixture();
  f.now = Date.parse('2026-10-01T15:59:00Z');
  f.rows.set('alice', {
    account: 'alice',
    day: '2026-10-01',
    status: 'pending',
    checkedAt: f.now,
    nextAttempt: f.now + ATTENDANCE_COOLDOWN_MS,
  });
  f.now += 2 * 60 * 1000;
  assert.equal((await engine().scan()).status, 'cooldown');
  assert.ok(!f.calls.includes('board'));
});

for (const fault of ['read', 'write', 'claim', 'settings']) {
  test(fault + ' RPC failure prevents network and throttles subsequent scans', async () => {
    const { f, deps, engine } = fixture();
    let attempts = 0;
    const fail = async () => {
      attempts++;
      throw new Error('RPC unavailable');
    };
    if (fault === 'read') deps.readState = fail;
    if (fault === 'write') deps.writeState = fail;
    if (fault === 'claim') deps.withLock = fail;
    if (fault === 'settings') deps.readEnabled = fail;
    const a = engine();
    assert.equal((await a.scan()).status, 'failed');
    await a.scan();
    await a.scan();
    assert.equal(attempts, 1);
    assert.ok(!f.calls.includes('board'));
    assert.ok(!f.calls.includes('post'));
    assert.equal(f.locked, false);
  });
}

test('lost final signed write leaves durable guard and never repeats local POST', async () => {
  const { f, deps, engine } = fixture();
  const write = deps.writeState;
  deps.writeState = async (account, state) => {
    if (state.status === 'signed') throw new Error('lost storage acknowledgement');
    await write(account, state);
  };
  const a = engine();
  assert.equal((await a.scan()).status, 'failed');
  await a.scan();
  assert.equal((await engine().scan()).status, 'cooldown');
  assert.equal(f.calls.filter((x) => x === 'post').length, 1);
  assert.equal(f.rows.get('alice')?.status, 'pending');
});

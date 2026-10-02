import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { indexedDB } from 'fake-indexeddb';
import { Window } from 'happy-dom';
import { quickRules } from '../src/quick-rules';
import {
  type Entity,
  type Rule,
  type RuleGroup,
  createState,
  edit,
  entities,
  mergeOps,
  validateOps,
  validateValue,
  ruleMatch,
} from '../src/core';
import { listRuleGroups, effectiveRules, buildGroupRules } from '../src/rule-groups';
import { renderRuleGroups } from '../src/options-rule-groups';

// Pure configuration contracts plus an isolated built-background RPC fixture.
// No browser or real DAV request is issued. Existing tests/product are untouched.
const template = (overrides: Partial<RuleGroup> = {}): RuleGroup => ({
  target: 'keyword',
  action: 'mark',
  scope: 'all',
  label: '测试组',
  color: '#123456',
  enabled: true,
  areas: { title: false, post: false, comment: true },
  styles: {
    showGroupName: false,
    avatarEffect: 'pulse',
    titleColor: { enabled: true, color: '#ff0000' },
    groupNameColor: { enabled: true, color: '#123456' },
  },
  ...overrides,
});
const entity = <T>(id: string, value: T): Entity<T> => ({ id, value, conflicts: [] });
const row = (id: string, value: Partial<Rule> = {}): Entity<Rule> =>
  entity(id, { ...template(), text: '旧关键词', group: 'g', ...value });
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test('groups derive legacy templates with styles/areas and retain explicit empty groups', () => {
  const old = [row('r1'), row('r2', { text: '另一个词' }), row('loose', { group: undefined })];
  const before = JSON.stringify(old);
  const groups = listRuleGroups(old, [entity('empty', template({ label: '空组' }))]);
  assert.equal(groups.length, 2);
  const derived = groups.find((g) => g.id === 'g')!;
  assert.deepEqual(derived.value.styles, old[0].value.styles);
  assert.deepEqual(derived.value.areas, old[0].value.areas);
  assert.equal(Object.hasOwn(derived.value, 'text'), false);
  assert.equal(Object.hasOwn(derived.value, 'group'), false);
  assert.ok(groups.some((g) => g.id === 'empty'));
  assert.equal(JSON.stringify(old), before);
});

test('groups explicit template takes precedence without altering legacy stored rule', () => {
  const rules = [row('old')];
  const old = JSON.stringify(rules);
  const explicit = entity(
    'g',
    template({
      label: '显式新名',
      enabled: false,
      areas: { title: true, post: false, comment: false },
    }),
  );
  const found = listRuleGroups(rules, [explicit]);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].value, explicit.value);
  assert.equal(JSON.stringify(rules), old);
});

test('groups legacy per-rule variations remain effective until explicit template exists', () => {
  const rules = [
    row('a'),
    row('b', {
      areas: { title: true, post: false, comment: false },
      styles: { showGroupName: true },
      enabled: false,
    }),
  ];
  const before = plain(rules);
  const result = effectiveRules(rules);
  assert.deepEqual(result, before);
  assert.deepEqual(rules, before);
});

test('groups explicit edits apply style/range but preserve member text/id/group and disabled members', () => {
  const rules = [
    row('a', { text: 'Alice', enabled: true }),
    row('b', { text: 'Bob', enabled: false }),
  ];
  const group = entity(
    'g',
    template({
      label: '新组名',
      scope: 'body',
      areas: { title: false, post: true, comment: false },
    }),
  );
  const before = plain(rules);
  const result = effectiveRules(rules, [group]);
  assert.deepEqual(
    result.map((r) => [r.id, r.value.text, r.value.group]),
    [
      ['a', 'Alice', 'g'],
      ['b', 'Bob', 'g'],
    ],
  );
  assert.deepEqual(result[0].value.areas, group.value.areas);
  assert.deepEqual(result[0].value.styles, group.value.styles);
  assert.deepEqual(
    result.map((r) => r.value.enabled),
    [true, false],
  );
  assert.deepEqual(rules, before);
});

test('groups disabled template disables all members and mismatched target does not reinterpret them', () => {
  const rules = [row('a'), row('b', { enabled: false })];
  const result = effectiveRules(rules, [entity('g', template({ enabled: false }))]);
  assert.ok(result.every((r) => r.value.enabled === false));
  assert.ok(
    result.every(
      (r) =>
        !ruleMatch(r.value, {
          title: '旧关键词',
          body: '旧关键词',
          author: '',
          authorId: '',
          kind: 'post',
          floor: 1,
        }),
    ),
  );
  assert.deepEqual(effectiveRules(rules, [entity('g', template({ target: 'user' }))]), rules);
});

test('groups batch trims, removes blank/exact duplicate values and retains template styling', () => {
  const group = entity('g', template({ enabled: false }));
  const before = JSON.stringify(group);
  const built = buildGroupRules(group, [' a ', '', 'a', '\t', 'b', ' b ']);
  assert.deepEqual(
    built.map((r) => r.text),
    ['a', 'b'],
  );
  for (const r of built) {
    assert.equal(r.group, 'g');
    assert.deepEqual(r.styles, group.value.styles);
    assert.deepEqual(r.areas, group.value.areas);
    assert.equal(r.enabled, false);
    assert.doesNotThrow(() => validateValue('rules', 'new', r));
  }
  assert.equal(JSON.stringify(group), before);
});

test('groups batch enforces 200 distinct entries and 200-character item boundary', () => {
  const g = entity('g', template());
  const values = Array.from({ length: 200 }, (_, i) => 'k' + i);
  assert.equal(buildGroupRules(g, [...values, ' k0 ']).length, 200);
  assert.throws(() => buildGroupRules(g, [...values, 'overflow']));
  assert.equal(buildGroupRules(g, ['x'.repeat(200)])[0].text.length, 200);
  assert.throws(() => buildGroupRules(g, ['x'.repeat(201)]));
  assert.throws(() => buildGroupRules(g, ['', ' ', '\n']));
});

test('groups new user batch accepts numeric IDs only without breaking old username rules', () => {
  const g = entity('users', template({ target: 'user' }));
  assert.deepEqual(
    buildGroupRules(g, ['12', ' 34 ', '12']).map((r) => r.text),
    ['12', '34'],
  );
  for (const text of [
    'Alice',
    '-12',
    '1.5',
    '1e3',
    '/space/12',
    'https://www.nodeseek.com/space/12',
    '１２',
  ])
    assert.throws(() => buildGroupRules(g, [text]), text);
  const old = row('old-name', { target: 'user', text: 'Alice' });
  assert.doesNotThrow(() => validateValue('rules', old.id, old.value));
  assert.deepEqual(effectiveRules([old]), [old]);
});

test('groups returned template/batch values do not alias stored nested style or area data', () => {
  const old = row('old');
  const before = plain(old);
  const derived = listRuleGroups([old])[0];
  derived.value.areas!.comment = false;
  (derived.value.styles!.titleColor as any).color = '#000000';
  const failures: string[] = [];
  if (JSON.stringify(old) !== JSON.stringify(before))
    failures.push('editing derived template mutated legacy rule');
  const g = entity('g', template());
  const original = plain(g);
  const built = buildGroupRules(g, ['a', 'b']);
  built[0].areas!.comment = false;
  (built[0].styles!.titleColor as any).color = '#000000';
  if (JSON.stringify(g) !== JSON.stringify(original))
    failures.push('editing new row mutated source group');
  if (JSON.stringify(built[1].styles) !== JSON.stringify(original.value.styles))
    failures.push('sibling row shares mutable styles');
  assert.deepEqual(failures, []);
});

test('groups empty template round-trips through JSON, validateOps and independent merge', () => {
  const a = edit(createState('device-a'), 'ruleGroups', 'empty-a', template());
  const b = edit(createState('device-b'), 'ruleGroups', 'empty-b', template({ label: '第二空组' }));
  const restored = validateOps(JSON.parse(JSON.stringify(a.ops)));
  const merged = mergeOps(restored, validateOps(plain(b.ops)));
  assert.equal(entities(merged, 'rules').length, 0);
  assert.deepEqual(
    entities<RuleGroup>(merged, 'ruleGroups')
      .map((g) => g.id)
      .sort(),
    ['empty-a', 'empty-b'],
  );
  assert.equal(listRuleGroups([], entities<RuleGroup>(merged, 'ruleGroups')).length, 2);
  assert.deepEqual(mergeOps(merged, restored), merged);
});

test('groups concurrent edits preserve conflicts and explicit deletion does not revive', () => {
  let a = edit(createState('a'), 'ruleGroups', 'g', template());
  let b = { ...createState('b'), ops: plain(a.ops) };
  a = edit(a, 'ruleGroups', 'g', template({ label: '电脑' }));
  b = edit(b, 'ruleGroups', 'g', template({ label: '另一设备' }));
  const merged = mergeOps(a.ops, b.ops);
  assert.equal(entities(merged, 'ruleGroups')[0].conflicts.length, 2);
  const deleted = edit({ ...a, ops: merged }, 'ruleGroups', 'g', null);
  assert.equal(entities(mergeOps(deleted.ops, b.ops), 'ruleGroups').length, 0);
});

test('groups validateOps rejects malformed template metadata and scopes', () => {
  const base = edit(createState('qa'), 'ruleGroups', 'g', template()).ops;
  const invalid = [
    null,
    [],
    '',
    { ...template(), label: ' ' },
    { ...template(), target: 'all' },
    { ...template(), action: 'delete' },
    { ...template(), color: 'red' },
    { ...template(), enabled: 'no' },
    { ...template(), areas: { comment: true } },
    { ...template(), styles: { titleColor: { enabled: true, color: 'javascript:x' } } },
  ];
  for (const value of invalid.filter((v) => v !== null))
    assert.throws(() => validateOps([{ ...base[0], value }]), JSON.stringify(value));
  assert.doesNotThrow(() => validateOps([{ ...base[0], value: null }]));
});

test('groups cannot smuggle member text/group fields through serialized RuleGroup operations', () => {
  const op = edit(createState('qa'), 'ruleGroups', 'g', template()).ops[0];
  const accepted: unknown[] = [];
  for (const field of ['text', 'group']) {
    const bad = { ...op, value: { ...template(), [field]: 'hijacked' } };
    let validated;
    try {
      validated = validateOps(JSON.parse(JSON.stringify([bad])));
    } catch {
      continue;
    }
    const applied = effectiveRules([row('old')], entities<RuleGroup>(validated, 'ruleGroups'))[0];
    accepted.push({
      field,
      resultingText: applied.value.text,
      resultingGroup: applied.value.group,
    });
  }
  assert.deepEqual(
    accepted,
    [],
    'RuleGroup accepted forbidden member fields and changed effective membership/match',
  );
});

test('groups accepted group IDs can always be referenced by generated member rules', () => {
  for (const size of [36, 100, 101, 200]) {
    const id = 'g'.repeat(size);
    const g = entity(id, template());
    let accepted = true;
    try {
      validateValue('ruleGroups', id, g.value);
    } catch {
      accepted = false;
    }
    if (accepted)
      for (const r of buildGroupRules(g, ['valid']))
        assert.doesNotThrow(
          () => validateValue('rules', 'member', r),
          'accepted unusable group ID length ' + size,
        );
  }
});

async function builtBackground(fault: { failStateWrite?: boolean } = {}) {
  const local: any = {},
    session: any = {};
  let listener: any;
  const area = (data: any) => ({
    setAccessLevel: async () => {},
    get: async (keys: any) =>
      Object.fromEntries(
        (typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys || data)
        ).map((k: string) => [k, structuredClone(data[k])]),
      ),
    set: async (values: any) => {
      if (fault.failStateWrite && Object.hasOwn(values, 'state')) throw Error('QA quota failure');
      Object.assign(data, structuredClone(values));
    },
    remove: async (key: string) => {
      delete data[key];
    },
  });
  const chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: {
      id: 'qa',
      getURL: (p: string) => 'chrome-extension://qa/' + p,
      onMessage: { addListener: (f: any) => (listener = f) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      openOptionsPage: async () => {},
    },
    tabs: { query: async () => [], sendMessage: async () => {} },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
    permissions: { contains: async () => true },
  };
  const code = await readFile(
    resolve(process.env.NSFLOW_GROUP_BUNDLE_DIR || 'dist', 'background.js'),
    'utf8',
  );
  runInNewContext(code, {
    chrome,
    indexedDB,
    crypto,
    structuredClone,
    console,
    URL,
    TextEncoder,
    TextDecoder,
    AbortSignal,
    setTimeout,
    clearTimeout,
    fetch: () => {
      throw Error('No network allowed in groups test');
    },
  });
  const call = (type: string, payload: any = {}) =>
    new Promise<any>((resolve) =>
      listener({ type, payload }, { id: 'qa', url: 'chrome-extension://qa/flow-settings.html' }, resolve),
    );
  await call('snapshot');
  return call;
}

test(
  'groups built backend saves/exports empty groups and merges/restores groups with conflicts',
  { skip: process.env.NSFLOW_GROUP_PURE === '1' ? 'Await final 0.1.8 dist notification' : false },
  async () => {
    const call = await builtBackground();
    const initial = await call('edit', {
      collection: 'ruleGroups',
      key: 'empty',
      value: template(),
    });
    assert.equal(initial.ok, true);
    assert.equal(initial.result.ruleGroups.length, 1);
    assert.equal(initial.result.rules.length, 0);
    const exported = (await call('export')).result;
    assert.equal(entities(validateOps(plain(exported.ops)), 'ruleGroups').length, 1);
    let remote = { ...createState('remote'), ops: plain(exported.ops) };
    remote = edit(remote, 'ruleGroups', 'empty', template({ label: '远端修改' }));
    await call('edit', {
      collection: 'ruleGroups',
      key: 'empty',
      value: template({ label: '本机修改' }),
    });
    remote = edit(remote, 'ruleGroups', 'remote-empty', template({ label: '远端空组' }));
    const data = { ...exported, ops: remote.ops };
    assert.equal((await call('importPreview', { data })).ok, true);
    assert.equal((await call('importApply', { data })).ok, true);
    const merged = (await call('snapshot')).result;
    assert.equal(merged.ruleGroups.length, 2);
    assert.ok(merged.conflicts.some((c: any) => c.collection === 'ruleGroups' && c.id === 'empty'));
    assert.equal((await call('recoveryRestore')).ok, true);
    const recovered = (await call('snapshot')).result;
    assert.equal(recovered.ruleGroups.length, 1);
    assert.equal(recovered.ruleGroups[0].value.label, '本机修改');
    assert.equal(recovered.conflicts.length, 0);
  },
);

const builtOnly = { skip: process.env.NSFLOW_GROUP_PURE === '1' };
test(
  'groups batch backend rejects invalid second edit with no partial state or sequence consumption',
  builtOnly,
  async () => {
    const call = await builtBackground();
    const before = plain((await call('export')).result.ops);
    const valid = { collection: 'ruleGroups', key: 'atomic', value: template() };
    for (const bad of [
      { collection: 'rules', key: 'bad', value: { ...row('bad').value, color: 'invalid' } },
      { collection: 'settings', key: 'enabled', value: false },
    ]) {
      const result = await call('editRuleBatch', { edits: [valid, bad] });
      assert.equal(result.ok, false);
      assert.deepEqual(plain((await call('export')).result.ops), before);
    }
    const ok = await call('editRuleBatch', {
      edits: [
        valid,
        { collection: 'rules', key: 'member', value: { ...row('r').value, group: 'atomic' } },
      ],
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.result.ruleGroups.length, 1);
    assert.equal(ok.result.rules.length, 1);
    assert.deepEqual(
      plain((await call('export')).result.ops).map((o: any) => o.seq),
      [1, 2],
    );
  },
);

test(
  'groups batch backend storage failure is atomic and retry leaves no ghost operations',
  builtOnly,
  async () => {
    const fault = { failStateWrite: false };
    const call = await builtBackground(fault);
    const edits = [
      { collection: 'ruleGroups', key: 'atomic', value: template() },
      { collection: 'rules', key: 'member', value: { ...row('r').value, group: 'atomic' } },
    ];
    fault.failStateWrite = true;
    const failed = await call('editRuleBatch', { edits });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /QA quota failure/);
    assert.deepEqual(plain((await call('export')).result.ops), []);
    fault.failStateWrite = false;
    assert.equal((await call('editRuleBatch', { edits })).ok, true);
    assert.deepEqual(
      plain((await call('export')).result.ops).map((o: any) => o.seq),
      [1, 2],
    );
  },
);

test(
  'groups batch backend enforces 201 bound and serializes concurrent independent batches',
  builtOnly,
  async () => {
    const call = await builtBackground();
    for (const edits of [
      [],
      Array.from({ length: 202 }, (_, i) => ({
        collection: 'ruleGroups',
        key: 'g' + i,
        value: template(),
      })),
    ]) {
      assert.equal((await call('editRuleBatch', { edits })).ok, false);
      assert.equal((await call('export')).result.ops.length, 0);
    }
    const replies = await Promise.all(
      ['a', 'b'].map((key) =>
        call('editRuleBatch', { edits: [{ collection: 'ruleGroups', key, value: template() }] }),
      ),
    );
    assert.ok(replies.every((r) => r.ok));
    assert.deepEqual(
      plain((await call('snapshot')).result.ruleGroups)
        .map((g: any) => g.id)
        .sort(),
      ['a', 'b'],
    );
    assert.deepEqual(
      plain((await call('export')).result.ops).map((o: any) => o.seq),
      [1, 2],
    );
  },
);

test('settings groups start with separate lists; selection preserves style and failed saves keep draft', async (t) => {
  await quickFixture(t, { settings: { enabled: true }, rules: [], ruleGroups: [] });
  const host = document.createElement('div');
  document.body.append(host);
  const data = {
    rules: [row('r')],
    ruleGroups: [
      entity('g', template()),
      entity('blocked', template({ label: '屏蔽组', action: 'block' })),
    ],
  };
  let saved: any;
  let reject = true;
  renderRuleGroups(host, data, async (edits) => {
    if (reject) throw Error('保存失败测试');
    saved = edits;
  });
  assert.equal(host.querySelector<HTMLElement>('.rule-group-editor')!.hidden, true);
  assert.equal(
    host.querySelectorAll('.rule-section')[0].querySelectorAll('.rule-group-card').length,
    1,
  );
  assert.equal(
    host.querySelectorAll('.rule-section')[1].querySelectorAll('.rule-group-card').length,
    1,
  );
  host.querySelector<HTMLButtonElement>('[data-group-id="g"]')!.click();
  const input = host.querySelector<HTMLInputElement>('[aria-label="标签名称"]')!;
  input.value = '修改后的组名';
  const form = host.querySelector('form')!;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.value, '修改后的组名');
  assert.equal(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false);
  assert.match(host.querySelector('[role="status"]')!.textContent!, /保存失败测试/);
  reject = false;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved[0].key, 'g');
  assert.deepEqual(saved[0].value.styles, data.ruleGroups[0].value.styles);
  assert.deepEqual(saved[0].value.areas, data.ruleGroups[0].value.areas);
  host.querySelector<HTMLButtonElement>('.rule-group-editor > button')!.click();
  assert.equal(host.querySelector<HTMLElement>('.rule-group-editor')!.hidden, true);
});

test('settings new blocking group defaults to block and hides member input until saved', async (t) => {
  await quickFixture(t, { settings: { enabled: true }, rules: [], ruleGroups: [] });
  const host = document.createElement('div');
  document.body.append(host);
  let saved: any;
  renderRuleGroups(host, { rules: [] }, async (edits) => {
    saved = edits;
  });
  (host.querySelectorAll('.rule-section-heading button')[1] as HTMLButtonElement).click();
  assert.equal(
    host.querySelector<HTMLSelectElement>('[aria-label="分组处理方式"]')!.value,
    'block',
  );
  assert.equal(host.querySelectorAll('form')[1].hidden, true);
  host.querySelector<HTMLInputElement>('[aria-label="标签名称"]')!.value = '广告屏蔽';
  assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="分组范围"]')!.value, 'title');
  host
    .querySelector('form')!
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saved[0].value.action, 'block');
  assert.equal(saved[0].value.label, '广告屏蔽');
});

async function quickFixture(
  t: any,
  snapshot: any,
  saved: () => Promise<void> = async () => {},
  url = 'https://www.nodeseek.com/space/123',
) {
  const w = new Window({ url });
  w.document.write('<main><a id="pm">私信</a><p id="text">sample keyword</p></main>');
  const calls: any[] = [];
  let fail = false;
  let closed = 0;
  const globals: Record<string, any> = {
    window: w,
    document: w.document,
    location: w.location,
    innerWidth: 1000,
    innerHeight: 800,
    chrome: {
      runtime: {
        sendMessage: async (m: any) => {
          calls.push(plain(m));
          return fail ? { ok: false, error: 'QA save rejected' } : { ok: true, result: {} };
        },
      },
    },
  };
  const previous = new Map(
    Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  );
  for (const [k, v] of Object.entries(globals))
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  t.after(async () => {
    await w.happyDOM.abort();
    for (const [k, v] of previous) {
      if (v) Object.defineProperty(globalThis, k, v);
      else delete (globalThis as any)[k];
    }
  });
  const attach = quickRules(
    () => snapshot,
    (title) => {
      const d = w.document.createElement('dialog');
      d.setAttribute('aria-label', title);
      d.setAttribute('open', '');
      d.close = () => {
        closed++;
        d.removeAttribute('open');
      };
      w.document.body.append(d);
      return d as any;
    },
    saved,
  );
  attach();
  const open = (label = '标记用户') => {
    const b = [...w.document.querySelectorAll('button')].find((b) => b.textContent === label);
    assert.ok(b, label);
    b.click();
    return w.document.querySelector('dialog')!;
  };
  const submit = async (d: any) => {
    d.querySelector('form').dispatchEvent(
      new w.Event('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
  };
  return { w, calls, attach, open, submit, fail: (v: boolean) => (fail = v), closed: () => closed };
}

test('groups quick profile matches numeric ID, filters templates and retains custom legacy style/range', async (t) => {
  const old = row('old', { target: 'user', text: '456' });
  const snapshot = {
    settings: { enabled: true },
    rules: [old],
    ruleGroups: [
      entity('off', template({ target: 'user', enabled: false })),
      entity('blocked', template({ target: 'user', action: 'block' })),
      entity('keyword', template()),
    ],
  };
  const f = await quickFixture(t, snapshot);
  f.attach();
  assert.equal(f.w.document.querySelectorAll('#nf-user-rule-actions').length, 1);
  assert.equal(f.w.document.querySelector('#pm')!.nextElementSibling!.id, 'nf-user-rule-actions');
  const d = f.open();
  const input = d.querySelector('input')!;
  assert.equal(input.value, '123');
  assert.equal(input.readOnly, true);
  const choose = d.querySelector('select')!;
  assert.deepEqual(
    [...choose.options].map((o) => o.value),
    ['g', ''],
  );
  choose.value = 'g';
  choose.dispatchEvent(new f.w.Event('change'));
  await f.submit(d);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].type, 'editRuleBatch');
  assert.equal(f.calls[0].payload.edits.length, 1);
  const value = f.calls[0].payload.edits[0].value;
  assert.equal(value.text, '123');
  assert.equal(value.group, 'g');
  assert.deepEqual(value.styles, old.value.styles);
  assert.deepEqual(value.areas, old.value.areas);
  assert.equal(f.closed(), 1);
});

test('groups quick new template and member share one batch and rejected save can be retried', async (t) => {
  const f = await quickFixture(t, { settings: { enabled: true }, rules: [], ruleGroups: [] });
  const d = f.open();
  f.fail(true);
  await f.submit(d);
  assert.equal(f.closed(), 0);
  assert.match(d.querySelector('[role=status]')!.textContent, /QA save rejected/);
  assert.equal(d.querySelector('button')!.disabled, false);
  f.fail(false);
  await f.submit(d);
  assert.equal(f.closed(), 1);
  for (const call of f.calls) {
    const edits = call.payload.edits;
    assert.equal(edits.length, 2);
    assert.equal(edits[0].collection, 'ruleGroups');
    assert.equal(edits[1].collection, 'rules');
    assert.equal(edits[1].value.group, edits[0].key);
    assert.equal(edits[1].value.text, '123');
  }
});

test('groups quick duplicate member performs no RPC and leaves usable dialog', async (t) => {
  const f = await quickFixture(t, {
    settings: { enabled: true },
    rules: [row('same', { target: 'user', text: '123' })],
    ruleGroups: [],
  });
  const d = f.open();
  d.querySelector('select')!.value = 'g';
  await f.submit(d);
  assert.equal(f.calls.length, 0);
  assert.equal(f.closed(), 0);
  assert.match(d.querySelector('[role=status]')!.textContent, /已在分组中/);
  assert.equal(d.querySelector('button')!.disabled, false);
});

test('groups quick committed batch is not repeated when post-save refresh fails and user retries', async (t) => {
  const f = await quickFixture(
    t,
    { settings: { enabled: true }, rules: [], ruleGroups: [] },
    async () => {
      throw Error('QA snapshot refresh failed');
    },
  );
  const d = f.open();
  await f.submit(d);
  assert.equal(f.calls.length, 1);
  if (d.hasAttribute('open') && !d.querySelector('button')!.disabled) await f.submit(d);
  assert.equal(
    f.calls.length,
    1,
    'successful batch was submitted twice after follow-up refresh failed',
  );
});

test('groups quick post selection survives periodic profile scan and keeps selected keyword', async (t) => {
  const snapshot = { settings: { enabled: true }, rules: [], ruleGroups: [] };
  const f = await quickFixture(t, snapshot, async () => {}, 'https://www.nodeseek.com/post-101-1');
  const p = f.w.document.querySelector('#text')!;
  Object.defineProperty(f.w, 'getSelection', {
    configurable: true,
    value: () => ({
      rangeCount: 1,
      toString: () => ' sample keyword ',
      anchorNode: p.firstChild,
      getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 24, bottom: 42 }) }),
    }),
  });
  p.dispatchEvent(new f.w.MouseEvent('mouseup', { bubbles: true }));
  const bar = f.w.document.querySelector('#nf-selection-actions');
  assert.ok(bar);
  for (let n = 0; n < 5; n++) f.attach();
  assert.equal(
    f.w.document.querySelector('#nf-selection-actions'),
    bar,
    'non-profile scan removed selection actions',
  );
  const d = f.open('标记关键词');
  assert.equal(d.querySelector('input')!.value, 'sample keyword');
  await f.submit(d);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.edits[1].value.target, 'keyword');
  assert.equal(f.calls[0].payload.edits[1].value.text, 'sample keyword');
});

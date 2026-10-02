import {
  DEFAULTS,
  VERSION,
  PROFILE_FIELDS,
  uuid,
  type Collection,
  type Entity,
  type Rule,
} from './core';
import { rpc } from './client';
import { ONE_DRIVE_ORIGINS } from './dav';
import { element } from './adapter';
import { renderRuleGroups, type RuleEdit } from './options-rule-groups';
const $ = (id: string) => document.getElementById(id)!;
let snapshot: any;
let pending: Promise<unknown> = Promise.resolve();
let formDirty = false,
  pendingCount = 0;
const failedEdits = new Map<string, { collection: Collection; key: string; value: unknown }>();
const status = (text: string, bad = false) => {
  $('save-status').textContent = text;
  $('save-status').classList.toggle('error', bad);
};
const davStatus = (text: string, bad = false) => {
  $('dav-status').textContent = text;
  $('dav-status').classList.toggle('error', bad);
};
let davBusy = false;
let davDirty = false;
async function davAction(fn: () => Promise<void>) {
  if (davBusy) return;
  davBusy = true;
  const controls = [...document.querySelectorAll<HTMLButtonElement>('#sync button')];
  controls.forEach((b) => (b.disabled = true));
  $('dav-form').inert = true;
  $('dav-status').setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (e) {
    davStatus((e as Error).message, true);
  } finally {
    davBusy = false;
    $('dav-form').inert = false;
    controls.forEach((b) => (b.disabled = false));
    $('dav-status').removeAttribute('aria-busy');
  }
}
const btn = (label: string, fn: () => unknown, report = status) => {
  const b = element('button', 'button', label);
  b.type = 'button';
  b.addEventListener('click', () => {
    try {
      Promise.resolve(fn()).catch((e) => report(e.message, true));
    } catch (e) {
      report((e as Error).message, true);
    }
  });
  return b;
};
async function save(collection: Collection, key: string, value: unknown) {
  formDirty = true;
  pendingCount++;
  status('正在保存…');
  const run = pending.then(() => rpc('edit', { collection, key, value }));
  pending = run.catch(() => {});
  const id = collection + ':' + key;
  try {
    snapshot = await run;
    failedEdits.delete(id);
    renderLists();
  } catch (e) {
    failedEdits.set(id, { collection, key, value });
    status('保存失败：' + (e as Error).message, true);
    throw e;
  } finally {
    pendingCount--;
    formDirty = pendingCount > 0 || failedEdits.size > 0;
    $('retry-save').hidden = failedEdits.size === 0;
    if (!formDirty) status('已保存到本机 · 启用 WebDAV 后自动同步');
  }
}
const settingLabels: Record<string, string> = {
  enabled: '启用 NodeSeek Flow',
  listPaging: '首页提前续页与缓存',
  commentPaging: '帖子评论提前续页与缓存',
  restore: '返回或刷新后恢复阅读现场',
  profiles: '用户资料标签（先显示缓存）',
  directLinks: '直接打开外链',
  hot: '在发帖按钮下显示热榜',
  previews: '通知评论预览',
  hideBanner: '隐藏首页 DEV 轮播横幅',
  hideQuick: '隐藏侧栏快捷功能区',
  hideStats: '隐藏论坛用户数目',
  hideWelcome: '隐藏欢迎新用户',
  profileHours: '资料后台刷新周期（小时）',
  prefetchScreens: '提前加载距离（屏）',
  cacheMB: '缓存容量（MB）',
  cacheDays: '缓存保留天数',
};
function renderSettings() {
  const reading = $('reading-settings');
  const appearance = $('appearance-settings');
  reading.replaceChildren();
  appearance.replaceChildren();
  for (const [key, label] of Object.entries(settingLabels)) {
    const base = (DEFAULTS as any)[key];
    const row = element('label', 'setting');
    const title = element('span', '', label);
    const input = element('input');
    input.type = typeof base === 'boolean' ? 'checkbox' : 'number';
    input.name = key;
    if (typeof base === 'boolean') input.checked = snapshot.settings[key];
    else {
      input.value = String(snapshot.settings[key]);
      input.min = key === 'prefetchScreens' ? '.5' : '1';
      input.max =
        key === 'cacheMB'
          ? '200'
          : key === 'cacheDays'
            ? '30'
            : key === 'prefetchScreens'
              ? '3'
              : '1000';
      input.step = key === 'prefetchScreens' ? '.5' : '1';
    }
    input.addEventListener('change', () => {
      if (!input.checkValidity()) {
        input.reportValidity();
        return;
      }
      save('settings', key, typeof base === 'boolean' ? input.checked : Number(input.value)).catch(
        () => {},
      );
    });
    row.append(title, input);
    (key.startsWith('hide') ? appearance : reading).append(row);
  }
  for (const [key, label, values] of [
    [
      'theme',
      '主题模式',
      [
        ['system', '跟随系统'],
        ['light', '浅色'],
        ['dark', '深色'],
      ],
    ],
    [
      'palette',
      '配色',
      [
        ['plain', '纯色'],
        ['paper', '暖色护眼'],
      ],
    ],
  ] as const) {
    const row = element('label', 'setting');
    const select = element('select');
    select.name = key;
    for (const [value, text] of values) {
      const o = element('option', '', text);
      o.value = value;
      select.append(o);
    }
    select.value = snapshot.settings[key];
    const local = element('input');
    local.type = 'checkbox';
    local.checked = Object.hasOwn(snapshot.overrides, key);
    const wrap = element('span', 'local-choice');
    wrap.append(local, document.createTextNode('仅本机'));
    const update = async () => {
      if (local.checked) {
        await rpc('override', { key, value: select.value });
      } else {
        await rpc('override', { key, value: null });
        await save('settings', key, select.value);
      }
      snapshot = await rpc('snapshot');
      status('主题偏好已保存');
      applyTheme();
    };
    local.addEventListener('change', () => update().catch((e) => status(e.message, true)));
    select.addEventListener('change', () => update().catch((e) => status(e.message, true)));
    row.append(element('span', '', label), select, wrap);
    appearance.append(row);
  }
  const fields = element('fieldset', 'profile-fields');
  fields.append(element('legend', '', '资料标签字段与顺序'));
  const fieldList = element('div', 'profile-field-grid');
  let keys: string[] = [...snapshot.settings.profileLabelKeys];
  const drawFields = () => {
    fieldList.replaceChildren();
    const order = [...keys, ...Object.keys(PROFILE_FIELDS).filter((k) => !keys.includes(k))];
    for (const key of order) {
      const row = element('div', 'profile-field-row');
      const label = element('label');
      const input = element('input');
      input.type = 'checkbox';
      input.checked = keys.includes(key);
      input.name = 'profile-field-' + key;
      const change = () => {
        drawFields();
        save('settings', 'profileLabelKeys', [...keys]).catch(() => {});
      };
      input.addEventListener('change', () => {
        keys = input.checked ? [...keys, key] : keys.filter((k) => k !== key);
        change();
      });
      label.append(
        input,
        document.createTextNode(' ' + (key === 'rank' ? '等级' : PROFILE_FIELDS[key])),
      );
      row.append(label);
      if (input.checked) {
        const index = keys.indexOf(key);
        const moves = element('span', 'field-moves');
        for (const [offset, title] of [
          [-1, '上移'],
          [1, '下移'],
        ] as const) {
          const b = btn(title, () => {
            [keys[index], keys[index + offset]] = [keys[index + offset], keys[index]];
            change();
          });
          b.setAttribute('aria-label', title + PROFILE_FIELDS[key]);
          b.disabled = index + offset < 0 || index + offset >= keys.length;
          moves.append(b);
        }
        row.append(moves);
      }
      fieldList.append(row);
    }
  };
  drawFields();
  fields.append(fieldList);
  appearance.append(fields);
  const sizes = element('label', 'setting');
  const size = element('select');
  for (const [v, t] of [
    ['small', '小'],
    ['standard', '标准'],
    ['large', '大'],
  ]) {
    const option = element('option', '', t);
    option.value = v;
    size.append(option);
  }
  size.value = snapshot.settings.profileLabelSize;
  size.addEventListener('change', () =>
    save('settings', 'profileLabelSize', size.value).catch(() => {}),
  );
  sizes.append(element('span', '', '标签大小'), size);
  fields.append(sizes);
  const colors = element('div', 'profile-color-grid');
  for (const [level, color] of Object.entries(snapshot.settings.levelColors)) {
    const row = element('label', 'profile-color');
    const input = element('input');
    input.type = 'color';
    input.value = String(color);
    input.addEventListener('change', () =>
      save('settings', 'levelColors', {
        ...snapshot.settings.levelColors,
        [level]: input.value,
      }).catch(() => {}),
    );
    input.setAttribute('aria-label', 'Lv ' + level + ' 标签颜色');
    row.append(element('span', '', 'Lv ' + level), input);
    colors.append(row);
  }
  fields.append(element('h3', '', '等级配色'), colors);
}
function openRuleEditor(e: Entity<Rule>) {
  const r = e.value;

  ($('rule-editor') as HTMLDetailsElement).open = true;
  $('rule-form').setAttribute('data-edit', e.id);
  (document.querySelector('[name="ruleText"]') as HTMLInputElement).value = r.text;
  (document.querySelector('[name="ruleTarget"]') as HTMLSelectElement).value = r.target;
  (document.querySelector('[name="ruleAction"]') as HTMLSelectElement).value = r.action;
  (document.querySelector('[name="ruleScope"]') as HTMLSelectElement).value = r.areas
    ? 'custom'
    : r.scope;
  $('rule-areas').hidden = !r.areas;
  for (const key of ['title', 'post', 'comment'] as const)
    (document.querySelector('[name="area-' + key + '"]') as HTMLInputElement).checked =
      !!r.areas?.[key];
  (document.querySelector('[name="ruleLabel"]') as HTMLInputElement).value = r.label;
  (document.querySelector('[name="ruleColor"]') as HTMLInputElement).value = r.color;
  $('rule-form').scrollIntoView({ behavior: 'smooth' });
}
function renderLists() {
  const groupHost = document.getElementById('rule-groups');
  if (groupHost)
    renderRuleGroups(
      groupHost,
      snapshot,
      async (edits: RuleEdit[]) => {
        pendingCount++;
        formDirty = true;
        const run = pending.then(() => rpc('editRuleBatch', { edits }));
        pending = run.catch(() => {});
        try {
          snapshot = await run;
          renderLists();
          status('标签分组已保存');
        } catch (e) {
          status('保存失败：' + (e as Error).message, true);
          throw e;
        } finally {
          pendingCount--;
          formDirty = pendingCount > 0 || failedEdits.size > 0;
        }
      },
      openRuleEditor,
    );
  for (const e of snapshot.rules.filter((r: Entity<Rule>) => !r.value.group)) {
    const r = e.value;
    const row = element('div', 'record');
    const meta = element('div');
    meta.append(
      element('strong', '', (r.action === 'block' ? '屏蔽' : '标记') + ' · ' + r.text),
      element(
        'small',
        'muted',
        (r.target === 'user' ? '用户 ID / 名称' : '关键词') +
          ' · ' +
          (r.areas
            ? ['title', 'post', 'comment']
                .filter((k) => r.areas[k])
                .map((k) => ({ title: '标题', post: '主帖正文', comment: '评论正文' })[k])
                .join(' / ') || '不匹配任何区域'
            : ({ all: '标题与正文', title: '仅标题', body: '主帖与评论正文' } as any)[r.scope]) +
          (r.label ? ' · ' + r.label : ''),
      ),
    );
    row.append(
      meta,
      btn('编辑', () => openRuleEditor(e)),
      btn('删除', () => {
        if (confirm('删除这条规则？删除会同步到其他设备。')) return save('rules', e.id, null);
      }),
    );
    $(r.action === 'block' ? 'block-rule-list' : 'mark-rule-list').append(row);
  }
  const phrases = $('phrase-list');
  phrases.replaceChildren();
  for (const e of snapshot.phrases) {
    const row = element('div', 'record');
    row.append(
      element('pre', 'phrase', e.value),
      btn('编辑', () => {
        (document.querySelector('[name="phraseText"]') as HTMLTextAreaElement).value = e.value;
        $('phrase-form').dataset.edit = e.id;
      }),
      btn('删除', () => {
        if (confirm('删除这条短语？')) return save('phrases', e.id, null);
      }),
    );
    phrases.append(row);
  }
  if (!snapshot.phrases.length)
    phrases.append(element('p', 'muted', '短语支持多行；点击论坛 Flow 工具栏的“短语”插入编辑器。'));
  const conflicts = $('conflict-list');
  conflicts.replaceChildren();
  for (const e of snapshot.conflicts) {
    const box = element('div', 'conflict');
    box.append(element('strong', '', e.collection + ' / ' + e.id));
    for (const op of e.conflicts) {
      const value =
        op.value === null
          ? '（删除）'
          : typeof op.value === 'string'
            ? op.value
            : JSON.stringify(op.value);
      box.append(
        element('pre', 'phrase', value),
        btn('采用此版本', () => save(e.collection, e.id, op.value)),
      );
    }
    conflicts.append(box);
  }
  if (!snapshot.conflicts.length) conflicts.append(element('p', 'muted', '没有待解决的并发冲突。'));
  $('device-id').textContent = snapshot.device + ' · ' + snapshot.opCount + ' 条操作';
}
function applyTheme() {
  document.documentElement.dataset.theme =
    snapshot.settings.theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : snapshot.settings.theme;
}
function download(data: unknown, name: string) {
  const u = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = element('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 3000);
}
async function davInfo() {
  const info = await rpc('davInfo');
  const d = info.dav;
  if (d) {
    (document.querySelector('[name="davURL"]') as HTMLInputElement).value = d.url;
    (document.querySelector('[name="davUser"]') as HTMLInputElement).value = d.username;
    (document.querySelector('[name="davPassword"]') as HTMLInputElement).placeholder = d.hasPassword
      ? '已保存，留空保留'
      : '应用密码';
    (document.querySelector('[name="davProgress"]') as HTMLInputElement).checked = d.progress;
    (document.querySelector('[name="davOneDrive"]') as HTMLInputElement).checked =
      !!d.oneDriveRedirects;
  }
  $('dav-status').textContent =
    (d?.enabled ? '自动同步已启用' : '自动同步未启用') +
    ' · ' +
    (info.syncStatus?.message || '尚未同步') +
    (info.syncStatus?.at ? ' · ' + new Date(info.syncStatus.at).toLocaleString() : '');
}
async function boot() {
  snapshot = await rpc('snapshot');
  applyTheme();
  renderSettings();
  renderLists();
  $('version').textContent = VERSION;
  $('footer-version').textContent = VERSION;
  document.querySelector('[name="ruleScope"]')!.addEventListener('change', (e) => {
    $('rule-areas').hidden = (e.target as HTMLSelectElement).value !== 'custom';
  });
  await davInfo();
  const attendanceInput = $('auto-attendance') as HTMLInputElement;
  let attendanceRevision = 0;
  const attendanceInfo = async () => {
    const revision = attendanceRevision;
    const info = await rpc('attendanceInfo');
    if (revision !== attendanceRevision) return;
    attendanceInput.indeterminate = false;
    attendanceInput.checked = info.enabled;
    const r = info.latest;
    $('attendance-status').textContent =
      (info.enabled ? '本机自动签到已开启' : '本机自动签到已关闭') +
      (r
        ? ' · 账号 ' +
          r.account +
          ' · ' +
          r.day +
          ' · ' +
          (r.status === 'signed'
            ? '已签到'
            : r.status === 'pending'
              ? '检查中或等待重试'
              : '未确认成功') +
          (r.message ? ' · ' + r.message : '') +
          (r.nextAttempt > Date.now()
            ? ' · 下次检查不早于 ' + new Date(r.nextAttempt).toLocaleTimeString()
            : '')
        : ' · 尚无签到记录');
  };
  await attendanceInfo();
  attendanceInput.addEventListener('change', async () => {
    attendanceRevision++;
    attendanceInput.disabled = true;
    try {
      await rpc('attendanceConfigure', { enabled: attendanceInput.checked });
      await attendanceInfo();
    } catch (e) {
      const error = (e as Error).message;
      try {
        await attendanceInfo();
        $('attendance-status').textContent += ' · 修改未确认：' + error;
      } catch {
        attendanceInput.indeterminate = true;
        $('attendance-status').textContent = '签到开关状态未知，请重新打开设置核对。' + error;
      }
    } finally {
      attendanceInput.disabled = false;
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !attendanceInput.disabled) attendanceInfo().catch(() => {});
  });
  $('retry-save').addEventListener('click', async () => {
    for (const edit of [...failedEdits.values()]) {
      try {
        await save(edit.collection, edit.key, edit.value);
      } catch {
        return;
      }
    }
  });
  $('rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    const data = new FormData(f);
    const original = snapshot.rules.find((r: any) => r.id === f.dataset.edit)?.value;
    const custom = data.get('ruleScope') === 'custom';
    const value = {
      ...original,
      text: String(data.get('ruleText') || '').trim(),
      target: data.get('ruleTarget'),
      action: data.get('ruleAction'),
      scope: custom ? 'all' : data.get('ruleScope'),
      label: String(data.get('ruleLabel') || ''),
      color: data.get('ruleColor'),
    };
    delete value.areas;
    if (custom)
      value.areas = Object.fromEntries(
        ['title', 'post', 'comment'].map((k) => [k, data.has('area-' + k)]),
      );
    try {
      await save('rules', f.dataset.edit || uuid(), value);
      delete f.dataset.edit;
      f.reset();
      $('rule-areas').hidden = true;
      ($('rule-editor') as HTMLDetailsElement).open = false;
    } catch {}
  });
  $('phrase-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement;
    try {
      await save('phrases', f.dataset.edit || uuid(), new FormData(f).get('phraseText'));
      delete f.dataset.edit;
      f.reset();
    } catch {}
  });
  $('cancel-rule').addEventListener('click', () => {
    const f = $('rule-form') as HTMLFormElement;
    delete f.dataset.edit;
    f.reset();
    $('rule-areas').hidden = true;
    ($('rule-editor') as HTMLDetailsElement).open = false;
  });
  $('cancel-phrase').addEventListener('click', () => {
    const f = $('phrase-form') as HTMLFormElement;
    delete f.dataset.edit;
    f.reset();
  });
  $('export').addEventListener('click', async () => {
    await pending;
    download(
      await rpc('export'),
      'NodeSeek-Flow-' + new Date().toISOString().slice(0, 10) + '.json',
    );
  });
  $('import').addEventListener('change', async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      if (file.size > 6000000) throw Error('备份超过 6 MB');
      const data = JSON.parse(await file.text());
      const preview = await rpc('importPreview', { data });
      if (
        !confirm('将合并 ' + preview.count + ' 条记录。原配置保留恢复点。' + (preview.notice || ''))
      )
        return;
      await pending;
      snapshot = await rpc('importApply', { data });
      renderSettings();
      renderLists();
      applyTheme();
      status('配置已合并');
    } catch (e) {
      status((e as Error).message, true);
    }
  });
  const cache = await rpc('cacheInfo');
  $('cache-info').textContent =
    cache.count + ' 项缓存 · ' + (cache.bytes / 1024 / 1024).toFixed(2) + ' MB';
  $('restore-recovery').addEventListener('click', async () => {
    if (
      !confirm(
        '恢复最近一次导入或首次 WebDAV 合并之前的配置？之后的规则和短语修改也会回退。此操作会作为新修改同步到其他设备。',
      )
    )
      return;
    try {
      snapshot = await rpc('recoveryRestore');
      renderSettings();
      renderLists();
      applyTheme();
      status('已恢复；恢复操作将按正常规则同步');
    } catch (e) {
      status((e as Error).message, true);
    }
  });
  $('clear-cache').addEventListener('click', async () => {
    if (!confirm('清除本机页面、评论和资料缓存？规则与同步配置保留。')) return;
    await rpc('cacheClear');
    $('cache-info').textContent = '缓存已清除';
  });
  $('dav-form').addEventListener('input', () => {
    davDirty = true;
    $('dav-confirm').replaceChildren();
    davStatus('连接信息已修改，请先保存再预览。');
  });
  $('dav-save').addEventListener('click', () =>
    davAction(async () => {
      const form = $('dav-form') as HTMLFormElement;
      if (!form.reportValidity()) return;
      const data = new FormData(form);
      const u = new URL(String(data.get('davURL')));
      if (u.protocol !== 'https:') throw Error('请使用 HTTPS WebDAV 地址');
      const oneDriveRedirects = data.has('davOneDrive');
      const granted = await chrome.permissions.request({
        origins: [u.origin + '/*', ...(oneDriveRedirects ? ONE_DRIVE_ORIGINS : [])],
      });
      if (!granted) throw Error('没有授予 WebDAV 或下载主机权限');
      await rpc('davSave', {
        url: u.href,
        username: data.get('davUser'),
        password: data.get('davPassword'),
        progress: data.get('davProgress') === 'on',
        oneDriveRedirects,
      });
      $('dav-confirm').replaceChildren();
      (document.querySelector('[name="davPassword"]') as HTMLInputElement).value = '';
      davDirty = false;
      await davInfo();
      davStatus('连接已保存。请预览远端后确认启用。');
    }),
  );
  $('dav-preview').addEventListener('click', () =>
    davAction(async () => {
      if (davDirty) throw Error('请先保存修改后的连接，再预览。');
      $('dav-confirm').replaceChildren();
      davStatus('读取远端，尚不写入…');
      const r = await rpc('davPreview');
      const box = $('dav-confirm');
      box.replaceChildren(
        element(
          'p',
          '',
          '远端 ' +
            r.remoteOps +
            ' 条操作 / 本机 ' +
            r.localOps +
            ' 条；合并后 ' +
            r.conflicts +
            ' 项冲突。普通同步不上传密码或正文缓存。',
        ),
        btn(
          '确认合并并启用自动同步',
          () =>
            davAction(async () => {
              await rpc('davConfirm', { token: r.token });
              box.replaceChildren();
              davStatus('已启用，正在同步…');
              await rpc('sync');
              await davInfo();
              snapshot = await rpc('snapshot');
              renderLists();
              renderSettings();
              davStatus('同步完成');
            }),
          davStatus,
        ),
      );
      davStatus('预览完成，请检查后确认');
    }),
  );
  $('dav-sync').addEventListener('click', () =>
    davAction(async () => {
      if (davDirty) throw Error('请先保存修改后的连接并重新预览。');
      davStatus('同步中…');
      await rpc('sync');
      await davInfo();
      snapshot = await rpc('snapshot');
      renderLists();
      renderSettings();
      davStatus('同步完成');
    }),
  );
  $('dav-disable').addEventListener('click', () =>
    davAction(async () => {
      await rpc('davDisable');
      await davInfo();
      $('dav-confirm').replaceChildren();
      davStatus('已暂停自动同步');
    }),
  );
  window.addEventListener('beforeunload', (e) => {
    if (formDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  status('设置已就绪 · 修改后自动保存');
}
boot().catch((e) => status(e.message, true));

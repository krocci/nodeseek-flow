import {
  createState,
  edit,
  entities,
  mergeOps,
  validateOps,
  validateValue,
  settingsFrom,
  importLegacy,
  isForumURL,
  uuid,
  DEFAULTS,
  type State,
  type Settings,
  type Collection,
} from './core';
import { getRow, setRow, rows, removeRows, prune } from './db';
import { davBase, syncDav, ONE_DRIVE_ORIGINS, type DavConfig } from './dav';
import { attendanceDay, type AttendanceState } from './attendance';
type Stored = {
  state?: State;
  recovery?: State;
  overrides?: Partial<Settings>;
  dav?: DavConfig;
  davPending?: { token: string; url: string; at: number; ops: State['ops'] } | null;
  syncStatus?: { running: boolean; at: number; successAt?: number; message: string };
  attendanceEnabled?: boolean;
  attendanceLatest?: AttendanceState;
};
type Ephemeral = {
  lease?: { token: string; tab?: number; expires: number } | null;
  blockedUntil?: number;
  lastRequest?: number;
  attendanceLease?: {
    token: string;
    tab?: number;
    account: string;
    day: string;
    expires: number;
  } | null;
};
let mutations = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const r = mutations.then(fn);
  mutations = r.then(
    () => {},
    () => {},
  );
  return r;
};
const init = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const data = await chrome.storage.local.get<Stored>('state');
  if (!data.state) await chrome.storage.local.set({ state: createState() });
})();
async function state(): Promise<State> {
  await init;
  const data = await chrome.storage.local.get<Stored>('state');
  if (!data.state) throw Error('配置存储不可用');
  return data.state;
}
async function snapshot() {
  const s = await state();
  const { overrides = {}, attendanceEnabled = false } = await chrome.storage.local.get<Stored>([
    'overrides',
    'attendanceEnabled',
  ]);
  return {
    attendanceEnabled,
    settings: settingsFrom(s.ops, overrides),
    rules: entities(s.ops, 'rules'),
    ruleGroups: entities(s.ops, 'ruleGroups'),
    phrases: entities(s.ops, 'phrases'),
    progress: entities(s.ops, 'progress'),
    conflicts: (['settings', 'rules', 'ruleGroups', 'phrases', 'progress'] as Collection[]).flatMap(
      (c) =>
        entities(s.ops, c, true)
          .filter((e) => e.conflicts.length)
          .map((e) => ({ ...e, collection: c })),
    ),
    device: s.device,
    opCount: s.ops.length,
    overrides,
  };
}
let cacheMaintenance: Promise<void> | null = null;
let lastCacheMaintenance = 0;
function maintainCache(): Promise<void> {
  if (cacheMaintenance) return cacheMaintenance;
  if (Date.now() - lastCacheMaintenance < 5000) return Promise.resolve();
  lastCacheMaintenance = Date.now();
  cacheMaintenance = (async () => {
    const s = (await snapshot()).settings;
    await prune(s.cacheMB, s.cacheDays);
  })()
    .catch((e) => console.warn('NodeSeek Flow cache maintenance:', e.message))
    .finally(() => {
      cacheMaintenance = null;
    });
  return cacheMaintenance;
}
async function broadcast() {
  for (const tab of await chrome.tabs.query({
    url: ['https://www.nodeseek.com/*', 'https://nodeseek.com/*'],
  }))
    if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'flow:changed' }).catch(() => {});
}
async function commit(s: State) {
  if (s.ops.length > 30000) throw Error('操作历史已达上限，请先备份');
  await chrome.storage.local.set({ state: s });
  await broadcast();
  await scheduleSync();
}
async function scheduleSync() {
  const { dav } = await chrome.storage.local.get<Stored>('dav');
  if (dav?.enabled) await chrome.alarms.create('flow-sync-soon', { delayInMinutes: 0.5 });
}
let syncing: Promise<unknown> | null = null;
async function requireDavPermissions(dav: DavConfig) {
  const origins = [
    davBase(dav.url).origin + '/*',
    ...(dav.oneDriveRedirects ? ONE_DRIVE_ORIGINS : []),
  ];
  if (!(await chrome.permissions.contains({ origins })))
    throw Error('WebDAV 或 OneDrive 下载主机未授权，请在同步设置重新保存连接并授权。');
}
async function syncNow(force = false) {
  if (!force) {
    const { syncStatus } = await chrome.storage.local.get<Stored>('syncStatus');
    if (syncStatus?.successAt && Date.now() - syncStatus.successAt < 60000) return { recent: true };
  }
  return (syncing ||= (async () => {
    const { dav } = await chrome.storage.local.get<Stored>('dav');
    if (!dav?.enabled) throw Error('请先在设置中预览并启用 WebDAV');
    await requireDavPermissions(dav);
    await chrome.storage.local.set({
      syncStatus: { running: true, at: Date.now(), message: '同步中' },
    });
    try {
      const before = await state();
      const r = await syncDav(dav, before.ops);
      await serial(async () => {
        const current = await state();
        await chrome.storage.local.set({
          state: { ...current, ops: mergeOps(current.ops, r.ops) },
          syncStatus: {
            running: false,
            at: Date.now(),
            successAt: Date.now(),
            message: '同步成功 · ' + r.files + ' 个变更文件',
          },
        });
      });
      await broadcast();
      return { ok: true };
    } catch (e) {
      await chrome.storage.local.set({
        syncStatus: { running: false, at: Date.now(), message: (e as Error).message },
      });
      throw e;
    }
  })().finally(() => {
    syncing = null;
  }));
}
const privateOnly = new Set([
  'attendanceConfigure',
  'attendanceInfo',
  'edit',
  'override',
  'export',
  'importPreview',
  'importApply',
  'recoveryRestore',
  'davSave',
  'davInfo',
  'davPreview',
  'davConfirm',
  'davDisable',
  'cacheClear',
  'cacheInfo',
]);
function account(p: any) {
  const a = String(p.account || 'guest');
  if (!/^(guest|\d{1,16})$/.test(a)) throw Error('账号范围无效');
  return a;
}
function key(p: any, sender: chrome.runtime.MessageSender) {
  const scope = account(p);
  const type = String(p.kind);
  if (!['page', 'session', 'profile', 'hot', 'comment'].includes(type)) throw Error('缓存类型无效');
  const id = String(p.key || '');
  if (!id || id.length > 1200) throw Error('缓存键无效');
  return {
    key: scope + '|' + type + '|' + (type === 'session' ? sender.tab?.id + '|' : '') + id,
    scope,
    type,
  };
}
async function handle(m: any, sender: chrome.runtime.MessageSender) {
  if (sender.id !== chrome.runtime.id) throw Error('来源无效');
  const internal = sender.url?.startsWith(chrome.runtime.getURL('flow-settings.html'));
  if (!internal && !isForumURL(sender.url || '')) throw Error('来源页面不允许');
  if (privateOnly.has(m.type) && !internal) throw Error('请在扩展设置页执行此操作');
  const p = m.payload || {};
  switch (m.type) {
    case 'attendanceConfigure':
      if (typeof p.enabled !== 'boolean') throw Error('签到开关无效');
      await chrome.storage.local.set({ attendanceEnabled: p.enabled });
      await broadcast();
      return true;
    case 'attendanceInfo': {
      const { attendanceEnabled = false, attendanceLatest = null } =
        await chrome.storage.local.get<Stored>(['attendanceEnabled', 'attendanceLatest']);
      return { enabled: attendanceEnabled, latest: attendanceLatest };
    }
    case 'attendanceClaim':
      return serial(async () => {
        const a = account(p);
        if (a === 'guest' || !sender.tab?.id) return null;
        const s = await snapshot();
        if (!s.attendanceEnabled || !s.settings.enabled) return null;
        const { attendanceLease } = await chrome.storage.session.get<Ephemeral>('attendanceLease');
        if ((attendanceLease?.expires || 0) > Date.now()) return null;
        const token = uuid();
        await chrome.storage.session.set({
          attendanceLease: {
            token,
            account: a,
            day: attendanceDay(Date.now()),
            tab: sender.tab.id,
            expires: Date.now() + 90000,
          },
        });
        return { token };
      });
    case 'attendanceRead': {
      const k = 'attendance:' + account(p);
      return (await chrome.storage.local.get(k))[k] || null;
    }
    case 'attendanceCheck':
    case 'attendanceWrite':
    case 'attendanceRelease':
      return serial(async () => {
        const { attendanceLease: lease } =
          await chrome.storage.session.get<Ephemeral>('attendanceLease');
        if (
          !lease ||
          lease.token !== p.token ||
          lease.tab !== sender.tab?.id ||
          lease.account !== account(p)
        )
          throw Error('签到任务已失效');
        if (m.type === 'attendanceRelease') {
          await chrome.storage.session.set({ attendanceLease: null });
          return true;
        }
        if (lease.expires <= Date.now()) throw Error('签到任务超时');
        if (m.type === 'attendanceCheck') {
          const s = await snapshot();
          return s.attendanceEnabled && s.settings.enabled;
        }
        const v = p.state as AttendanceState;
        if (
          !v ||
          v.account !== lease.account ||
          v.day !== lease.day ||
          !['pending', 'failed', 'signed'].includes(v.status) ||
          !Number.isFinite(v.checkedAt) ||
          !Number.isFinite(v.nextAttempt)
        )
          throw Error('签到记录无效');
        const clean: AttendanceState = {
          account: lease.account,
          day: v.day,
          status: v.status,
          checkedAt: Date.now(),
          nextAttempt: v.status === 'signed' ? 0 : Date.now() + 1800000,
        };
        if (Number.isFinite(v.gain) && v.gain! > 0) clean.gain = v.gain;
        if (typeof v.message === 'string')
          clean.message = v.message.replace(/[\u0000-\u001f]/g, ' ').slice(0, 160);
        await chrome.storage.local.set({
          ['attendance:' + lease.account]: clean,
          attendanceLatest: clean,
        });
        return true;
      });
    case 'snapshot':
      return snapshot();
    case 'options':
      await chrome.runtime.openOptionsPage();
      return true;
    case 'themeChoice':
      return serial(async () => {
        if (!['light', 'dark'].includes(p.theme)) throw Error('主题无效');
        const { overrides = {} } = await chrome.storage.local.get<Stored>('overrides');
        overrides.theme = p.theme;
        await chrome.storage.local.set({ overrides });
        await broadcast();
        return true;
      });
    case 'edit':
      return serial(async () => {
        const s = await state();
        const next = edit(s, p.collection, p.key, p.value);
        await commit(next);
        return snapshot();
      });
    case 'editRuleBatch':
      return serial(async () => {
        if (!Array.isArray(p.edits) || !p.edits.length || p.edits.length > 201)
          throw Error('批量规则数量无效');
        let next = await state();
        for (const change of p.edits) {
          if (!['rules', 'ruleGroups'].includes(change.collection))
            throw Error('仅允许批量修改标签和规则');
          next = edit(next, change.collection, change.key, change.value);
        }
        await commit(next);
        return snapshot();
      });
    case 'override':
      return serial(async () => {
        const allowed = ['theme', 'palette', 'hideBanner', 'hideQuick', 'hideStats', 'hideWelcome'];
        if (!allowed.includes(p.key)) throw Error('不支持本机覆盖');
        const { overrides = {} } = await chrome.storage.local.get<Stored>('overrides');
        if (p.value === null) delete (overrides as Record<string, unknown>)[p.key];
        else {
          validateValue('settings', p.key, p.value);
          (overrides as Record<string, unknown>)[p.key] = p.value;
        }
        await chrome.storage.local.set({ overrides });
        await broadcast();
        return snapshot();
      });
    case 'progress':
      return serial(async () => {
        const s = await state();
        const k = account(p) + ':' + String(p.postId);
        if (!/^\d+$/.test(String(p.postId))) throw Error('帖子无效');
        validateValue('progress', k, p.value);
        const old = entities<any>(s.ops, 'progress').find((e) => e.id === k)?.value;
        if (
          old &&
          old.floor === p.value.floor &&
          old.url === p.value.url &&
          Date.now() - old.at < 300000
        )
          return true;
        const value = { ...p.value, seen: Math.max(old?.seen || 0, p.value.seen) };
        await commit(edit(s, 'progress', k, value));
        return true;
      });
    case 'cacheGet': {
      const k = key(p, sender);
      return (await getRow(k.key))?.value || null;
    }
    case 'cachePut': {
      const k = key(p, sender);
      if (JSON.stringify(p.value).length > 3_000_000) throw Error('单项缓存过大');
      const expiresAt = Math.min(Date.now() + 12000, Number(m.expiresAt) || Date.now() + 12000);
      await setRow(k.key, k.type, k.scope, p.value, expiresAt);
      void maintainCache();
      return true;
    }
    case 'cacheDropScope': {
      const a = account(p);
      await removeRows((await rows()).filter((r) => r.scope === a).map((r) => r.key));
      return true;
    }
    case 'cacheInfo': {
      const r = await rows();
      return { count: r.length, bytes: r.reduce((a, b) => a + b.bytes, 0) };
    }
    case 'cacheClear':
      await removeRows((await rows()).map((r) => r.key));
      return true;
    case 'lease':
      return serial(async () => {
        const now = Date.now();
        const {
          lease,
          blockedUntil = 0,
          lastRequest = 0,
        } = await chrome.storage.session.get<Ephemeral>(['lease', 'blockedUntil', 'lastRequest']);
        if (blockedUntil > now)
          throw Error('论坛请求已暂停至 ' + new Date(blockedUntil).toLocaleTimeString());
        if ((lease?.expires || 0) > now || lastRequest + 850 > now)
          return {
            wait: Math.min(
              1000,
              Math.max(200, (lease?.expires || 0) > now ? 700 : lastRequest + 850 - now),
            ),
          };
        const token = uuid();
        await chrome.storage.session.set({
          lease: { token, tab: sender.tab?.id, expires: now + 18000 },
        });
        return { token };
      });
    case 'release':
      return serial(async () => {
        const { lease } = await chrome.storage.session.get<Ephemeral>('lease');
        if (!lease || lease.token !== p.token || lease.tab !== sender.tab?.id) return false;
        await chrome.storage.session.set({
          lease: null,
          lastRequest: Date.now(),
          ...([403, 429].includes(p.status)
            ? {
                blockedUntil: Math.max(
                  Date.now() + 1800000,
                  Math.min(Date.now() + 86400000, Number(p.retryAt) || 0),
                ),
              }
            : {}),
        });
        return true;
      });
    case 'hot': {
      if (!['hot', 'daily', 'weekly'].includes(p.mode)) throw Error('榜单无效');
      const cacheKey = 'hot:' + p.mode;
      const cached = await getRow(cacheKey);
      if (cached && Date.now() - cached.at < 300000) return cached.value;
      try {
        const r = await fetch('https://api.bimg.eu.org/' + p.mode + '.json', {
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw Error('榜单暂不可用');
        const data = await r.json();
        if (!Array.isArray(data.posts)) throw Error('榜单格式变化');
        const posts = data.posts
          .slice(0, 100)
          .filter((x: any) => /^\d+$/.test(String(x.post?.id)))
          .map((x: any) => ({
            id: String(x.post.id),
            title: String(x.post.title || '').slice(0, 300),
            author: String(x.post.author || '').slice(0, 80),
            score: Number(x.score) || 0,
          }));
        const value = { posts, at: Date.now(), sourceAt: Number(data.updated_at) * 1000 };
        await setRow(cacheKey, 'hot', 'public', value);
        return value;
      } catch (e) {
        if (cached) return { ...cached.value, stale: true };
        throw e;
      }
    }
    case 'export':
      return {
        schema: 'nodeseek-flow-backup',
        version: 1,
        at: Date.now(),
        ops: (await state()).ops,
      };
    case 'importPreview': {
      const b = p.data;
      if (b?.schema === 'nodeseek-flow-backup') {
        if (b.version !== 1) throw Error('备份版本不受支持');
        return { native: true, count: validateOps(b.ops).length };
      }
      return {
        native: false,
        count: importLegacy(b).length,
        notice:
          '迁移分组标签、颜色、启用状态、资料字段顺序和大小、等级颜色及短语；不导入密钥。关键词分组匹配标题。',
      };
    }
    case 'importApply':
      return serial(async () => {
        const s = await state();
        await chrome.storage.local.set({ recovery: s });
        if (p.data?.schema === 'nodeseek-flow-backup') {
          if (p.data.version !== 1) throw Error('备份版本不受支持');
          await commit({ ...s, ops: mergeOps(s.ops, validateOps(p.data.ops)) });
        } else {
          let next = s;
          for (const x of importLegacy(p.data)) next = edit(next, x.collection, x.key, x.value);
          await commit(next);
        }
        return snapshot();
      });
    case 'recoveryRestore':
      return serial(async () => {
        const { recovery } = await chrome.storage.local.get<Stored>('recovery');
        if (!recovery) throw Error('没有可恢复的导入前记录');
        const current = await state();
        let next = current;
        for (const collection of [
          'settings',
          'rules',
          'ruleGroups',
          'phrases',
          'progress',
        ] as Collection[]) {
          const old = new Map(entities(recovery.ops, collection).map((e) => [e.id, e.value]));
          const now = entities(current.ops, collection);
          for (const id of new Set([...old.keys(), ...now.map((e) => e.id)]))
            next = edit(next, collection, id, old.get(id) ?? null);
        }
        await chrome.storage.local.set({ recovery: current });
        await commit(next);
        return snapshot();
      });
    case 'davSave': {
      if (syncing) throw Error('同步正在进行，请稍后保存');
      const base = davBase(p.url);
      if (!(await chrome.permissions.contains({ origins: [base.origin + '/*'] })))
        throw Error('请先授权该 WebDAV 主机');
      if (
        p.oneDriveRedirects &&
        !(await chrome.permissions.contains({ origins: ONE_DRIVE_ORIGINS }))
      )
        throw Error('请保存连接并授权 OneDrive 下载主机');
      if (
        String(p.username).includes(':') ||
        String(p.username).length > 200 ||
        String(p.password).length > 2000
      )
        throw Error('凭据格式无效');
      const { dav: old } = await chrome.storage.local.get<Stored>('dav');
      const password =
        p.password || (old?.url === base.href && old?.username === p.username ? old.password : '');
      if (!password) throw Error('新连接请填写应用密码');
      await chrome.storage.local.set({
        dav: {
          url: base.href,
          username: String(p.username),
          password,
          progress: !!p.progress,
          oneDriveRedirects: !!p.oneDriveRedirects,
          enabled: false,
        },
        davPending: null,
      });
      await chrome.alarms.clear('flow-sync-soon');
      return true;
    }
    case 'davDisable':
      if (syncing) throw Error('当前同步正在结束，请稍后暂停');
      {
        const { dav } = await chrome.storage.local.get<Stored>('dav');
        if (dav) await chrome.storage.local.set({ dav: { ...dav, enabled: false } });
        await chrome.alarms.clear('flow-sync-soon');
        return true;
      }
    case 'davInfo': {
      const { dav, syncStatus } = await chrome.storage.local.get<Stored>(['dav', 'syncStatus']);
      return {
        dav: dav
          ? {
              url: dav.url,
              username: dav.username,
              hasPassword: !!dav.password,
              enabled: dav.enabled,
              progress: dav.progress,
              oneDriveRedirects: !!dav.oneDriveRedirects,
            }
          : null,
        syncStatus,
      };
    }
    case 'davPreview': {
      const { dav } = await chrome.storage.local.get<Stored>('dav');
      if (!dav) throw Error('先保存连接');
      await requireDavPermissions(dav);
      const r = await syncDav(dav as DavConfig, []);
      const token = uuid();
      await chrome.storage.local.set({
        davPending: { token, url: dav.url, at: Date.now(), ops: r.ops },
      });
      const s = await state();
      const merged = mergeOps(s.ops, r.ops);
      return {
        token,
        remoteOps: r.ops.length,
        files: r.files,
        conflicts: (
          ['settings', 'rules', 'ruleGroups', 'phrases', 'progress'] as Collection[]
        ).reduce(
          (n, c) => n + entities(merged, c, true).filter((e) => e.conflicts.length).length,
          0,
        ),
        localOps: s.ops.length,
      };
    }
    case 'davConfirm':
      return serial(async () => {
        const { dav, davPending } = await chrome.storage.local.get<Stored>(['dav', 'davPending']);
        if (
          !davPending ||
          davPending.token !== p.token ||
          davPending.url !== dav?.url ||
          Date.now() - davPending.at > 600000
        )
          throw Error('预览已失效，请重新预览');
        const s = await state();
        await chrome.storage.local.set({
          recovery: s,
          state: { ...s, ops: mergeOps(s.ops, davPending.ops) },
          dav: { ...dav, enabled: true },
          davPending: null,
        });
        await broadcast();
        await scheduleSync();
        return true;
      });
    case 'sync':
      return syncNow(internal);
    default:
      throw Error('未知请求');
  }
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || typeof m.type !== 'string') return false;
  handle(m, sender)
    .then((result) => reply({ ok: true, result }))
    .catch((e) => reply({ ok: false, error: (e as Error).message }));
  return true;
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name.startsWith('flow-sync')) syncNow().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('flow-sync-periodic', { periodInMinutes: 15 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('flow-sync-periodic', { periodInMinutes: 15 });
  scheduleSync();
});

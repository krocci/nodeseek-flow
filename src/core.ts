export const VERSION = '0.1.18';
export const PROFILE_FIELDS: Record<string, string> = {
  member_id: 'ID',
  member_name: '用户',
  isAdmin: '管理',
  rank: 'Lv',
  coin: '鸡腿',
  stardust: '星辰',
  created_at: '注册',
  nPost: '主题',
  nComment: '评论',
  follows: '关注',
  fans: '粉丝',
  collectionCount: '收藏',
  created_at_str: '加入',
  roles: '角色',
  followed: '已关注',
};
export const DEFAULTS = {
  enabled: true,
  listPaging: true,
  commentPaging: true,
  restore: true,
  profiles: true,
  profileHours: 24,
  profileLabelKeys: ['rank', 'coin', 'nPost', 'nComment', 'created_at_str'],
  profileLabelSize: 'standard',
  levelColors: {
    '0': '#64748b',
    '1': '#ffffff',
    '2': '#2ea043',
    '3': '#0969da',
    '4': '#8250df',
    '5': '#ff61c0',
    '6': '#fb8500',
  } as Record<string, string>,
  prefetchScreens: 1.5,
  cacheMB: 40,
  cacheDays: 7,
  theme: 'system',
  palette: 'plain',
  hideBanner: true,
  hideQuick: false,
  hideStats: true,
  hideWelcome: true,
  directLinks: true,
  hot: true,
  previews: true,
  syncProgress: false,
};
export type Settings = typeof DEFAULTS;
export type Collection = 'settings' | 'rules' | 'ruleGroups' | 'phrases' | 'progress';
export type Operation = {
  id: string;
  device: string;
  seq: number;
  collection: Collection;
  key: string;
  value: unknown;
  ctx: Record<string, number>;
  at: number;
};
export type State = { schema: 1; device: string; seq: number; ops: Operation[] };
export type Rule = {
  target: 'keyword' | 'user';
  text: string;
  action: 'block' | 'mark';
  scope: 'all' | 'title' | 'body';
  areas?: { title: boolean; post: boolean; comment: boolean };
  label: string;
  color: string;
  enabled?: boolean;
  group?: string;
  styles?: { showGroupName?: boolean; avatarEffect?: string; [key: string]: unknown };
};
export type Entity<T = unknown> = { id: string; value: T; conflicts: Operation[] };
export type RuleGroup = Omit<Rule, 'text' | 'group'>;
export const uuid = () => crypto.randomUUID();
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export function createState(device: string = uuid()): State {
  return { schema: 1, device, seq: 0, ops: [] };
}
export function validateValue(collection: Collection, key: string, value: unknown): void {
  if (!key || key.length > 200) throw Error('记录 ID 无效');
  if (value === null) return;
  if (collection === 'settings') {
    if (!Object.hasOwn(DEFAULTS, key)) throw Error('未知设置');
    if (typeof value !== typeof DEFAULTS[key as keyof Settings]) throw Error('设置类型无效');
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 1000))
      throw Error('设置数值无效');
    if (key === 'theme' && !['system', 'light', 'dark'].includes(String(value)))
      throw Error('主题无效');
    if (key === 'palette' && !['plain', 'paper'].includes(String(value))) throw Error('配色无效');
    if (
      key === 'profileLabelKeys' &&
      (!Array.isArray(value) ||
        value.length > 16 ||
        value.some((k) => !Object.hasOwn(PROFILE_FIELDS, k)) ||
        new Set(value).size !== value.length)
    )
      throw Error('标签字段无效');
    if (key === 'profileLabelSize' && !['small', 'standard', 'large'].includes(String(value)))
      throw Error('标签大小无效');
    if (
      key === 'levelColors' &&
      (!value ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([k, v]) => !/^\d{1,2}$/.test(k) || typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v),
        ))
    )
      throw Error('等级颜色无效');
  } else if (collection === 'ruleGroups') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error('标签分组格式无效');
    if (key.length > 100 || Object.hasOwn(value, 'text') || Object.hasOwn(value, 'group'))
      throw Error('标签分组字段无效');
    const group = value as RuleGroup;
    if (typeof group.label !== 'string' || !group.label.trim()) throw Error('请填写标签名称');
    validateValue('rules', key, { ...group, text: 'group-validation' });
  } else if (collection === 'rules') {
    const r = value as Rule;
    if (
      !r ||
      !['keyword', 'user'].includes(r.target) ||
      !['block', 'mark'].includes(r.action) ||
      !['all', 'title', 'body'].includes(r.scope) ||
      typeof r.text !== 'string' ||
      !r.text.trim() ||
      r.text.length > 200 ||
      typeof r.label !== 'string' ||
      r.label.length > 80 ||
      !/^#[0-9a-f]{6}$/i.test(r.color)
    )
      throw Error('规则格式无效');
    if (r.enabled !== undefined && typeof r.enabled !== 'boolean') throw Error('规则开关无效');
    if (
      r.areas !== undefined &&
      (!r.areas ||
        Array.isArray(r.areas) ||
        Object.keys(r.areas).length !== 3 ||
        ['title', 'post', 'comment'].some((k) => typeof (r.areas as any)[k] !== 'boolean'))
    )
      throw Error('规则范围无效');
    if (r.group !== undefined && (typeof r.group !== 'string' || r.group.length > 100))
      throw Error('分组无效');
    if (r.styles !== undefined) {
      if (!r.styles || Array.isArray(r.styles) || typeof r.styles !== 'object')
        throw Error('样式无效');
      for (const [k, v] of Object.entries(r.styles)) {
        if (k === 'showGroupName' && typeof v === 'boolean') continue;
        if (k === 'avatarEffect' && ['none', 'rainbow', 'pulse', 'glow'].includes(String(v)))
          continue;
        if (
          [
            'groupNameColor',
            'titleColor',
            'keywordColor',
            'usernameColor',
            'borderColor',
            'backgroundColor',
          ].includes(k) &&
          v &&
          typeof v === 'object' &&
          typeof (v as any).enabled === 'boolean' &&
          /^#[0-9a-f]{6}$/i.test((v as any).color)
        )
          continue;
        throw Error('规则样式无效');
      }
    }
  } else if (collection === 'phrases') {
    if (typeof value !== 'string' || !value.trim() || value.length > 10000)
      throw Error('短语格式无效');
  } else if (collection === 'progress') {
    const p = value as { url?: string; floor?: number; seen?: number; title?: string; at?: number };
    if (
      !p ||
      typeof p.url !== 'string' ||
      !isForumURL(p.url) ||
      !/^\/post-\d+-\d+$/.test(new URL(p.url).pathname) ||
      !Number.isInteger(p.floor) ||
      p.floor! < 0 ||
      !Number.isInteger(p.seen) ||
      p.seen! < 0 ||
      typeof p.title !== 'string' ||
      p.title.length > 500 ||
      !Number.isFinite(p.at)
    )
      throw Error('阅读记录无效');
  }
}
export function validateOps(input: unknown): Operation[] {
  if (!Array.isArray(input) || input.length > 30000) throw Error('同步记录过多或格式无效');
  return input.map((x) => {
    if (
      !x ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(x.device) ||
      !Number.isSafeInteger(x.seq) ||
      x.seq < 1 ||
      x.id !== x.device + ':' + x.seq ||
      !['settings', 'rules', 'ruleGroups', 'phrases', 'progress'].includes(x.collection) ||
      typeof x.key !== 'string' ||
      !Number.isFinite(x.at) ||
      !x.ctx ||
      typeof x.ctx !== 'object' ||
      Array.isArray(x.ctx) ||
      Object.keys(x.ctx).length > 200
    )
      throw Error('同步操作无效');
    for (const [k, v] of Object.entries(x.ctx))
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(k) || !Number.isSafeInteger(v) || (v as number) < 0)
        throw Error('版本向量无效');
    if ((x.ctx[x.device] || 0) >= x.seq) throw Error('操作不能引用自身或未来版本');
    validateValue(x.collection, x.key, x.value);
    return {
      id: x.id,
      device: x.device,
      seq: x.seq,
      collection: x.collection,
      key: x.key,
      value: clone(x.value),
      ctx: { ...x.ctx },
      at: x.at,
    };
  });
}
export function stable(x: unknown): string {
  if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
  if (x && typeof x === 'object')
    return (
      '{' +
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + stable(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(x);
}
export function mergeOps(a: Operation[], b: Operation[]): Operation[] {
  const m = new Map(a.map((o) => [o.id, o]));
  for (const o of b) {
    const existing = m.get(o.id);
    if (existing && stable(existing) !== stable(o))
      throw Error('相同操作 ID 出现不同内容，已停止合并');
    m.set(o.id, o);
  }
  if (m.size > 30000) throw Error('同步操作达到首版容量上限，请先导出备份');
  return [...m.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function edit(state: State, collection: Collection, key: string, value: unknown): State {
  validateValue(collection, key, value);
  const ctx: Record<string, number> = Object.create(null);
  for (const o of state.ops) ctx[o.device] = Math.max(ctx[o.device] || 0, o.seq);
  const seq = Math.max(state.seq, ctx[state.device] || 0) + 1;
  return {
    ...state,
    seq,
    ops: [
      ...state.ops,
      {
        id: state.device + ':' + seq,
        device: state.device,
        seq,
        collection,
        key,
        value: clone(value),
        ctx,
        at: Date.now(),
      },
    ],
  };
}
export function entities<T = unknown>(
  ops: Operation[],
  collection: Collection,
  includeDeleted = false,
): Entity<T>[] {
  const groups = new Map<string, Operation[]>();
  for (const o of ops) {
    if (o.collection !== collection) continue;
    const group = groups.get(o.key);
    if (group) group.push(o);
    else groups.set(o.key, [o]);
  }
  return [...groups]
    .map(([id, all]) => {
      const observed: Record<string, number> = Object.create(null);
      for (const operation of all)
        for (const [device, seq] of Object.entries(operation.ctx))
          observed[device] = Math.max(observed[device] || 0, seq);
      const heads = all
        .filter((o) => (observed[o.device] || 0) < o.seq)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!heads.length) throw Error('同步记录的因果关系无效，已停止读取');
      const chosen = heads.find((o) => o.value === null) || heads[heads.length - 1];
      return {
        id,
        value: chosen?.value as T,
        conflicts: new Set(heads.map((o) => stable(o.value))).size > 1 ? heads : [],
      };
    })
    .filter((e) => includeDeleted || e.value !== null);
}
export function settingsFrom(ops: Operation[], overrides: Partial<Settings> = {}): Settings {
  const obj = { ...DEFAULTS };
  for (const e of entities(ops, 'settings')) (obj as Record<string, unknown>)[e.id] = e.value;
  for (const [k, v] of Object.entries(overrides)) {
    validateValue('settings', k, v);
    (obj as Record<string, unknown>)[k] = v;
  }
  obj.cacheMB = Math.max(5, Math.min(200, obj.cacheMB));
  obj.cacheDays = Math.max(1, Math.min(30, obj.cacheDays));
  obj.profileHours = Math.max(1, obj.profileHours);
  obj.prefetchScreens = Math.max(0.5, Math.min(3, obj.prefetchScreens));
  return obj;
}
export function isForumURL(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      ['www.nodeseek.com', 'nodeseek.com'].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.port
    );
  } catch {
    return false;
  }
}
export function routeKey(value: string, mode = 'replyTime'): string {
  const u = new URL(value);
  const post = u.pathname.match(/^\/post-(\d+)-(\d+)$/);
  if (post) return 'post:' + post[1];
  const path = u.pathname.replace(/\/page-\d+\/?$/, '/').replace(/\/$/, '') || '/';
  u.searchParams.delete('page');
  u.searchParams.set('sortBy', u.searchParams.get('sortBy') || mode);
  u.searchParams.sort();
  return 'list:' + path + '?' + u.searchParams;
}
export function pageNumber(value: string): number {
  const u = new URL(value);
  return Number(
    u.pathname.match(/(?:post-\d+-|page-)(\d+)$/)?.[1] || u.searchParams.get('page') || 1,
  );
}
export function canonicalPage(value: string, mode = 'replyTime'): string {
  const u = new URL(value);
  u.hash = '';
  if (!/^\/post-/.test(u.pathname))
    u.searchParams.set('sortBy', u.searchParams.get('sortBy') || mode);
  u.searchParams.sort();
  return u.href;
}
export function ruleMatch(
  r: Rule,
  item: {
    title: string;
    body: string;
    author: string;
    authorId: string;
    kind: 'list' | 'post';
    floor?: number;
  },
): boolean {
  if (r.enabled === false) return false;
  if (r.target === 'user') return r.text === item.authorId || r.text === item.author;
  if (r.areas) {
    const fields: string[] = [];
    if (r.areas.title && (item.kind === 'list' || item.floor === 0)) fields.push(item.title);
    if (item.kind === 'post' && (item.floor === 0 ? r.areas.post : r.areas.comment))
      fields.push(item.body);
    return fields.some((text) => text.toLocaleLowerCase().includes(r.text.toLocaleLowerCase()));
  }
  // Comments retain the thread title in cached metadata, but do not own it.
  const title = item.kind === 'list' || item.floor === 0 ? item.title : '';
  const hay =
    r.scope === 'title'
      ? title
      : r.scope === 'body'
        ? item.kind === 'post'
          ? item.body
          : ''
        : title + ' ' + item.body;
  return hay.toLocaleLowerCase().includes(r.text.toLocaleLowerCase());
}
export function importLegacy(
  payload: unknown,
): { collection: Collection; key: string; value: unknown }[] {
  const p = payload as Record<string, any>;
  if (!p || typeof p !== 'object') throw Error('配置格式无效');
  const o = p.options || p;
  const result: { collection: Collection; key: string; value: unknown }[] = [];
  const add = (collection: Collection, key: string, value: unknown) => {
    validateValue(collection, key, value);
    result.push({ collection, key, value });
  };
  const mapping: Record<string, keyof Settings> = {
    userStatsEnabled: 'profiles',
    userCacheHours: 'profileHours',
    directLinksEnabled: 'directLinks',
    profileLabelKeys: 'profileLabelKeys',
    profileLabelSize: 'profileLabelSize',
    levelColors: 'levelColors',
  };
  for (const [old, key] of Object.entries(mapping))
    if (o[old] !== undefined) add('settings', key, o[old]);
  const rule = (
    text: string,
    target: Rule['target'],
    action: Rule['action'] = 'block',
    label = '',
    color = '#397d9c',
    scope: Rule['scope'] = 'all',
    extra: Partial<Rule> = {},
    key: string = uuid(),
  ) => add('rules', key, { text, target, action, label, color, scope, ...extra });
  for (const text of o.blockedKeywords || []) {
    const entry = o.blockedKeywordScopes?.[String(text)];
    let areas: Rule['areas'];
    if (entry !== undefined) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.entries(entry).some(
          ([k, v]) => !['title', 'post', 'comment'].includes(k) || typeof v !== 'boolean',
        )
      )
        throw Error('旧关键词范围格式无效');
      areas = {
        title: entry.title !== false,
        post: entry.post !== false,
        comment: entry.comment !== false,
      };
    }
    rule(
      String(text),
      'keyword',
      'block',
      '',
      '#397d9c',
      'all',
      areas === undefined ? {} : { areas },
    );
  }
  for (const text of o.blockedUsers || []) rule(String(text), 'user');
  for (const text of o.quickPhrases || []) add('phrases', uuid(), String(text));
  for (const type of ['keywordGroups', 'userGroups'])
    for (const g of o.followRules?.[type] || []) {
      for (const text of g.keywords || g.users || g.items || [])
        rule(
          String(text),
          type === 'userGroups' ? 'user' : 'keyword',
          'mark',
          String(g.name || g.label || '标记').slice(0, 80),
          /^#[0-9a-f]{6}$/i.test(g.styles?.groupNameColor?.color)
            ? g.styles.groupNameColor.color
            : /^#[0-9a-f]{6}$/i.test(g.color)
              ? g.color
              : '#397d9c',
          type === 'keywordGroups' ? 'title' : 'all',
          {
            enabled: g.enabled !== false,
            group: String(g.id || g.name || '').slice(0, 100),
            ...(g.styles ? { styles: g.styles } : {}),
          },
          'legacy:' +
            type +
            ':' +
            String(g.id || g.name || '').slice(0, 80) +
            ':' +
            String(text).slice(0, 80),
        );
    }
  if (!result.length) throw Error('未识别可迁移的规则、短语或设置');
  return result;
}

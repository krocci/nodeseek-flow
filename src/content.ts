import {
  type Settings,
  type Rule,
  type RuleGroup,
  type Entity,
  routeKey,
  canonicalPage,
  pageNumber,
  uuid,
  isForumURL,
  ruleMatch,
  VERSION,
  PROFILE_FIELDS,
} from './core';
import {
  type Page,
  type Item,
  parsePage,
  itemsRoot,
  currentAccount,
  currentMode,
  identify,
  uniqueItems,
  renderItem,
  element,
  sanitize,
  RENDERER,
  upgradePage,
} from './adapter';
import { rpc, forumFetch } from './client';
import { installAttendance } from './attendance-content';
import { effectiveRules } from './rule-groups';
import { quickRules } from './quick-rules';
import { planRefresh, type UpdateBoundary } from './refresh';
type Snapshot = {
  attendanceEnabled?: boolean;
  settings: Settings;
  rules: Entity<Rule>[];
  ruleGroups?: Entity<RuleGroup>[];
  phrases: Entity<string>[];
  progress: Entity<any>[];
};
type Anchor = { id: string; offset: number; floor?: number; url?: string; index?: number };
type Session = {
  urls: string[];
  anchor: Anchor | null;
  at: number;
  snapshot?: string;
  boundary?: UpdateBoundary;
};
let config: Snapshot,
  feed: Feed | null = null,
  account = '',
  activeURL = '',
  routeTimer = 0,
  observer: MutationObserver | null = null,
  routeController = new AbortController();
const media = matchMedia('(prefers-color-scheme: dark)');
document.documentElement.dataset.nfAlign = 'pending';
setTimeout(() => {
  if (document.documentElement.dataset.nfAlign === 'pending')
    delete document.documentElement.dataset.nfAlign;
}, 3000);
try {
  const early = JSON.parse(localStorage.getItem('nsflow-appearance') || 'null');
  const mode = early?.theme || 'system';
  document.documentElement.dataset.nfTheme =
    early?.enabled === false
      ? 'off'
      : mode === 'system'
        ? media.matches
          ? 'dark'
          : 'light'
        : ['light', 'dark'].includes(mode)
          ? mode
          : 'light';
  document.documentElement.dataset.nfPalette = early?.palette === 'paper' ? 'paper' : 'plain';
} catch {}
function theme() {
  if (!config) return;
  const s = config.settings;
  document.documentElement.dataset.nfVersion = VERSION;
  document.documentElement.dataset.nfTheme = !s.enabled
    ? 'off'
    : s.theme === 'system'
      ? media.matches
        ? 'dark'
        : 'light'
      : s.theme;
  document.documentElement.dataset.nfPalette = s.palette;
  if (s.enabled && document.body)
    document.body.classList.toggle(
      'dark-layout',
      document.documentElement.dataset.nfTheme === 'dark',
    );
  decorateThemeControls();
  try {
    localStorage.setItem(
      'nsflow-appearance',
      JSON.stringify({ theme: s.theme, palette: s.palette, enabled: s.enabled }),
    );
  } catch {}
}
media.addEventListener('change', theme);
const themeSelector = '.color-theme-switcher,[title="切换主题模式"],[data-nf-theme-toggle]';
function decorateThemeControls() {
  if (!config || !document.body) return;
  const dark = document.documentElement.dataset.nfTheme === 'dark';
  for (const control of document.querySelectorAll<HTMLElement>(themeSelector)) {
    if (!config.settings.enabled) {
      if (!control.dataset.nfThemeToggle) continue;
      control.title = control.dataset.nfThemeTitle || '';
      control.removeAttribute('aria-label');
      delete control.dataset.nfThemeToggle;
      continue;
    }
    if (!control.dataset.nfThemeToggle) control.dataset.nfThemeTitle = control.title;
    control.dataset.nfThemeToggle = '1';
    const label = dark ? '切换到浅色（Flow）' : '切换到深色（Flow）';
    if (control.title !== label) control.title = label;
    control.setAttribute('aria-label', label);
    if (control.tagName !== 'BUTTON' && control.tagName !== 'A') {
      control.setAttribute('role', 'button');
      control.tabIndex = 0;
    }
    const icon = control.querySelector('svg use');
    if (icon) icon.setAttribute('href', dark ? '#sun-one' : '#moon');
  }
}
let themeSave: Promise<unknown> = Promise.resolve();
function takeOverTheme(event: Event) {
  if (
    !config?.settings.enabled ||
    !(event.target instanceof Element) ||
    !event.target.closest(themeSelector)
  )
    return;
  event.preventDefault();
  event.stopImmediatePropagation();
  config.settings.theme = document.documentElement.dataset.nfTheme === 'dark' ? 'light' : 'dark';
  const choice = config.settings.theme;
  theme();
  themeSave = themeSave
    .catch(() => {})
    .then(() => rpc('themeChoice', { theme: choice }))
    .catch((e) => toast('主题已切换，但保存失败：' + e.message));
}
function button(label: string, fn: () => unknown) {
  const b = element('button', 'nf-btn', label);
  b.type = 'button';
  b.addEventListener('click', () => Promise.resolve(fn()).catch((e) => toast(e.message)));
  return b;
}
function toast(message: string) {
  let box = document.querySelector('#nf-toast') as HTMLElement | null;
  if (!box) {
    box = element('div', 'nf-toast');
    box.id = 'nf-toast';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  box.textContent = message;
  box.hidden = false;
  setTimeout(() => {
    if (box?.textContent === message) box.hidden = true;
  }, 6000);
}
let layoutKey = '';
let layoutFrame = 0;
let profileRuleButtons: (() => void) | undefined;
function applyLayout() {
  const s = config.settings;
  document.documentElement.classList.toggle(
    'nf-list-view',
    s.enabled && !!itemsRoot('list') && !location.pathname.startsWith('/post-'),
  );
  document.documentElement.classList.toggle('nf-list-paging', s.enabled && s.listPaging);
  document.documentElement.classList.toggle('nf-hide-banner', s.enabled && s.hideBanner);
  document.documentElement.classList.toggle('nf-hide-quick', s.enabled && s.hideQuick);
  document.documentElement.classList.toggle(
    'nf-post-view',
    s.enabled && location.pathname.startsWith('/post-'),
  );
  profileRuleButtons?.();
  const key = [location.pathname, innerWidth, s.enabled, s.hideBanner].join('|');
  const column = document.querySelector('#nsk-body-left');
  if (!s.enabled) {
    delete document.documentElement.dataset.nfAlign;
    document.documentElement.style.removeProperty('--nf-left-top');
    layoutKey = '';
    cancelAnimationFrame(layoutFrame);
  } else if (column && key !== layoutKey) {
    layoutKey = key;
    document.documentElement.dataset.nfAlign = 'pending';
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      document.documentElement.style.setProperty(
        '--nf-left-top',
        Math.max(0, column.getBoundingClientRect().top + window.scrollY) + 'px',
      );
      document.documentElement.dataset.nfAlign = 'ready';
    });
  }
  for (const panel of document.querySelectorAll('#nsk-right-panel-container > *')) {
    const t = panel.textContent || '';
    const hide =
      (s.hideStats && t.includes('目前论坛共有')) || (s.hideWelcome && t.includes('欢迎新用户'));
    panel.classList.toggle(
      'nf-layout-hidden',
      s.enabled && hide && !panel.querySelector('.user-head'),
    );
  }
}
function insertEditor(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = uuid();
    const listener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('nsflow:editor-result', listener);
      resolve(detail.ok === true);
    };
    const timer = setTimeout(() => {
      window.removeEventListener('nsflow:editor-result', listener);
      resolve(false);
    }, 1500);
    window.addEventListener('nsflow:editor-result', listener);
    window.dispatchEvent(
      new CustomEvent('nsflow:editor', { detail: { id, action: 'insert', text } }),
    );
  });
}
function makeDialog(title: string) {
  document.querySelector('#nf-dialog')?.remove();
  const d = element('dialog', 'nf-dialog');
  d.id = 'nf-dialog';
  const header = element('header', 'nf-dialog-head');
  header.append(
    element('h2', '', title),
    button('关闭', () => d.close()),
  );
  d.append(header);
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
async function showPhrases() {
  const d = makeDialog('快捷短语');
  if (!config.phrases.length)
    d.append(element('p', 'nf-muted', '还没有短语，请在设置中添加或导入旧配置。'));
  for (const phrase of config.phrases)
    d.append(
      button(phrase.value, async () => {
        d.close();
        if (!(await insertEditor(phrase.value))) toast('没有找到可用编辑器，请先打开回复框');
      }),
    );
  d.append(button('管理短语', () => rpc('options')));
}
async function fillHot(d: HTMLElement) {
  const tabs = element('div', 'nf-row');
  const list = element('ol', 'nf-hot');
  const status = element('p', 'nf-muted', '第三方来源：bimg.eu.org；榜单由该服务生成');
  let expanded = false;
  const toggle = button('展开全部 ▼', () => {
    expanded = !expanded;
    updateExpansion();
  });
  toggle.classList.add('nf-hot-expand');
  const updateExpansion = () => {
    [...list.children].forEach(
      (row, index) => ((row as HTMLElement).hidden = !expanded && index >= 10),
    );
    toggle.hidden = list.children.length <= 10;
    toggle.textContent = expanded ? '收起榜单 ▲' : '展开全部 ▼';
    toggle.setAttribute('aria-expanded', String(expanded));
  };
  toggle.hidden = true;
  let generation = 0;
  const load = async (mode: string) => {
    const g = ++generation;
    status.textContent = '正在更新，已有榜单暂时保留…';
    try {
      const data = await rpc('hot', { mode });
      if (g !== generation || !d.isConnected) return;
      list.replaceChildren();
      for (const p of data.posts) {
        const li = element('li');
        const a = element('a', '', p.title);
        a.title = p.title;
        a.href = '/post-' + p.id + '-1';
        li.append(
          a,
          element(
            'small',
            'nf-muted',
            p.author +
              ' · 热度 ' +
              (Number.isFinite(Number(p.score)) ? Number(p.score).toFixed(1) : '—'),
          ),
        );
        list.append(li);
      }
      expanded = false;
      updateExpansion();
      status.textContent =
        (data.stale ? '缓存 · 暂时无法更新 · ' : '') +
        '获取于 ' +
        new Date(data.at).toLocaleString() +
        ' · 数据源 bimg.eu.org';
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };
  for (const [label, mode] of [
    ['实时', 'hot'],
    ['日榜', 'daily'],
    ['周榜', 'weekly'],
  ])
    tabs.append(button(label, () => load(mode)));
  d.append(tabs, status, list, toggle);
  await load('hot');
}
function sidebarHot() {
  const existing = document.querySelector('#nf-hot-panel');
  if (!config.settings.enabled || !config.settings.hot) {
    existing?.remove();
    return;
  }
  const side = document.querySelector('#nsk-right-panel-container');
  if (!side) return;
  const mobile = getComputedStyle(side).display === 'none';
  const host = side;
  const place = (panel: Element) => {
    (panel as HTMLElement).hidden = mobile;
    const post = [...host.children].find(
      (e) =>
        e.matches('a.new-discussion') ||
        e.querySelector('a.new-discussion,a[href="/new-discussion"],a[href^="/new-discussion?"]'),
    );
    const anchor = post || host.querySelector(':scope > .user-card');
    if (anchor) {
      if (anchor.nextElementSibling !== panel) anchor.after(panel);
    } else if (panel.parentElement !== host) host.append(panel);
  };
  if (existing) {
    place(existing);
    return;
  }
  const panel = element('section', 'nsk-panel nf-hot-panel');
  panel.id = 'nf-hot-panel';
  panel.append(element('h3', '', 'NodeSeek 热榜'));
  place(panel);
  fillHot(panel).catch(() => {});
}
function toolbar() {
  document.querySelector('#nf-tools')?.remove();
  const bar = element('div', 'nf-tools');
  bar.id = 'nf-tools';
  bar.setAttribute('aria-label', 'NodeSeek Flow');
  bar.append(
    button('Flow 设置', () => rpc('options')),
    button('短语', showPhrases),
  );
  if (config.settings.hot) bar.append(button('热榜', () => fillHot(makeDialog('NodeSeek 热榜'))));
  const blockedControl = button('', () => {
    document.documentElement.classList.toggle('nf-show-blocked');
    updateBlockedControl();
  });
  blockedControl.id = 'nf-blocked-toggle';
  bar.append(blockedControl);
  bar.append(
    button('阅读记录', () => {
      const d = makeDialog('继续阅读');
      const records = config.progress
        .filter((p) => p.id.startsWith(account + ':'))
        .sort((a, b) => b.value.at - a.value.at)
        .slice(0, 50);
      if (!records.length) d.append(element('p', '', '暂无阅读记录'));
      for (const p of records) {
        const a = element('a', 'nf-history', p.value.title + ' · #' + p.value.floor);
        a.href = p.value.url;
        d.append(a);
      }
    }),
  );
  const disclosure = element('details', 'nf-tools-disclosure');
  const menu = element('div', 'nf-tools-menu');
  menu.append(...bar.childNodes);
  disclosure.append(element('summary', '', 'Flow'), menu);
  menu.addEventListener('click', (event) => {
    if ((event.target as Element).closest('button')) disclosure.open = false;
  });
  bar.append(disclosure);
  document.body.append(bar);
  updateBlockedControl();
  sidebarHot();
  refreshNavigation();
}
function updateBlockedControl() {
  const control = document.querySelector<HTMLButtonElement>('#nf-blocked-toggle');
  if (!control) return;
  const count = document.querySelectorAll(
    '.post-list-item.nf-blocked,.content-item.nf-blocked',
  ).length;
  const shown = document.documentElement.classList.contains('nf-show-blocked');
  control.textContent = (shown ? '重新隐藏屏蔽项' : '恢复显示屏蔽项') + '（' + count + '）';
  control.disabled = count === 0;
  control.setAttribute('aria-pressed', String(shown));
  control.title = '仅本页临时显示，不修改屏蔽规则；新加载的条目遵循当前选择';
}
function refreshNavigation() {
  const native = document.querySelector('#fast-nav-button-group');
  const kind = /^\/post-\d+-\d+$/.test(location.pathname) ? 'post' : 'list';
  if (!config.settings.enabled || !itemsRoot(kind)) {
    document.querySelector('#nf-refresh')?.remove();
    document.querySelector('#nf-reading-nav')?.remove();
    return;
  }
  let host = native || document.querySelector('#nf-reading-nav');
  if (!host) {
    host = element('div', 'nf-reading-nav');
    host.id = 'nf-reading-nav';
    const top = button('↑', () => scrollTo({ top: 0, behavior: 'smooth' }));
    top.setAttribute('aria-label', '前往顶端');
    const bottom = button('↓', () =>
      scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }),
    );
    bottom.setAttribute('aria-label', '前往底端');
    host.append(top, bottom);
    document.body.append(host);
  }
  let control = document.querySelector<HTMLButtonElement>('#nf-refresh');
  if (!control) {
    control = button('', () => (feed ? feed.refreshNow() : location.reload()));
    control.id = 'nf-refresh';
    control.className = 'nav-item-btn nf-refresh-btn';
    control.append(element('span', '', '↻'), element('small', '', '刷新'));
    control.setAttribute('aria-label', '刷新内容');
  }
  if (control.parentElement !== host) host.append(control);
  const bar = document.querySelector('#nf-tools');
  if (bar && bar.parentElement !== host) host.append(bar);
  if (native) document.querySelector('#nf-reading-nav')?.remove();
  control.classList.toggle('nf-refresh-native', !!native);
  const busy = !!feed?.loading || !!feed?.committing;
  control.disabled = busy;
  control.setAttribute('aria-busy', String(busy));
  control.dataset.ready = feed?.pendingFresh ? 'true' : 'false';
  control.title =
    feed?.refreshProgress ||
    (feed?.pendingFresh
      ? '发现更新，点击合并并查看；保留已续出的内容'
      : '刷新当前列表或已加载评论；保留续页内容');
  const caption = control.querySelector('small');
  if (caption) caption.textContent = feed?.committing ? '保存中' : busy ? '加载中' : '刷新';
}
class Feed {
  root: Element;
  controller = new AbortController();
  pages: Page[] = [];
  next = '';
  ready: Page | null = null;
  loading = false;
  paused = false;
  disposed = false;
  sentinel = element('div', 'nf-pager');
  prefetchObserver: IntersectionObserver;
  appendObserver: IntersectionObserver;
  page: Page;
  sessionKey: string;
  scope: string;
  saveTimer = 0;
  anchor: Anchor | null = null;
  restoring = false;
  seen = new Map<string, Item>();
  lastCheck = 0;
  status = element('span', 'nf-muted');
  updateButton = button('检查更新', () =>
    this.pendingFresh ? this.applyFresh(this.pendingFresh) : this.check(true),
  );
  restoreCleanup: (() => void) | null = null;
  snapshotId: string = uuid();
  storedSnapshots = new Set<string>();
  pendingPersist: Promise<void> = Promise.resolve();
  persisting = false;
  persistAgain = false;
  committedSession: Session | null = null;
  committing = false;
  pendingFresh: Page[] | null = null;
  refreshProgress = '';
  boundary?: UpdateBoundary;
  divider: HTMLElement | null = null;
  constructor(page: Page, root: Element, scope: string) {
    this.page = page;
    this.root = root;
    this.scope = scope;
    this.sessionKey = page.route + '|start:' + pageNumber(page.url);
    this.sentinel.append(
      this.status,
      button('加载下一页', () => this.append(true)),
      this.updateButton,
    );
    root.after(this.sentinel);
    this.prefetchObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.prefetch();
      },
      { rootMargin: Math.round(innerHeight * config.settings.prefetchScreens) + 'px' },
    );
    this.appendObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.append();
      },
      { rootMargin: '200px' },
    );
  }
  cache<T = any>(kind: string, key: string) {
    return rpc<T>('cacheGet', { account: this.scope, kind, key });
  }
  put(kind: string, key: string, value: unknown) {
    return rpc('cachePut', { account: this.scope, kind, key, value });
  }
  async start() {
    this.pages = [this.page];
    this.next = this.page.next;
    this.index();
    let session: Session | null = null;
    try {
      session = await this.cache('session', this.sessionKey);
      const fast = JSON.parse(
        sessionStorage.getItem('nf-anchor:' + this.scope + ':' + this.sessionKey) || 'null',
      );
      if (fast?.urls?.length && (!session || fast.at > session.at)) session = fast;
    } catch {}
    if (this.disposed) return;
    let didRestore = false;
    if (
      config.settings.restore &&
      session &&
      session.at > Date.now() - config.settings.cacheDays * 86400000
    ) {
      const restored: Page[] = [];
      if (session.snapshot) this.snapshotId = session.snapshot;
      for (const url of session.urls.slice(0, 40)) {
        const p = await this.cache<Page>(
          session.snapshot ? 'session' : 'page',
          session.snapshot ? 'snapshot:' + session.snapshot + ':' + url : url,
        ).catch(() => null);
        if (!p || p.route !== this.page.route) break;
        if (p.renderer !== RENDERER) {
          // Retain session URLs/anchor while upgrading incomplete 0.1.0 page records.
          try {
            const upgraded =
              upgradePage(p) || (url === this.page.url ? this.page : await this.fetchPage(url));
            restored.push(upgraded);
          } catch {
            break;
          }
          continue;
        }
        restored.push(p);
        if (session.snapshot) this.storedSnapshots.add(url);
      }
      if (this.disposed) return;
      if (restored.length) {
        didRestore = true;
        this.pages = restored;
        this.next = restored.at(-1)!.next;
        this.renderRestore();
        this.anchor = session.anchor;
        this.committedSession = { ...session, urls: restored.map((p) => p.url) };
        this.boundary = session.boundary;
        try {
          const fast = JSON.parse(
            sessionStorage.getItem('nf-anchor:' + this.scope + ':' + this.sessionKey) || 'null',
          );
          if (fast?.at > session.at) this.anchor = fast.anchor;
        } catch {}
        if (!location.hash) this.restoreAnchor();
        this.status.textContent = '已恢复 ' + restored.length + ' 页 · 检查更新不会移动当前位置';
      }
    }
    if (!didRestore) {
      this.snapshotId = uuid();
      await this.put('page', this.page.url, this.page).catch(() => {});
    }
    if (this.disposed) return;
    this.index();
    this.enhance();
    this.renderBoundary();
    this.prefetchObserver.observe(this.sentinel);
    this.appendObserver.observe(this.sentinel);
    this.updateStatus();
    if (didRestore && session && this.pages.length < session.urls.length)
      this.updateStatus('部分旧缓存已过期 · 已恢复 ' + this.pages.length + ' 页，可继续续页');
    if (location.hash) {
      const floor = decodeURIComponent(location.hash.slice(1));
      const el = this.root.querySelector('[id="' + CSS.escape(floor) + '"]');
      el?.scrollIntoView();
    }
    if (session)
      setTimeout(() => {
        if (!this.disposed) this.check(false);
      }, 3000);
    this.save();
    await this.persist();
    refreshNavigation();
  }
  index() {
    this.seen = new Map(uniqueItems(this.pages).map((i) => [i.id, i]));
  }
  renderRestore() {
    this.index();
    if (this.page.kind === 'list') {
      this.root.replaceChildren(...uniqueItems(this.pages).map(renderItem));
    } else {
      const live = new Set([...this.root.children].map((e) => identify(e, 'post')));
      for (const item of uniqueItems(this.pages))
        if (!live.has(item.id)) {
          this.root.append(renderItem(item));
          live.add(item.id);
        }
    }
  }
  getAnchor(): Anchor | null {
    for (const e of this.root.children) {
      if (!e.matches('.content-item,.post-list-item')) continue;
      const r = e.getBoundingClientRect();
      if (r.bottom > 100 && r.top < innerHeight) {
        const id = (e as HTMLElement).dataset.nfId || identify(e, this.page.kind);
        const item = this.seen.get(id);
        return {
          id,
          offset: r.top,
          floor: item?.floor,
          url: item?.url,
          index: [...this.root.children].indexOf(e),
        };
      }
    }
    return this.anchor;
  }
  restoreAnchor() {
    if (!this.anchor) return;
    this.restoring = true;
    const a = this.anchor;
    let touched = false;
    const stop = () => {
      touched = true;
    };
    window.addEventListener('wheel', stop, { once: true, passive: true });
    window.addEventListener('touchstart', stop, { once: true, passive: true });
    window.addEventListener('keydown', stop, { once: true });
    const apply = () => {
      if (touched || this.disposed) return;
      const children = [...this.root.children];
      let e =
        children.find(
          (e) => ((e as HTMLElement).dataset.nfId || identify(e, this.page.kind)) === a.id,
        ) || (a.index !== undefined ? children[Math.min(a.index, children.length - 1)] : null);
      if (
        e?.classList.contains('nf-blocked') &&
        !document.documentElement.classList.contains('nf-show-blocked')
      ) {
        const index = children.indexOf(e);
        e =
          [...children.slice(index + 1), ...children.slice(0, index).reverse()].find(
            (row) =>
              row.matches('.content-item,.post-list-item') && !row.classList.contains('nf-blocked'),
          ) || null;
      }
      if (e) scrollBy(0, e.getBoundingClientRect().top - a.offset);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(this.root);
    this.restoreCleanup = () => {
      ro.disconnect();
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
      this.restoring = false;
    };
    setTimeout(() => this.restoreCleanup?.(), 2500);
  }
  save() {
    if (this.disposed || this.restoring || this.committing) return;
    this.anchor = this.getAnchor();
    try {
      // Never point the synchronous anchor at snapshot pages not yet committed.
      if (this.committedSession)
        sessionStorage.setItem(
          'nf-anchor:' + this.scope + ':' + this.sessionKey,
          JSON.stringify({ ...this.committedSession, at: Date.now(), anchor: this.anchor }),
        );
    } catch {}
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persist(), 450);
  }
  async persist() {
    if (this.disposed || this.committing) return;
    if (this.persisting) {
      this.persistAgain = true;
      return this.pendingPersist;
    }
    this.persisting = true;
    const pages = [...this.pages];
    const session: Session = {
      urls: pages.map((p) => p.url),
      anchor: this.anchor,
      at: Date.now(),
      snapshot: this.snapshotId,
      boundary: this.boundary,
    };
    const write = this.pendingPersist.then(async () => {
      for (const p of pages)
        if (!this.storedSnapshots.has(p.url)) {
          await this.put('session', 'snapshot:' + session.snapshot + ':' + p.url, p);
          this.storedSnapshots.add(p.url);
        }
      // Commit the pointer only after all snapshot pages have been stored.
      await this.put('session', this.sessionKey, session);
      this.committedSession = session;
      try {
        sessionStorage.setItem(
          'nf-anchor:' + this.scope + ':' + this.sessionKey,
          JSON.stringify(session),
        );
      } catch {}
    });
    this.pendingPersist = write.catch((e) => toast('缓存保存失败：' + e.message));
    await this.pendingPersist;
    this.persisting = false;
    if (this.persistAgain) {
      this.persistAgain = false;
      if (!this.disposed && !this.committing) void this.persist();
    }
    if (this.page.kind === 'post' && this.anchor?.floor !== undefined) {
      const postId = this.page.route.slice(5);
      const floor = this.anchor.floor;
      await rpc('progress', {
        account: this.scope,
        postId,
        value: {
          floor,
          seen: floor,
          url: this.anchor.url || this.page.url,
          title: this.page.items[0]?.title || document.title,
          at: Date.now(),
        },
      }).catch(() => {});
    }
  }
  async fetchPage(url: string): Promise<Page> {
    const r = await forumFetch(url, this.controller.signal);
    const html = await r.text();
    if (html.length > 4_000_000) throw Error('页面过大，已停止追加');
    const p = parsePage(new DOMParser().parseFromString(html, 'text/html'), url, this.page.mode);
    if (p.route !== this.page.route) throw Error('页面模式已变化');
    if (!p.items.length) throw Error('下一页没有可读取内容');
    return p;
  }
  async prefetch(force = false) {
    if (
      this.disposed ||
      this.loading ||
      this.ready ||
      !this.next ||
      (this.paused && !force) ||
      document.hidden
    )
      return;
    this.loading = true;
    this.updateStatus('提前加载下一页…');
    const url = this.next;
    try {
      const stored = await this.cache<Page>('page', url);
      const cached = stored ? upgradePage(stored) : null;
      const p =
        cached &&
        cached.renderer === RENDERER &&
        cached.route === this.page.route &&
        Date.now() - cached.at < config.settings.cacheDays * 86400000
          ? cached
          : await this.fetchPage(url);
      if (this.disposed || url !== this.next) return;
      this.ready = p;
      await this.put('page', url, p);
      this.updateStatus('下一页已准备好');
      if (this.sentinel.getBoundingClientRect().top < innerHeight + 200)
        queueMicrotask(() => this.append());
    } catch (e) {
      if (this.disposed) return;
      this.paused = true;
      this.updateStatus((e as Error).message + '；可手动重试');
    } finally {
      this.loading = false;
      refreshNavigation();
    }
  }
  async append(force = false) {
    if (this.disposed || this.committing || (this.paused && !force)) return;
    if (force) this.paused = false;
    if (!this.ready) {
      await this.prefetch(force);
      if (!this.ready) return;
    }
    const p = this.ready;
    this.ready = null;
    if (this.pages.some((x) => x.url === p.url)) {
      this.next = '';
      this.updateStatus();
      return;
    }
    if (this.pages.length >= 40) {
      this.paused = true;
      this.ready = p;
      this.updateStatus('已加载 40 页，请用原分页继续，避免手机内存过高');
      return;
    }
    for (const i of p.items)
      if (!this.seen.has(i.id)) {
        this.root.append(renderItem(i));
        this.seen.set(i.id, i);
      }
    this.pages.push(p);
    this.next = p.next;
    this.enhance();
    this.save();
    this.updateStatus();
    await this.persist();
    if (this.sentinel.getBoundingClientRect().top < innerHeight * 2.5)
      setTimeout(() => this.prefetch(), 500);
  }
  updateStatus(message?: string) {
    this.status.textContent =
      message ||
      '已加载 ' + this.pages.length + ' 页' + (this.next ? ' · 接近末尾自动续页' : ' · 已到末页');
    refreshNavigation();
  }
  async refreshNow() {
    if (this.pendingFresh) await this.applyFresh(this.pendingFresh);
    else await this.check(true, true);
  }
  renderBoundary() {
    this.divider?.remove();
    this.divider = null;
    const b = this.boundary;
    if (!b) return;
    const nodes = [...this.root.children].filter((e) => e.matches('.post-list-item,.content-item'));
    const matching = nodes.filter((e) => b.ids.includes(identify(e, this.page.kind)));
    const label =
      b.kind === 'list'
        ? '以上为本次更新 · ' + b.added + ' 条新帖 / ' + b.edited + ' 条变化 · 以下保留原阅读列表'
        : b.ids.length
          ? '以下为本次新增的 ' + b.added + ' 条评论'
          : '已更新主帖或已有评论 · 原楼层顺序保留';
    const divider = element('li', 'nf-update-divider', label);
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-label', label);
    divider.append(element('small', '', new Date(b.at).toLocaleTimeString()));
    if (b.kind === 'list' && matching.length) matching.at(-1)!.after(divider);
    else if (b.kind === 'post' && matching.length) matching[0].before(divider);
    else this.root.prepend(divider);
    this.divider = divider;
  }
  async applyFresh(fresh: Page[]) {
    if (this.disposed || this.committing) return;
    const plan = planRefresh(this.pages, fresh);
    if (!plan.changed) {
      this.pendingFresh = null;
      this.updateButton.textContent = '检查更新';
      toast('当前内容没有变化');
      refreshNavigation();
      return;
    }
    this.committing = true;
    this.refreshProgress = '正在保存更新；原阅读内容保留，缓存超时后可重试';
    this.updateButton.disabled = true;
    refreshNavigation();
    clearTimeout(this.saveTimer);
    const snapshot = uuid();
    const anchor = this.getAnchor();
    const session: Session = {
      urls: plan.pages.map((p) => p.url),
      anchor,
      at: Date.now(),
      snapshot,
      boundary: plan.boundary,
    };
    try {
      await this.pendingPersist;
      for (const p of plan.pages) {
        if (this.disposed) return;
        await this.put('session', 'snapshot:' + snapshot + ':' + p.url, p);
      }
      if (this.disposed) return;
      await this.put('session', this.sessionKey, session);
      if (this.disposed) return;
      // Only a complete, committed snapshot may replace the visible reading chain.
      this.pages = plan.pages;
      this.page = this.pages[0];
      this.snapshotId = snapshot;
      this.storedSnapshots = new Set(session.urls);
      this.committedSession = session;
      this.boundary = plan.boundary;
      this.pendingFresh = null;
      this.ready = null;
      this.next = this.pages.at(-1)!.next;
      this.index();
      if (this.page.kind === 'list') this.renderRestore();
      else {
        // Update only article bodies; keep the native menus and draft editor alive.
        for (const item of uniqueItems(fresh)) {
          const node = [...this.root.children].find((e) => identify(e, 'post') === item.id);
          if (!node) this.root.append(renderItem(item));
          else {
            const body = node.querySelector<HTMLElement>('.post-content');
            if (body && sanitize(body.innerHTML, item.url) !== item.body)
              body.innerHTML = sanitize(item.body, item.url);
          }
        }
        if (plan.mainChanged && this.page.main) {
          const body = document.querySelector('.content-item[id="0"] .post-content');
          if (body) body.innerHTML = sanitize(this.page.main.body, this.page.main.url);
          const title = document.querySelector('h1');
          if (title) title.textContent = this.page.main.title;
        }
        window.dispatchEvent(
          new CustomEvent('nsflow:menus', {
            detail: uniqueItems(fresh).map((i) => ({
              id: i.id,
              floor: i.floor,
              nativeComment: i.nativeComment,
              refresh: true,
            })),
          }),
        );
      }
      this.enhance();
      this.renderBoundary();
      this.updateStatus('已增量刷新 · 保留 ' + this.pages.length + ' 页阅读内容');
      this.updateButton.textContent = '检查更新';
      this.restoreCleanup?.();
      const firstUpdate = [...this.root.children].find(
        (e) => identify(e, this.page.kind) === plan.boundary.ids[0],
      );
      (this.page.kind === 'post' ? this.divider : firstUpdate || this.divider)?.scrollIntoView({
        block: 'start',
      });
      this.anchor = this.getAnchor();
      try {
        sessionStorage.setItem(
          'nf-anchor:' + this.scope + ':' + this.sessionKey,
          JSON.stringify({
            ...session,
            at: Math.max(Date.now(), session.at + 1),
            anchor: this.anchor,
          }),
        );
      } catch {}
      for (const p of fresh) await this.put('page', p.url, p).catch(() => {});
      toast(
        '已刷新：' +
          plan.boundary.added +
          ' 条新增，' +
          plan.boundary.edited +
          ' 条变化' +
          (plan.mainChanged ? '，主帖已更新' : ''),
      );
    } catch (e) {
      if (!this.disposed) {
        this.status.textContent = '更新未完成，原阅读内容保留；请点击刷新重试';
        toast('刷新失败：' + (e as Error).message);
      }
    } finally {
      this.committing = false;
      this.refreshProgress = '';
      this.updateButton.disabled = false;
      refreshNavigation();
      sidebarHot();
    }
  }
  async check(manual: boolean, apply = false) {
    if (
      this.disposed ||
      document.hidden ||
      this.loading ||
      this.committing ||
      (!manual && Date.now() - this.lastCheck < 120000)
    )
      return;
    this.lastCheck = Date.now();
    this.loading = true;
    refreshNavigation();
    try {
      const fresh = [await this.fetchPage(this.page.url)];
      if (this.page.kind === 'post') {
        const tail = this.pages.at(-1)!;
        const targets = this.pages.slice(1).filter((p) => manual || p.url === tail.url);
        for (const [index, p] of targets.entries()) {
          this.refreshProgress = `刷新已加载评论 ${index + 2}/${targets.length + 1}`;
          refreshNavigation();
          fresh.push(await this.fetchPage(p.url));
          if (this.disposed) return;
        }
        const latestTail = fresh.at(-1)!;
        if (!tail.next && latestTail.next && this.pages.length < 40)
          fresh.push(await this.fetchPage(latestTail.next));
      }
      if (this.disposed) return;
      if (!planRefresh(this.pages, fresh).changed) {
        this.pendingFresh = null;
        this.updateButton.textContent = '检查更新';
        if (manual) toast('当前页没有变化');
        return;
      }
      this.pendingFresh = fresh;
      this.updateButton.textContent = '发现更新 · 点击查看最新';
      if (apply) await this.applyFresh(fresh);
    } catch (e) {
      if (manual && !this.disposed) toast((e as Error).message);
    } finally {
      this.loading = false;
      this.refreshProgress = '';
      refreshNavigation();
    }
  }
  enhance() {
    enhanceItems(this.root, this.seen);
    enhanceMain(this.page);
    if (this.page.kind === 'post') {
      const mount = () => {
        if (this.disposed) return;
        window.dispatchEvent(
          new CustomEvent('nsflow:menus', {
            detail: [...this.seen.values()].map((i) => ({
              id: i.id,
              floor: i.floor,
              nativeComment: i.nativeComment,
            })),
          }),
        );
      };
      mount();
      // Native Vue hydration may finish after the cached DOM is already restored.
      for (const delay of [250, 1000, 2500]) setTimeout(mount, delay);
    }
  }
  dispose() {
    this.anchor = this.getAnchor();
    this.persist();
    this.disposed = true;
    this.controller.abort();
    this.prefetchObserver.disconnect();
    this.appendObserver.disconnect();
    this.restoreCleanup?.();
    clearTimeout(this.saveTimer);
    this.sentinel.remove();
    this.divider?.remove();
  }
}
const profilePending = new Map<string, Promise<void>>();
function enhanceMain(page: Page) {
  const main = document.querySelector('.content-item[id="0"]');
  if (page.main && main?.parentElement)
    enhanceItems(main.parentElement, new Map([[page.main.id, page.main]]));
}
let profileObserver: IntersectionObserver | null = null;
function profileLabel(label: HTMLElement, record: any) {
  const detail = record.detail || {};
  label.replaceChildren();
  label.dataset.size = config.settings.profileLabelSize;
  const color = config.settings.levelColors[String(detail.rank)] || '#64748b';
  for (const key of config.settings.profileLabelKeys) {
    let value = detail[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value = value.join(' / ');
    if (typeof value === 'boolean') value = value ? '是' : '否';
    if (key === 'created_at') value = new Date(value).toLocaleDateString();
    const badge = element('span', 'nf-profile-badge', PROFILE_FIELDS[key] + ' ' + String(value));
    badge.style.setProperty('--nf-level', color);
    label.append(badge);
  }
  label.title = '本机采样于 ' + new Date(record.at).toLocaleString();
  label.classList.toggle(
    'nf-stale',
    Date.now() - record.at > config.settings.profileHours * 3600000,
  );
}
function bindProfile(link: HTMLElement) {
  if (!config.settings.profiles || link.dataset.nfProfile) return;
  const id = link.getAttribute('href')?.match(/\/space\/(\d+)/)?.[1];
  if (!id) return;
  link.dataset.nfProfile = id;
  const label = element('span', 'nf-profile', '');
  link.after(label);
  const scope = account;
  const render = (record: any) => {
    if (!record || !link.isConnected || scope !== account) return;
    profileLabel(label, record);
    label.title = '本机采样于 ' + new Date(record.at).toLocaleString();
    label.classList.toggle(
      'nf-stale',
      Date.now() - record.at > config.settings.profileHours * 3600000,
    );
  };
  rpc('cacheGet', { account: scope, kind: 'profile', key: id })
    .then((record) => {
      render(record);
      if (
        !record ||
        config.settings.profileLabelKeys.some((k) => record.detail?.[k] === undefined) ||
        Date.now() - record.at > config.settings.profileHours * 3600000
      ) {
        label.dataset.nfNeed = '1';
        profileObserver?.observe(link);
      }
    })
    .catch(() => {});
  const refresh = () => {
    if (profilePending.has(id)) return profilePending.get(id)!;
    const task = (async () => {
      if (scope !== account) return;
      try {
        const r = await forumFetch(
          '/api/account/getInfo/' + id + '?readme=1',
          routeController.signal,
        );
        const data = await r.json();
        if (!data.success || !data.detail) throw Error('资料格式无效');
        const detail = Object.fromEntries(
          Object.keys(PROFILE_FIELDS)
            .filter((k) => data.detail[k] !== undefined)
            .map((k) => [k, data.detail[k]]),
        );
        const record = { at: Date.now(), detail };
        await rpc('cachePut', { account: scope, kind: 'profile', key: id, value: record });
        for (const other of document.querySelectorAll('[data-nf-profile="' + id + '"]')) {
          const l = other.nextElementSibling as HTMLElement | null;
          if (l?.classList.contains('nf-profile')) {
            profileLabel(l, record);
            l.title = '更新于 ' + new Date(record.at).toLocaleString();
            l.classList.remove('nf-stale');
          }
        }
      } catch (e) {
        label.title = '暂未更新；已有缓存继续显示';
      }
    })().finally(() => profilePending.delete(id));
    profilePending.set(id, task);
    return task;
  };
  (link as any)._nfRefresh = refresh;
}
type RuleStyle = { value: string; priority: string; applied: string };
const ruleStyles = new WeakMap<HTMLElement, Map<HTMLElement, Map<string, RuleStyle>>>();
function restoreRuleStyles(owner: HTMLElement) {
  const targets = ruleStyles.get(owner);
  if (!targets) return;
  for (const [target, properties] of targets)
    for (const [property, original] of properties) {
      // Preserve a later change made by the site itself; restore only our own value.
      if (
        target.style.getPropertyValue(property) !== original.applied ||
        target.style.getPropertyPriority(property) !== 'important'
      )
        continue;
      if (original.value) target.style.setProperty(property, original.value, original.priority);
      else target.style.removeProperty(property);
    }
  ruleStyles.delete(owner);
}
function setRuleStyle(owner: HTMLElement, target: HTMLElement, property: string, value: string) {
  let targets = ruleStyles.get(owner);
  if (!targets) ruleStyles.set(owner, (targets = new Map()));
  let properties = targets.get(target);
  if (!properties) targets.set(target, (properties = new Map()));
  const original = properties.get(property) || {
    value: target.style.getPropertyValue(property),
    priority: target.style.getPropertyPriority(property),
    applied: '',
  };
  target.style.setProperty(property, value, 'important');
  original.applied = target.style.getPropertyValue(property);
  properties.set(property, original);
}
function enhanceItems(root: Element, items: Map<string, Item>) {
  for (const node of root.children) {
    if (!node.matches('.content-item,.post-list-item')) continue;
    const el = node as HTMLElement;
    const id = el.dataset.nfId || identify(el, el.matches('.content-item') ? 'post' : 'list');
    const item = items.get(id);
    if (!item) continue;
    el.dataset.nfId = id;
    if (!el.dataset.nfEnhanced) {
      el.dataset.nfEnhanced = '1';
      if (config.settings.profiles) {
        const author = el.querySelector('.author-name,.info-author a') as HTMLElement | null;
        if (author) bindProfile(author);
      }
      if (item.kind === 'post')
        el.addEventListener('click', async (event) => {
          const action = (event.target as Element)
            .closest('[data-nf-action]')
            ?.getAttribute('data-nf-action');
          if (!action) return;
          const reference = '@' + item.author + ' [#' + item.floor + '](' + item.url + ')';
          const text =
            action === 'quote'
              ? '> ' + reference + '\n> ' + item.summary.replace(/\n/g, '\n> ') + '\n\n'
              : reference + ' ';
          if (!(await insertEditor(text))) toast('未找到编辑器，请使用原楼层入口');
        });
    }
    el.querySelectorAll('.nf-rule-label,:scope > .nf-block-toggle').forEach((e) => e.remove());
    restoreRuleStyles(el);
    el.classList.remove('nf-blocked');
    const matches = effectiveRules(config.rules, config.ruleGroups).filter((r) =>
      ruleMatch(r.value, item),
    );
    const blocked = matches.find((r) => r.value.action === 'block');
    if (blocked) {
      el.classList.add('nf-blocked');
    }
    const groups = new Set<string>();
    for (const r of matches.filter((r) => r.value.action === 'mark')) {
      const group = r.value.group || r.id;
      if (groups.has(group)) continue;
      groups.add(group);
      const styles = r.value.styles;
      for (const [key, selector, prop] of [
        ['titleColor', '.post-title a', 'color'],
        ['usernameColor', '.author-name,.info-author a', 'color'],
        ['borderColor', '', 'border-color'],
        ['backgroundColor', '', 'background-color'],
      ] as const) {
        const style = styles?.[key] as { enabled?: boolean; color?: string } | undefined;
        const target = selector ? el.querySelector<HTMLElement>(selector) : el;
        if (target && style?.enabled && style.color) setRuleStyle(el, target, prop, style.color);
      }
      if (styles?.showGroupName === false) continue;
      const badge = element('span', 'nf-rule-label', r.value.label || r.value.text);
      badge.style.borderColor = r.value.color;
      badge.style.color = r.value.color;
      (el.querySelector('.post-title,.author-info') || el).append(badge);
    }
    if (item.kind === 'list' && config.progress.some((p) => p.id === account + ':' + item.id))
      el.classList.add('nf-read');
  }
  updateBlockedControl();
}
function directLinks() {
  if (!config.settings.directLinks) return;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/jump?"]')) {
    try {
      const u = new URL(a.href);
      if (!isForumURL(u.href) || u.pathname !== '/jump') continue;
      const target = new URL(u.searchParams.get('to') || '');
      if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) {
        a.href = target.href;
        a.rel = 'noopener noreferrer';
        a.title = '外部链接：' + target.host;
      }
    } catch {}
  }
}
function notificationPreviews() {
  if (!config.settings.previews) return;
  for (const a of document.querySelectorAll<HTMLAnchorElement>(
    '.nsk-notification a[href*="/post-"]',
  )) {
    if (a.dataset.nfPreview || !a.hash || !/评论|#\d+/.test(a.textContent || '')) continue;
    a.dataset.nfPreview = '1';
    const b = button('预览评论', async () => {
      b.disabled = true;
      const scope = account;
      const u = new URL(a.href);
      if (!isForumURL(u.href)) return;
      const wanted = u.hash.slice(1);
      u.hash = '';
      const url = canonicalPage(u.href);
      const box = element('div', 'nf-preview');
      try {
        let page: Page | null = await rpc('cacheGet', { account: scope, kind: 'page', key: url });
        let cached = !!page;
        if (!page) {
          const c = new AbortController();
          const r = await forumFetch(url, c.signal);
          page = parsePage(new DOMParser().parseFromString(await r.text(), 'text/html'), url);
          await rpc('cachePut', { account: scope, kind: 'page', key: url, value: page });
        }
        if (scope !== account) return;
        const item = page.items.find((i) => String(i.floor) === wanted);
        if (!item) throw Error('评论未找到、已删除或不可见，请打开原链接');
        box.append(
          element(
            'small',
            'nf-muted',
            (cached ? '缓存预览' : '评论预览') +
              ' · ' +
              new Date(page.at).toLocaleString() +
              ' · ' +
              item.author,
          ),
        );
        const body = element('div');
        body.innerHTML = sanitize(item.body, item.url, false);
        box.append(body);
        b.after(box);
        b.remove();
      } catch (e) {
        b.disabled = false;
        toast((e as Error).message);
      }
    });
    a.after(b);
  }
}
async function startRoute() {
  document.documentElement.classList.remove('nf-show-blocked');
  const nextAccount = currentAccount();
  const old = account;
  const changedAccount = old && old !== nextAccount;
  account = nextAccount;
  routeController.abort();
  routeController = new AbortController();
  feed?.dispose();
  feed = null;
  profileObserver?.disconnect();
  profilePending.clear();
  if (changedAccount) {
    await rpc('cacheDropScope', { account: old }).catch(() => {});
    document.querySelectorAll('.nf-item,.nf-profile').forEach((e) => e.remove());
    location.reload();
    return;
  }
  if (!config.settings.enabled) return;
  applyLayout();
  theme();
  toolbar();
  directLinks();
  notificationPreviews();
  let p: Page;
  try {
    p = parsePage(document, location.href);
  } catch {
    return;
  }
  const root = itemsRoot(p.kind);
  if (!root) return;
  profileObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          profileObserver?.unobserve(entry.target);
          (entry.target as any)._nfRefresh?.();
        }
    },
    { rootMargin: '200px' },
  );
  const mainAuthor = document.querySelector<HTMLElement>('.content-item[id="0"] .author-name');
  if (mainAuthor) bindProfile(mainAuthor);
  const paging = p.kind === 'list' ? config.settings.listPaging : config.settings.commentPaging;
  if (!paging) {
    const map = new Map(p.items.map((i) => [i.id, i]));
    enhanceItems(root, map);
    enhanceMain(p);
    refreshNavigation();
    return;
  }
  feed = new Feed(p, root, account);
  await feed.start();
}
async function refreshConfig() {
  const previous = config;
  config = await rpc('snapshot');
  theme();
  if (!config.settings.enabled) {
    document.documentElement.classList.remove('nf-show-blocked');
    for (const el of document.querySelectorAll<HTMLElement>('.content-item,.post-list-item')) {
      restoreRuleStyles(el);
      el.classList.remove('nf-blocked');
      el.querySelectorAll('.nf-rule-label,:scope > .nf-block-toggle').forEach((e) => e.remove());
    }
    feed?.dispose();
    feed = null;
    document.querySelector('#nf-tools')?.remove();
    document.querySelector('#nf-hot-panel')?.remove();
    refreshNavigation();
    applyLayout();
    return;
  }
  applyLayout();
  if (
    JSON.stringify(previous.settings) !== JSON.stringify(config.settings) ||
    JSON.stringify(previous.phrases) !== JSON.stringify(config.phrases)
  )
    toolbar();
  if (
    JSON.stringify([previous.rules, previous.ruleGroups]) !==
    JSON.stringify([config.rules, config.ruleGroups])
  ) {
    if (feed) feed.enhance();
    else {
      try {
        const page = parsePage(document, location.href);
        const root = itemsRoot(page.kind);
        if (root) enhanceItems(root, new Map(page.items.map((i) => [i.id, i])));
        enhanceMain(page);
      } catch {}
    }
  }
}
async function init() {
  config = await rpc('snapshot');
  theme();
  if (document.readyState === 'loading')
    await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  activeURL = location.href;
  profileRuleButtons = quickRules(() => config, makeDialog, refreshConfig);
  await startRoute();
  const scanAttendance = installAttendance(
    () => !!config.attendanceEnabled && config.settings.enabled,
    currentAccount,
  );
  scanAttendance();
  document.addEventListener('click', takeOverTheme, true);
  document.addEventListener(
    'keydown',
    (e) => {
      const target = (e.target as Element)?.closest?.(themeSelector);
      if (target && !target.matches('button,a') && ['Enter', ' '].includes(e.key)) takeOverTheme(e);
    },
    true,
  );
  new MutationObserver(() => {
    if (!config.settings.enabled) return;
    const native = document.body.classList.contains('dark-layout') ? 'dark' : 'light';
    if (document.documentElement.dataset.nfTheme !== native) theme();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  rpc('sync').catch(() => {});
  window.addEventListener('scroll', () => feed?.save(), { passive: true });
  window.addEventListener('pagehide', () => {
    feed?.save();
    feed?.persist();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      feed?.restoreAnchor();
      feed?.check(false);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      feed?.save();
      feed?.persist();
    } else {
      feed?.check(false);
      rpc('sync').catch(() => {});
    }
  });
  document.addEventListener(
    'click',
    (e) => {
      if ((e.target as Element).closest('a,.sorter')) {
        feed?.save();
        feed?.persist();
      }
    },
    true,
  );
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'flow:changed') refreshConfig().catch(() => {});
  });
  const scan = () => {
    scanAttendance();
    if (location.href !== activeURL || currentAccount() !== account) {
      activeURL = location.href;
      startRoute().catch((e) => toast(e.message));
    } else {
      applyLayout();
      directLinks();
      notificationPreviews();
      decorateThemeControls();
      refreshNavigation();
      sidebarHot();
    }
  };
  observer = new MutationObserver((records) => {
    if (records.every((r) => (r.target as Element).closest?.('[id^="nf-"],.nf-item,.nf-profile')))
      return;
    clearTimeout(routeTimer);
    routeTimer = window.setTimeout(scan, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', scan);
  window.addEventListener('resize', sidebarHot);
  window.addEventListener('resize', applyLayout);
  setInterval(() => {
    if (!document.hidden) scan();
  }, 1500);
}
init().catch((e) => {
  console.warn('NodeSeek Flow:', e.message);
});

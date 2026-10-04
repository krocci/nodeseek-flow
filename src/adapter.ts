import { canonicalPage, routeKey, pageNumber, isForumURL } from './core';
import { normalizeTimes, absoluteTime, formatTime } from './timestamps';
export type Item = {
  id: string;
  floor: number;
  url: string;
  title: string;
  author: string;
  authorId: string;
  body: string;
  summary: string;
  replies: number;
  time: string;
  capturedAt?: number;
  kind: 'list' | 'post';
  shell?: string;
  scopes?: string[];
  nativeComment?: Record<string, unknown>;
};
export type Page = {
  renderer?: number;
  url: string;
  route: string;
  mode: string;
  kind: 'list' | 'post';
  items: Item[];
  main?: Item;
  next: string;
  at: number;
};
const text = (e: Element | null) => e?.textContent?.trim() || '';
export const RENDERER = 4;

// Keep the site's layout, but never cache handlers, scripts or extension decorations.
export function safeShell(html: string, base: string): string {
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const root = doc.body.firstElementChild!;
  root
    .querySelectorAll(
      'script,style,iframe,object,embed,form,input,textarea,button,template,math,foreignObject,.comment-menu,.nf-profile,.nf-rule-label,.nf-block-toggle,.nsh-user-stats,.nsh-follow-group-list,.nsh-follow-avatar-effect',
    )
    .forEach((e) => e.remove());
  for (const e of [...root.querySelectorAll('*')]) {
    if (!tags.has(e.tagName) && !['SVG', 'USE', 'TIME'].includes(e.tagName.toUpperCase())) {
      // Unknown safe wrappers must not swallow their already parsed content.
      e.replaceWith(...e.childNodes);
      continue;
    }
    for (const a of [...e.attributes]) {
      if (
        ['class', 'title', 'alt', 'datetime', 'data-nf-time-estimated', 'width', 'height', 'viewBox'].includes(a.name) ||
        /^data-v-[a-f0-9]+$/.test(a.name)
      )
        continue;
      if (['href', 'src', 'xlink:href'].includes(a.name)) {
        if (e.tagName.toLowerCase() === 'use') {
          if (!/^#[\w-]+$/.test(a.value)) e.removeAttribute(a.name);
        } else {
          const value = safeURL(a.value, base);
          if (value) e.setAttribute(a.name, value);
          else e.removeAttribute(a.name);
        }
      } else e.removeAttribute(a.name);
    }
    if (e.classList)
      for (const c of [...e.classList]) if (/^(nf-|nsh-)/.test(c)) e.classList.remove(c);
    if (e.tagName === 'IMG') {
      e.setAttribute('loading', 'lazy');
      e.classList.remove('skeleton');
    }
    if (e.tagName === 'A') e.setAttribute('rel', 'noopener noreferrer');
  }
  return root.innerHTML;
}
function pageComments(root: Document): Record<string, unknown>[] {
  try {
    const encoded = root.querySelector('#temp-script')?.textContent?.replace(/\s/g, '') || '';
    if (encoded.length > 6_000_000) return [];
    const data = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))),
    );
    return Array.isArray(data?.postData?.comments) ? data.postData.comments : [];
  } catch {
    return [];
  }
}
export function currentAccount(root: Document = document): string {
  return (
    root
      .querySelector('.user-head a[href*="/space/"]')
      ?.getAttribute('href')
      ?.match(/\/space\/(\d+)/)?.[1] || 'guest'
  );
}
export function currentMode(root: Document = document, url = location.href): string {
  return (
    root.querySelector('.sorter a.selected')?.getAttribute('data-sort') ||
    new URL(url).searchParams.get('sortBy') ||
    'replyTime'
  );
}
export function listRoot(root: Document = document): Element | null {
  return (
    [...root.querySelectorAll('.post-list')].find(
      (e) => !e.classList.contains('topic-carousel-panel'),
    ) || null
  );
}
export function itemsRoot(kind: 'list' | 'post', root: Document = document): Element | null {
  return kind === 'list' ? listRoot(root) : root.querySelector('ul.comments');
}
export function safeURL(value: string, base: string, image = false): string {
  try {
    const u = new URL(value, base);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return '';
    return u.href;
  } catch {
    return '';
  }
}
const tags = new Set(
  'ARTICLE SECTION HEADER FOOTER FIGURE FIGCAPTION P DIV SPAN BR HR A STRONG B EM I DEL S U PRE CODE BLOCKQUOTE UL OL LI H1 H2 H3 H4 H5 H6 TABLE THEAD TBODY TR TH TD IMG DETAILS SUMMARY SUP SUB'.split(
    ' ',
  ),
);
export function sanitize(html: string, base: string, images = true): string {
  const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
  const source = doc.body.firstElementChild;
  const target = doc.createElement('div');
  function walk(from: Node, to: Node) {
    for (const node of [...from.childNodes]) {
      if (node.nodeType === 3) {
        to.appendChild(doc.createTextNode(node.textContent || ''));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const e = node as Element;
      if (
        [
          'SCRIPT',
          'STYLE',
          'IFRAME',
          'OBJECT',
          'EMBED',
          'FORM',
          'INPUT',
          'BUTTON',
          'TEXTAREA',
          'SVG',
          'MATH',
          'TEMPLATE',
        ].includes(e.tagName)
      )
        continue;
      if (!tags.has(e.tagName)) {
        walk(e, to);
        continue;
      }
      if (e.tagName === 'IMG' && !images) continue;
      const el = doc.createElement(e.tagName.toLowerCase());
      if (e.tagName === 'A') {
        const href = safeURL(e.getAttribute('href') || '', base);
        if (href) el.setAttribute('href', href);
        el.setAttribute('rel', 'noopener noreferrer');
      }
      if (e.tagName === 'IMG') {
        const src = safeURL(e.getAttribute('src') || '', base, true);
        if (!src) continue;
        el.setAttribute('src', src);
        el.setAttribute('alt', (e.getAttribute('alt') || '').slice(0, 300));
        el.setAttribute('loading', 'lazy');
        el.setAttribute('referrerpolicy', 'no-referrer');
      }
      if (e.tagName === 'CODE' && /^[\w -]{0,100}$/.test(e.className)) el.className = e.className;
      walk(e, el);
      to.appendChild(el);
    }
  }
  if (source) walk(source, target);
  return target.innerHTML;
}
export function parsePage(root: Document, url: string, mode = currentMode(root, url)): Page {
  const capturedAt = Date.now();
  const kind = /^\/post-\d+-\d+$/.test(new URL(url).pathname) ? 'post' : 'list';
  const container = itemsRoot(kind, root);
  if (!container) throw Error('页面结构不匹配，可能需要登录或完成站点验证');
  const title = text(root.querySelector('h1')) || root.title;
  const seen = new Set<string>();
  const items: Item[] = [];
  const comments = kind === 'post' ? pageComments(root) : [];
  const main = kind === 'post' ? root.querySelector('.content-item[id="0"]') : null;
  const nodes = [...container.children];
  if (main && !nodes.includes(main)) nodes.push(main);
  for (const e of nodes) {
    if (!e.matches(kind === 'list' ? '.post-list-item' : '.content-item')) continue;
    const author = e.querySelector(
      kind === 'list'
        ? '.info-author a[href*="/space/"],.author-name[href*="/space/"]'
        : '.author-name[href*="/space/"]',
    );
    const authorId = author?.getAttribute('href')?.match(/\/space\/(\d+)/)?.[1] || '';
    const link = e.querySelector(kind === 'list' ? '.post-title a[href*="/post-"]' : '.floor-link');
    const floor = kind === 'post' ? Number(e.id || text(link).replace('#', '')) : 0;
    const postHref = link?.getAttribute('href') || '';
    const id =
      kind === 'list'
        ? postHref.match(/post-(\d+)/)?.[1]
        : e.getAttribute('data-comment-id') || 'floor:' + floor;
    if (!id || seen.has(id) || !Number.isFinite(floor)) continue;
    seen.add(id);
    const itemURL =
      kind === 'list'
        ? safeURL(postHref, url)
        : new URL(url).origin + new URL(url).pathname + '#' + floor;
    const body = e.querySelector('article.post-content,.post-content');
    normalizeTimes(e, capturedAt);
    items.push({
      id,
      floor,
      url: itemURL,
      title: kind === 'list' ? text(link) : title,
      author: text(author),
      authorId,
      body: kind === 'post' ? sanitize(body?.innerHTML || '', url) : '',
      summary: text(body).slice(0, 600),
      replies: Number(text(e.querySelector('.info-comments-count')).replace(/[^\d]/g, '')) || 0,
      time: e.querySelector('time')?.getAttribute('datetime') || text(e.querySelector('time')),
      capturedAt,
      kind,
      shell: safeShell(e.innerHTML, url),
      scopes: [...e.attributes].map((a) => a.name).filter((a) => /^data-v-[a-f0-9]+$/.test(a)),
      nativeComment: comments.find(
        (c) => String(c.commentId) === id && Number(c.floorIndex) === floor,
      ),
    });
  }
  const rawNext = root.querySelector('.nsk-pager a[rel="next"],a.pager-next')?.getAttribute('href');
  let next = '';
  if (rawNext) {
    const nextURL = new URL(rawNext, url);
    if (kind === 'list') nextURL.searchParams.set('sortBy', mode);
    if (
      isForumURL(nextURL.href) &&
      routeKey(nextURL.href, mode) === routeKey(url, mode) &&
      pageNumber(nextURL.href) > pageNumber(url)
    )
      next = canonicalPage(nextURL.href, mode);
  }
  return {
    renderer: RENDERER,
    url: canonicalPage(url, mode),
    route: routeKey(url, mode),
    mode,
    kind,
    items: items.filter((i) => kind === 'list' || i.floor !== 0),
    main: kind === 'post' ? items.find((i) => i.floor === 0) : undefined,
    next,
    at: capturedAt,
  };
}
export function identify(e: Element, kind: 'list' | 'post'): string {
  return kind === 'post'
    ? e.getAttribute('data-comment-id') || 'floor:' + e.id
    : e
        .querySelector('.post-title a')
        ?.getAttribute('href')
        ?.match(/post-(\d+)/)?.[1] || '';
}
export function upgradePage(page: Page): Page | null {
  if (page.renderer === RENDERER) return page;
  // v2 kept a complete, separately sanitized body even when its shell lost ARTICLE.
  if ([2, 3].includes(page.renderer || 0) && page.items.every((i) => !!i.shell)) {
    const upgrade = (i: Item) => {
      const item = { ...i, capturedAt: i.capturedAt || page.at };
      return { ...item, shell: repairShell(item) };
    };
    return {
      ...page,
      renderer: RENDERER,
      items: page.items.map(upgrade),
      main: page.main ? upgrade(page.main) : undefined,
    };
  }
  return null;
}
function repairShell(item: Item): string {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = safeShell(item.shell || '', item.url);
  normalizeTimes(wrapper, item.capturedAt);
  if (item.kind === 'post' && !wrapper.querySelector('.post-content')) {
    const body = element('article', 'post-content');
    body.innerHTML = sanitize(item.body, item.url);
    const meta = wrapper.querySelector('.nsk-content-meta-info');
    if (meta) meta.after(body);
    else wrapper.prepend(body);
  }
  return wrapper.innerHTML;
}
export function uniqueItems(pages: Page[]): Item[] {
  const seen = new Set<string>();
  return pages
    .flatMap((p) => p.items)
    .filter((i) => {
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });
}
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  textValue = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (textValue) e.textContent = textValue;
  return e;
}
export function renderItem(item: Item): HTMLElement {
  const node = element(
    'li',
    item.kind === 'list' ? 'post-list-item nf-item' : 'content-item nf-item',
  );
  node.dataset.nfId = item.id;
  node.dataset.nfUrl = item.url;
  for (const attr of item.scopes || [])
    if (/^data-v-[a-f0-9]+$/.test(attr)) node.setAttribute(attr, '');
  if (item.kind === 'post') {
    node.id = String(item.floor);
    node.dataset.commentId = item.id;
  }
  if (item.shell) {
    node.innerHTML = repairShell(item);
    const floor = node.querySelector<HTMLAnchorElement>('.floor-link');
    if (floor) floor.href = item.url;
    if (item.kind === 'post') node.append(commentFallback(item));
    return node;
  }
  const meta = element('div', item.kind === 'list' ? 'post-list-content' : 'nsk-content-meta-info');
  if (item.kind === 'list') {
    const title = element('div', 'post-title');
    const a = element('a', '', item.title);
    a.href = item.url;
    title.append(a);
    meta.append(title);
  }
  const authorInfo = element('div', item.kind === 'list' ? 'post-info' : 'author-info');
  const author = element('a', 'author-name', item.author || '用户');
  author.href = '/space/' + item.authorId;
  const authorSlot = item.kind === 'list' ? element('span', 'info-author') : authorInfo;
  authorSlot.append(author);
  if (authorSlot !== authorInfo) authorInfo.append(authorSlot);
  authorInfo.append(
    element('span', 'nf-muted', absoluteTime(item.time) !== null ? formatTime(absoluteTime(item.time)!) : '时间未知'),
  );
  if (item.kind === 'list')
    authorInfo.append(element('span', 'info-comments-count', String(item.replies) + ' 回复'));
  else {
    const floor = element('a', 'floor-link', '#' + item.floor);
    floor.href = item.url;
    authorInfo.append(floor);
  }
  meta.append(authorInfo);
  node.append(meta);
  if (item.kind === 'post') {
    const body = element('article', 'post-content');
    body.innerHTML = sanitize(item.body, item.url);
    node.append(body);
    node.append(commentFallback(item));
  }
  return node;
}

function commentFallback(item: Item): HTMLElement {
  const menu = element('div', 'nf-native-mount');
  const link = element('a', 'nf-native-fallback', '打开原楼层操作');
  link.href = item.url;
  link.title = '原生操作栏未就绪时，打开原楼层使用点赞、鸡腿、点踩、引用和回复';
  menu.append(link);
  return menu;
}

import { type Item, type Page, uniqueItems } from './adapter';

export type UpdateBoundary = {
  kind: 'list' | 'post';
  ids: string[];
  added: number;
  edited: number;
  at: number;
};
export type RefreshPlan = {
  pages: Page[];
  boundary: UpdateBoundary;
  changed: boolean;
  mainChanged: boolean;
};
const signature = (item?: Item) =>
  item ? JSON.stringify([item.title, item.body, item.replies]) : '';

// Preserve the existing reading chain. Incoming rows never replace the shared
// URL cache's snapshot in place, and unchanged rows retain their relative order.
export function planRefresh(pages: Page[], fresh: Page[]): RefreshPlan {
  const old = new Map(uniqueItems(pages).map((i) => [i.id, i]));
  const incoming = uniqueItems(fresh);
  const changed = incoming.filter((i) => signature(old.get(i.id)) !== signature(i));
  const added = changed.filter((i) => !old.has(i.id));
  const changedIds = new Set(changed.map((i) => i.id));
  const byId = new Map(changed.map((i) => [i.id, i]));
  const byURL = new Map(fresh.map((p) => [p.url, p]));
  const mainChanged = !!fresh[0]?.main && signature(pages[0].main) !== signature(fresh[0].main);
  const isList = pages[0].kind === 'list';
  const nextPages: Page[] = pages.map((p, index) => ({
    ...p,
    main: index === 0 && fresh[0]?.main ? fresh[0].main : p.main,
    at: byURL.get(p.url)?.at || p.at,
    // Earlier next links remain stable while the tail can discover a new page.
    next: index === pages.length - 1 ? (byURL.get(p.url)?.next ?? p.next) : p.next,
    items: isList
      ? [...(index === 0 ? changed : []), ...p.items.filter((i) => !changedIds.has(i.id))]
      : [
          ...p.items.map((i) => byId.get(i.id) || i),
          ...added.filter((i) => byURL.get(p.url)?.items.some((x) => x.id === i.id)),
        ],
  }));
  if (!isList) {
    for (const p of fresh)
      if (!pages.some((oldPage) => oldPage.url === p.url)) {
        nextPages.push({ ...p, items: p.items.filter((i) => !old.has(i.id)) });
      }
  }
  // Keep each stable ID in exactly one page, including pinned comments.
  const seen = new Set<string>();
  for (const p of nextPages)
    p.items = p.items.filter((i) => {
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });
  return {
    pages: nextPages,
    boundary: {
      kind: pages[0].kind,
      ids: (isList ? changed : added).map((i) => i.id),
      added: added.length,
      edited: changed.length - added.length,
      at: Date.now(),
    },
    changed: changed.length > 0 || mainChanged || nextPages.at(-1)?.next !== pages.at(-1)?.next,
    mainChanged,
  };
}

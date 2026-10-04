// Freeze relative source text against its capture time, never against restore time.
export function absoluteTime(value: string): number | null {
  const s = value.trim();
  if (/^\d{10}(?:\d{3})?$/.test(s)) {
    const n = Number(s) * (s.length === 10 ? 1000 : 1);
    return Number.isFinite(new Date(n).getTime()) ? n : null;
  }
  if (!/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T\s]/.test(s)) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}
export function relativeTime(value: string, capturedAt?: number): number | null {
  if (!capturedAt || !Number.isFinite(capturedAt)) return null;
  const s = value.trim();
  if (/^(刚刚|just now)$/i.test(s)) return capturedAt;
  const m = s.match(
    /^(\d+)\s*(s|sec(?:onds?)?|min(?:utes?)?|m|h|hours?|d|days?|weeks?|w|秒|分钟|小时|天|周)\s*(?:ago|前)$/i,
  );
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const seconds = /^(w|week|周)/.test(unit)
    ? 604800
    : /^(d|天)/.test(unit)
      ? 86400
      : /^(h|小时)/.test(unit)
        ? 3600
        : /^(m|分钟)/.test(unit)
          ? 60
          : 1;
  return capturedAt - Number(m[1]) * seconds * 1000;
}
export function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function normalizeTimes(root: ParentNode, capturedAt?: number) {
  const nodes = root.querySelectorAll<HTMLElement>(
    'time,[datetime],.info-last-comment-time,[data-time],[data-timestamp],.post-info [title],.nsk-content-meta-info [title]',
  );
  for (const node of nodes) {
    // Do not replace containers, author names, tooltips or user-written content.
    if (node.children.length || node.closest('.post-content,.nf-profile,.nf-rule-label')) continue;
    const original = node.textContent?.trim() || '';
    const source =
      ['datetime', 'data-time', 'data-timestamp', 'title']
        .map((a) => node.getAttribute(a) || '')
        .map(absoluteTime)
        .find((n) => n !== null) ?? absoluteTime(original);
    const estimate = source === null ? relativeTime(original, capturedAt) : null;
    const at = source ?? estimate;
    if (at === null) continue;
    const approximate = estimate !== null || node.getAttribute('data-nf-time-estimated') === 'true';
    const label = (approximate ? '约 ' : '') + formatTime(at);
    const inList = !!node.closest('.post-info') || node.matches('.info-last-comment-time');
    const inComment = !!node.closest('.nsk-content-meta-info');
    const parts = formatTime(at).split(' ');
    const display = inList
      ? (approximate ? '约 ' : '') + parts[0] + '\n' + parts[1].slice(0, 5)
      : inComment ? (approximate ? '约 ' : '') + formatTime(at).slice(0, 16) : label;
    if (node.textContent !== display) node.textContent = display;
    node.setAttribute('datetime', new Date(at).toISOString());
    if (approximate) node.setAttribute('data-nf-time-estimated', 'true');
    node.title = label + (approximate ? '（按缓存采集时的相对时间估算）' : '（本机时区）');
    node.classList.add('nf-absolute-time');
    node.classList.toggle('nf-time-stacked', inList);
  }
}

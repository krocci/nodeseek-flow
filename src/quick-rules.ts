import { type Entity, type Rule, type RuleGroup, uuid } from './core';
import { element } from './adapter';
import { listRuleGroups, buildGroupRules } from './rule-groups';
import { rpc } from './client';

type Snapshot = {
  settings: { enabled: boolean };
  rules: Entity<Rule>[];
  ruleGroups?: Entity<RuleGroup>[];
};
export function quickRules(
  get: () => Snapshot,
  dialog: (title: string) => HTMLDialogElement,
  saved: () => Promise<void>,
) {
  let bar: HTMLElement | undefined;
  const dismiss = () => {
    bar?.remove();
    bar = undefined;
  };
  function open(target: Rule['target'], action: Rule['action'], text: string) {
    dismiss();
    const d = dialog(
      (action === 'mark' ? '标记' : '屏蔽') + (target === 'user' ? '用户' : '关键词'),
    );
    const form = element('form', 'nf-quick-rule-form');
    const value = element('input');
    value.value = text;
    value.required = true;
    value.maxLength = 200;
    value.setAttribute('aria-label', target === 'user' ? '用户 ID' : '关键词');
    value.readOnly = target === 'user';
    const groups = listRuleGroups(get().rules, get().ruleGroups).filter(
      (g) => g.value.target === target && g.value.action === action && g.value.enabled !== false,
    );
    const select = element('select');
    select.setAttribute('aria-label', '选择标签分组');
    for (const g of groups) {
      const o = element('option', '', g.value.label);
      o.value = g.id;
      select.append(o);
    }
    const fresh = element('option', '', '＋ 新建标签分组');
    fresh.value = '';
    select.append(fresh);
    const label = element('input');
    label.value = action === 'mark' ? '关注' : '屏蔽';
    label.maxLength = 80;
    label.required = true;
    label.setAttribute('aria-label', '新标签名称');
    const color = element('input');
    color.type = 'color';
    color.value = '#397d9c';
    color.setAttribute('aria-label', '标签颜色');
    const update = () => {
      label.hidden = color.hidden = !!select.value;
      label.required = !select.value;
    };
    select.addEventListener('change', update);
    update();
    const status = element('p');
    status.setAttribute('role', 'status');
    const submit = element('button', 'nf-btn', '保存');
    submit.type = 'submit';
    form.append(
      value,
      select,
      label,
      color,
      element('p', '', target === 'keyword' ? '新分组默认仅匹配标题；选择已有分组时沿用其范围，可在设置中修改或撤销。' : '按用户匹配；可在设置的标签分组中修改或撤销。'),
      status,
      submit,
    );
    let committed = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        if (committed) { await saved(); d.close(); return; }
        const existing = groups.find((g) => g.id === select.value);
        const group: Entity<RuleGroup> = existing || {
          id: uuid(),
          conflicts: [],
          value: {
            target,
            action,
            scope: 'title',
            label: label.value.trim(),
            color: color.value,
            enabled: true,
          },
        };
        if (!group.value.label) throw Error('请填写标签名称');
        const rule = buildGroupRules(group, [value.value])[0];
        if (get().rules.some((r) => r.value.group === group.id && r.value.text === rule.text))
          throw Error('此匹配项已在分组中');
        const edits: unknown[] = existing
          ? []
          : [{ collection: 'ruleGroups', key: group.id, value: group.value }];
        edits.push({ collection: 'rules', key: uuid(), value: rule });
        await rpc('editRuleBatch', { edits });
        committed = true;
        await saved();
        d.close();
      } catch (e) {
        status.textContent = (committed ? '规则已保存，但页面应用失败：' : '') + (e as Error).message;
        if (committed) submit.textContent = '重新应用';
        submit.disabled = false;
      }
    });
    d.append(form);
    value.focus();
  }
  function selection() {
    dismiss();
    if (!get()?.settings.enabled) return;
    const s = window.getSelection();
    const text = s?.toString().trim() || '';
    const parent = s?.anchorNode?.parentElement;
    if (
      !s?.rangeCount ||
      !text ||
      text.length > 200 ||
      parent?.closest('input,textarea,[contenteditable],dialog,#nf-tools')
    )
      return;
    const rect = s.getRangeAt(0).getBoundingClientRect();
    bar = element('div', 'nf-selection-actions');
    bar.id = 'nf-selection-actions';
    bar.addEventListener('pointerdown', (e) => e.preventDefault());
    for (const action of ['mark', 'block'] as const) {
      const b = element('button', 'nf-btn', action === 'mark' ? '标记关键词' : '屏蔽关键词');
      b.type = 'button';
      b.addEventListener('click', () => open('keyword', action, text));
      bar.append(b);
    }
    bar.style.left = Math.max(8, Math.min(rect.left, innerWidth - 250)) + 'px';
    bar.style.top = Math.max(8, Math.min(rect.bottom + 8, innerHeight - 50)) + 'px';
    document.body.append(bar);
  }
  document.addEventListener('mouseup', (e) => {
    if (!(e.target as Element).closest?.('#nf-selection-actions,dialog')) selection();
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Escape') dismiss();
    else if (e.key === 'Shift') selection();
  });
  window.addEventListener('scroll', dismiss, { passive: true });
  return function profileButtons() {
    const id = location.pathname.match(/^\/space\/(\d+)(?:\/|$)/)?.[1];
    const old = document.getElementById('nf-user-rule-actions');
    if (!get()?.settings.enabled || !id) {
      old?.remove();
      if (!get()?.settings.enabled) dismiss();
      return;
    }
    if (old?.dataset.user === id) return;
    old?.remove();
    const pm = [...document.querySelectorAll<HTMLElement>('a,button')].find(
      (e) =>
        e.textContent?.trim() === '私信' && !e.closest('#nf-dialog,#nsk-right-panel-container'),
    );
    if (!pm) return;
    const wrap = element('span', 'nf-user-rule-actions');
    wrap.id = 'nf-user-rule-actions';
    wrap.dataset.user = id;
    for (const action of ['mark', 'block'] as const) {
      const b = element('button', 'nf-btn', action === 'mark' ? '标记用户' : '屏蔽用户');
      b.type = 'button';
      b.addEventListener('click', () => open('user', action, id));
      wrap.append(b);
    }
    pm.after(wrap);
  };
}

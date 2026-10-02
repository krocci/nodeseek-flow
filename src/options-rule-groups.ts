import { type Entity, type Rule, type RuleGroup, uuid } from './core';
import { listRuleGroups, buildGroupRules } from './rule-groups';
import { element } from './adapter';

type Snapshot = { rules: Entity<Rule>[]; ruleGroups?: Entity<RuleGroup>[] };
export type RuleEdit = { collection: 'rules' | 'ruleGroups'; key: string; value: unknown };
export function renderRuleGroups(
  host: HTMLElement,
  snapshot: Snapshot,
  commit: (edits: RuleEdit[]) => Promise<void>,
  editRule?: (rule: Entity<Rule>) => void,
) {
  const selected = host.dataset.selected || '';
  host.replaceChildren();
  const groups = listRuleGroups(snapshot.rules, snapshot.ruleGroups);
  const overview = element('div', 'rule-overview');
  const editor = element('div', 'rule-group-editor');
  editor.hidden = host.dataset.editing !== 'true';
  overview.hidden = !editor.hidden;
  const back = element('button', 'button', '← 返回列表');
  back.type = 'button';
  back.addEventListener('click', () => {
    host.dataset.editing = 'false';
    editor.hidden = true;
    overview.hidden = false;
  });
  const editorTitle = element('h3');
  const status = element('p', 'muted');
  status.setAttribute('role', 'status');
  const choose = element('select');
  choose.setAttribute('aria-label', '标签分组');
  choose.hidden = true;
  const fresh = element('option', '', '＋ 新建标签分组');
  fresh.value = '';
  choose.append(fresh);
  for (const group of groups) {
    const count = snapshot.rules.filter((r) => r.value.group === group.id).length;
    const o = element(
      'option',
      '',
      group.value.label +
        ' · ' +
        (group.value.target === 'user' ? '用户' : '关键词') +
        ' · ' +
        (group.value.action === 'block' ? '屏蔽' : '标记') +
        ' · ' +
        count +
        '项',
    );
    o.value = group.id;
    choose.append(o);
  }
  choose.value = selected;
  const form = element('form', 'form-grid');
  const field = (title: string, control: HTMLElement) => {
    const label = element('label', '', title);
    label.append(control);
    form.append(label);
    return control;
  };
  const name = element('input');
  name.required = true;
  name.maxLength = 80;
  name.setAttribute('aria-label', '标签名称');
  field('标签名称', name);
  const select = (title: string, values: string[][]) => {
    const s = element('select');
    s.setAttribute('aria-label', title);
    for (const [value, label] of values) {
      const o = element('option', '', label);
      o.value = value;
      s.append(o);
    }
    field(title, s);
    return s;
  };
  const target = select('分组匹配对象', [
    ['keyword', '关键词'],
    ['user', '用户 ID'],
  ]);
  const action = select('分组处理方式', [
    ['mark', '标记'],
    ['block', '屏蔽'],
  ]);
  const scope = select('分组范围', [
    ['title', '仅标题'],
    ['all', '标题与正文'],
    ['body', '主帖与评论正文'],
    ['custom', '保留已有自定义区域'],
  ]);
  const color = element('input');
  color.type = 'color';
  color.value = '#397d9c';
  color.setAttribute('aria-label', '分组颜色');
  field('颜色', color);
  const enabled = element('input');
  enabled.type = 'checkbox';
  enabled.checked = true;
  field('启用此分组', enabled);
  const save = element('button', 'button primary', '保存标签分组');
  save.type = 'submit';
  form.append(save);
  const members = element('div', 'nf-group-members');
  const addForm = element('form');
  const texts = element('textarea');
  texts.rows = 5;
  texts.maxLength = 40000;
  texts.required = true;
  texts.setAttribute('aria-label', '分组匹配项');
  texts.placeholder = '每行一个关键词；用户分组填写数字 ID。先保存上方标签分组。';
  const add = element('button', 'button primary', '添加到此分组');
  add.type = 'submit';
  addForm.append(texts, add);
  let current: Entity<RuleGroup> | undefined;
  const load = () => {
    current = groups.find((g) => g.id === choose.value);
    host.dataset.selected = choose.value;
    const g = current?.value;
    name.value = g?.label || '';
    target.value = g?.target || 'keyword';
    action.value = g?.action || host.dataset.newAction || 'mark';
    editorTitle.textContent = current
      ? '编辑分组 · ' + g!.label
      : '新建' + (action.value === 'block' ? '屏蔽分组' : '标记分组');
    scope.value = g?.areas ? 'custom' : g?.scope || 'title';
    color.value = g?.color || '#397d9c';
    enabled.checked = g?.enabled !== false;
    const entries = current ? snapshot.rules.filter((r) => r.value.group === current!.id) : [];
    target.disabled = entries.length > 0;
    add.disabled = !current;
    addForm.hidden = !current;
    members.replaceChildren();
    for (const entry of entries) {
      const row = element('div', 'record');
      row.append(element('span', '', entry.value.text));
      if (editRule) {
        const edit = element('button', 'button', '编辑');
        edit.type = 'button';
        edit.addEventListener('click', () => editRule(entry));
        row.append(edit);
      }
      const remove = element('button', 'button', '移除此匹配项');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await commit([{ collection: 'rules', key: entry.id, value: null }]);
        } catch (e) {
          status.textContent = (e as Error).message;
          remove.disabled = false;
        }
      });
      row.append(remove);
      members.append(row);
    }
  };
  choose.addEventListener('change', load);
  load();
  const open = (id: string, action: string) => {
    host.dataset.newAction = action;
    host.dataset.editing = 'true';
    choose.value = id;
    load();
    status.textContent = '';
    overview.hidden = true;
    editor.hidden = false;
    name.focus();
  };
  for (const mode of ['mark', 'block'] as const) {
    const section = element('div', 'rule-section');
    const heading = element('div', 'rule-section-heading');
    heading.append(element('h3', '', mode === 'mark' ? '标记分组' : '屏蔽列表'));
    const create = element(
      'button',
      'button',
      mode === 'mark' ? '＋ 新建标记分组' : '＋ 新建屏蔽分组',
    );
    create.type = 'button';
    create.addEventListener('click', () => open('', mode));
    heading.append(create);
    section.append(
      heading,
      element(
        'p',
        'muted',
        mode === 'mark'
          ? '点击分组，修改标签样式和匹配项。'
          : '屏蔽规则独立管理，命中内容默认隐藏。',
      ),
    );
    const cards = element('div', 'rule-group-list');
    for (const group of groups.filter((g) => g.value.action === mode)) {
      const entries = snapshot.rules.filter((r) => r.value.group === group.id);
      const card = element('button', 'rule-group-card');
      card.type = 'button';
      card.dataset.groupId = group.id;
      card.setAttribute('aria-label', '编辑分组 ' + group.value.label);
      const title = element('strong', '', group.value.label);
      title.style.borderColor = group.value.color;
      card.append(
        title,
        element(
          'span',
          'muted',
          (group.value.target === 'user' ? '用户' : '关键词') +
            ' · ' +
            entries.length +
            ' 项 · ' +
            (group.value.enabled === false ? '已停用' : '已启用'),
        ),
        element(
          'span',
          'rule-group-preview',
          entries
            .slice(0, 4)
            .map((r) => r.value.text)
            .join('、') || '尚无匹配项，点击添加',
        ),
      );
      card.addEventListener('click', () => open(group.id, mode));
      cards.append(card);
    }
    if (!cards.children.length)
      cards.append(element('p', 'muted', '暂无' + (mode === 'mark' ? '标记' : '屏蔽') + '分组'));
    const loose = element('div', 'rule-loose-list');
    loose.id = mode === 'block' ? 'block-rule-list' : 'mark-rule-list';
    section.append(cards, loose);
    overview.append(section);
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      if (scope.value === 'custom' && !current?.value.areas)
        throw Error('新分组请选择标题与正文、仅标题或正文范围');
      const value: RuleGroup = {
        ...current?.value,
        label: name.value.trim(),
        target: target.value as Rule['target'],
        action: action.value as Rule['action'],
        scope: scope.value === 'custom' ? 'all' : (scope.value as Rule['scope']),
        color: color.value,
        enabled: enabled.checked,
      };
      if (scope.value !== 'custom') delete value.areas;
      const id = current?.id || uuid();
      host.dataset.selected = id;
      await commit([{ collection: 'ruleGroups', key: id, value }]);
    } catch (e) {
      status.textContent = (e as Error).message;
      save.disabled = false;
    }
  });
  addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!current) return;
    add.disabled = true;
    try {
      const rows = buildGroupRules(current, texts.value.split(/\r?\n/));
      const existing = new Set(
        snapshot.rules.filter((r) => r.value.group === current!.id).map((r) => r.value.text),
      );
      const edits: RuleEdit[] = rows
        .filter((r) => !existing.has(r.text))
        .map((value) => ({ collection: 'rules', key: uuid(), value }));
      if (!edits.length) {
        status.textContent = '这些匹配项已在分组中';
        add.disabled = false;
        return;
      }
      await commit(edits);
    } catch (e) {
      status.textContent = (e as Error).message;
      add.disabled = false;
    }
  });
  editor.append(
    back,
    editorTitle,
    element(
      'p',
      'muted',
      '先创建或选择标签分组，再逐行添加关键词或用户 ID。修改分组会统一应用于组内匹配项；移除单项不会删除分组。',
    ),
    choose,
    form,
    members,
    addForm,
    status,
  );
  host.append(overview, editor);
}

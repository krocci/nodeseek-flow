import { type Entity, type Rule, type RuleGroup, clone } from './core';

// Imported rules keep their original values until a group is explicitly edited.
export function listRuleGroups(
  rules: Entity<Rule>[],
  groups: Entity<RuleGroup>[] = [],
): Entity<RuleGroup>[] {
  const result = new Map(groups.map((g) => [g.id, g]));
  for (const rule of rules) {
    const r = rule.value;
    if (!r.group || result.has(r.group)) continue;
    const { text, group, ...template } = r;
    result.set(group, {
      id: group,
      value: { ...template, label: r.label || group },
      conflicts: [],
    });
  }
  return clone([...result.values()]);
}

export function effectiveRules(
  rules: Entity<Rule>[],
  groups: Entity<RuleGroup>[] = [],
): Entity<Rule>[] {
  const byId = new Map(groups.map((g) => [g.id, g.value]));
  return rules.map((e) => {
    const g = e.value.group && byId.get(e.value.group);
    if (!g || g.target !== e.value.target) return e;
    return {
      ...e,
      value: {
        ...e.value,
        ...g,
        areas: g.areas,
        enabled: g.enabled !== false && e.value.enabled !== false,
      },
    };
  });
}

export function buildGroupRules(group: Entity<RuleGroup>, texts: string[]): Rule[] {
  const values = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
  if (!values.length) throw Error('请填写至少一个匹配项');
  if (values.length > 200) throw Error('每次最多添加200项');
  for (const text of values) {
    if (text.length > 200) throw Error('每项最多200字');
    if (group.value.target === 'user' && !/^\d+$/.test(text))
      throw Error('用户标签请填写数字用户 ID，每行一个');
  }
  return values.map((text) => ({ ...clone(group.value), text, group: group.id }));
}

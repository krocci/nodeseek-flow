import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createState, edit, importLegacy, entities } from '../.tests/preview-core.mjs';
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw Error('Usage: node scripts/migrate-labels.mjs old-config.json output.json');
const raw = await readFile(input, 'utf8');
const source = JSON.parse(raw);
const selected = {};
for (const key of ['profileLabelKeys', 'profileLabelSize', 'levelColors', 'followRules'])
  if (source.options?.[key] !== undefined) selected[key] = source.options[key];
let state = createState(
  'legacy-labels-' +
    createHash('sha256').update(JSON.stringify(selected)).digest('hex').slice(0, 20),
);
for (const entry of importLegacy(selected))
  state = edit(state, entry.collection, entry.key, entry.value);
for (const operation of state.ops) operation.at = Date.parse(source.exportedAt) || 0;
await writeFile(
  output,
  JSON.stringify(
    {
      schema: 'nodeseek-flow-backup',
      version: 1,
      sourceExportedAt: source.exportedAt,
      ops: state.ops,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    records: state.ops.length,
    rules: entities(state.ops, 'rules').length,
    profileFields: selected.profileLabelKeys,
    keywordGroups: selected.followRules?.keywordGroups?.length,
    userGroups: selected.followRules?.userGroups?.length,
  }),
);

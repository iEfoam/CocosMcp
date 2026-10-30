import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ContractExamples } from '../packages/capability-catalog/src/contract-examples.js';
import { OutputContracts } from '../packages/capability-catalog/src/output-contracts.js';
import { Operations } from '../packages/capability-catalog/src/operations.js';

test('document examples match current input/output contracts and cover every shared output contract', async () => {
  const examples = new ContractExamples(), covered = new Set(examples.rows().map(row => row.id)), contracts = new OutputContracts();
  for (const row of new Operations().list()) if (contracts.schema(row.id)) assert.ok(covered.has(row.id), `Missing example: ${row.id}`);
  assert.equal(await readFile('docs/contract-examples.md', 'utf8'), examples.markdown());
});

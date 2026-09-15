import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AtomicJsonFile } from '../packages/native-adapters/src/atomic-json.js';

test('concurrent status readers see complete JSON while queued updates preserve invocation order', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.codex-work/tmp/atomic-json-')), path = join(directory, 'status.json'), writer = new AtomicJsonFile();
  await writer.write(path, { sequence: -1 });
  const writes = Array.from({ length: 40 }, (_, sequence) => writer.write(path, { sequence, payload: 'x'.repeat(20000) }));
  for (let i = 0; i < 80; i++) assert.equal(typeof JSON.parse(await readFile(path, 'utf8')).sequence, 'number');
  await Promise.all(writes); assert.equal(JSON.parse(await readFile(path, 'utf8')).sequence, 39);
  assert.deepEqual(await readdir(directory), ['status.json']);
});

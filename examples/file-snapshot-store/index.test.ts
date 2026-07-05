import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { runAgent } from '../../src/index.js';
import {
  createFileSnapshotStore,
  draftMachine,
  runFileSnapshotStoreExample,
} from './index.js';

const generateText = async ({ prompt }: { prompt?: string }) => ({ output: `Draft: ${prompt ?? ''}` });

test('multi-turn idle/resume across fresh processes via the file store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-snap-test-'));
  const store = createFileSnapshotStore(dir);
  const sessionId = 's1';

  const first = await runAgent(draftMachine, {
    input: { topic: 'release notes' },
    generateText,
  });
  expect(first.status).toBe('idle');
  store.save(sessionId, first.snapshot);

  // The checkpoint is a real JSON file on disk.
  const onDisk = JSON.parse(readFileSync(join(dir, `${sessionId}.json`), 'utf8'));
  expect(onDisk.value).toBe('reviewing');

  // Cycle 1: reject → back to reviewing (fresh runAgent = new process).
  const second = await runAgent(draftMachine, {
    snapshot: store.load(sessionId),
    event: { type: 'REJECT', reason: 'add detail' },
    generateText,
  });
  expect(second.status).toBe('idle');
  store.save(sessionId, second.snapshot);

  // Cycle 2: approve → done.
  const third = await runAgent(draftMachine, {
    snapshot: store.load(sessionId),
    event: { type: 'APPROVE' },
    generateText,
  });
  expect(third.status).toBe('done');
  if (third.status !== 'done') return;
  expect(third.output).toEqual({
    draft: 'Draft: release notes\nRevision: add detail',
  });
});

test('runFileSnapshotStoreExample runs end to end', runFileSnapshotStoreExample);

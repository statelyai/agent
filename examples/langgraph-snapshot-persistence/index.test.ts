import { test } from 'vitest';
import { runLangGraphSnapshotPersistenceExample } from './index.js';

test('persistence restores from XState snapshots without a custom runtime', runLangGraphSnapshotPersistenceExample);

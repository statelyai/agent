import { test } from 'vitest';
import { runCrewAIWriteABookExample } from './index.js';

test('write-a-book fans out chapter workers and compiles a manuscript', runCrewAIWriteABookExample);

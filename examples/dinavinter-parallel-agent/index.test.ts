import { test } from 'vitest';
import { runDinavinterParallelAgentExample } from './index.js';

test('parallel agent runs independent model requests as explicit XState invokes', runDinavinterParallelAgentExample);

import { test } from 'vitest';
import { runDinavinterTestAgentExample } from './index.js';

test('test agent keeps Assistant thread APIs as host actors and streams events into state', runDinavinterTestAgentExample);

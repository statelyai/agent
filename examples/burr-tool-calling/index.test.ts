import { test } from 'vitest';
import { runBurrToolCallingExample } from './index.js';

test('tool-calling separates tool selection, tool execution, and final formatting', runBurrToolCallingExample);

import { test } from 'vitest';
import { runLangGraphMapReduceExample } from './index.js';

test('map-reduce fan-out uses typed local actors and normal JavaScript concurrency', runLangGraphMapReduceExample);

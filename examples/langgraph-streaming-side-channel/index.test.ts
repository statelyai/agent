import { test } from 'vitest';
import { runLangGraphStreamingSideChannelExample } from './index.js';

test('streaming keeps chunks in the host side channel', runLangGraphStreamingSideChannelExample);

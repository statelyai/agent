import { test } from 'vitest';
import { runLangGraphRAGExample } from './index.js';

test('RAG keeps retrieval as a typed host actor before generation', runLangGraphRAGExample);

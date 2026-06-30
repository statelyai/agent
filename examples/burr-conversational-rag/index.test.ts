import { test } from 'vitest';
import { runBurrConversationalRAGExample } from './index.js';

test('conversational RAG stores memory in machine context before answering', runBurrConversationalRAGExample);

import { test } from 'vitest';
import { runLangGraphSQLAgentExample } from './index.js';

test('SQL-style agents keep query generation, execution, and answer synthesis explicit', runLangGraphSQLAgentExample);

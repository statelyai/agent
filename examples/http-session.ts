import { createSessionHttpHandler } from '../src/http/index.js';
import { type RunStore } from '../src/index.js';
import { createPersistenceExample } from './persistence.js';

export interface SessionHttpHandlerOptions {
  store?: RunStore;
  summarize?: Parameters<typeof createPersistenceExample>[0];
}

export function createPersistenceSessionHttpHandler(
  options: SessionHttpHandlerOptions = {}
) {
  const machine = createPersistenceExample(options.summarize);
  return createSessionHttpHandler(machine, {
    store: options.store,
  });
}

import { setupAgent } from './index.js';

// Keeps parity fixtures from presenting `setupAgent(...)` as the recommended
// authoring API while preserving the existing compatibility type coverage.
export const createExampleSetup = setupAgent;

// vitest.config.ts
import dotenv from 'dotenv';
dotenv.config();

export default {
  test: {
    testTimeout: 10000, // Global timeout of 10000ms for all tests
  },
};

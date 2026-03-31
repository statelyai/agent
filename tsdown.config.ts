import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'ai-sdk': 'src/ai-sdk/index.ts',
    graph: 'src/graph/index.ts',
    xstate: 'src/xstate/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});

import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'ai-sdk': 'src/ai-sdk/index.ts',
    cloudflare: 'src/cloudflare/index.ts',
    graph: 'src/graph/index.ts',
    http: 'src/http/index.ts',
    next: 'src/next/index.ts',
    runtime: 'src/runtime/index.ts',
    xstate: 'src/xstate/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});

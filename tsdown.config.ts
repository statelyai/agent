import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'ai-sdk': 'src/ai-sdk/index.ts',
    sqlite: 'src/sqlite/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});

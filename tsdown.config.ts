import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'ai-sdk': 'src/ai-sdk/index.ts',
    'openai-compat': 'src/openai-compat/index.ts',
    zod: 'src/zod/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
});

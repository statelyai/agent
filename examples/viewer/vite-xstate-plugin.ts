// vite-plugin-xstate-client.ts
 import { transform } from 'esbuild';

export function viteXStateClient() {
    return {
        name: 'vite-plugin-xstate-client',
        async transform(code:string, id:string) {
            if (!id.endsWith('?client')) {
                return;
            }

            // Strip the query parameter to resolve the original file path
            const filePath = id.split('?')[0];
            const result = await transform(code, {
                loader: 'ts',
                format: 'esm',
                target: 'esnext',
            });

            // Modify the machine configuration here
            // This example assumes the machine config is exported as default
            // You may need to adjust the code transformation based on your actual machine configuration structure
            const modifiedCode = result.code.replace(
                'export default',
                `const originalConfig =; export default {...originalConfig, services: Object.keys(originalConfig.services).reduce((acc, key) => ({...acc, [key]: () => fetch('/api/xstate/${id}', { method: 'POST' }).then(res => res.json())}), {}) };`
            );

            return {
                code: modifiedCode,
                map: result.map,
            };
        },
    };
}

 
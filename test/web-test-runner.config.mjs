import { esbuildPlugin } from '@web/dev-server-esbuild';
import { importMapsPlugin } from '@web/dev-server-import-maps';

export default {
  // `browser: true` honors package.json `browser` field mappings, which mediabunny uses to
  // stub out its Node-only module.
  nodeResolve: { browser: true },
  testFramework: {
    config: {
      timeout: 30000,
    },
  },
  files: ['test/**/*.spec.js', 'test/**/*.spec.ts'],
  plugins: [
    importMapsPlugin({
      inject: {
        importMap: {
          imports: {
            xhr: './test/dist/xhr.mjs',
            'xhr-mock': './test/dist/xhr-mock.mjs',
          },
        },
      },
    }),
    esbuildPlugin({ ts: true, target: 'es2021' }),
  ],
};

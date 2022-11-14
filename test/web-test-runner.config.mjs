import { esbuildPlugin } from '@web/dev-server-esbuild';
import { importMapsPlugin } from '@web/dev-server-import-maps';

export default {
  nodeResolve: true,
  /** @TODO Final home for tests. Uncomment before PR merge */
  // files: ['test/**/*.spec.js', 'test/**/*.spec.ts'],
  /** @TODO Interim home for tests to make diff/code review easier. Remove before PR merge */
  files: ['src/**/*.spec.js', 'src/**/*.spec.ts'],
  plugins: [
    importMapsPlugin({
      inject: {
        importMap: {
          imports: {
            'xhr': './test/dist/xhr.mjs',
            'xhr-mock': './test/dist/xhr-mock.mjs',
          },
        },
      },
    }),
    esbuildPlugin({ ts: true })
  ],
};
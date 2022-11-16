import { esbuildPlugin } from '@web/dev-server-esbuild';
import { importMapsPlugin } from '@web/dev-server-import-maps';

export default {
  nodeResolve: true,
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
    esbuildPlugin({ ts: true }),
  ],
};

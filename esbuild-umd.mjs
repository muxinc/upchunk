#!/usr/bin/env node

import * as esbuild from 'esbuild';
import { umdWrapper } from 'esbuild-plugin-umd-wrapper';

const umdWrapperOptions = {
  libraryName: 'UpChunk',
};

esbuild
  .build({
    entryPoints: ['src/upchunk.ts'],
    target: 'es2019',
    format: 'umd', // or "cjs"
    bundle: true,
    minify: true,
    sourcemap: true,
    outdir: './dist',
    globalName: 'UpChunk',

    plugins: [umdWrapper(umdWrapperOptions)],
  })
  .then((result) => console.log(result))
  .catch(() => process.exit(1));

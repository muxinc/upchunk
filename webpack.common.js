var path = require('path');

module.exports = {
  entry: './src/upchunk.ts',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'upchunk.js',
    library: 'UpChunk',
    libraryTarget: 'umd',
  },
};

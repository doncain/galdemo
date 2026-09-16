const path = require('path');

const PROJECT = 'minigal';
const SRC = path.resolve(__dirname, 'src/yaoguai', PROJECT);
const DIST = path.resolve(__dirname, 'dist/yaoguai', PROJECT);

module.exports = {
  entry: path.join(SRC, 'index.tsx'),
  output: {
    path: DIST,
    filename: 'index.js',
    clean: true,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        // 没有这条规则时，import './index.css' 会被「静默丢弃」——
        // 构建成功、体积正常、界面却没有任何样式，是极难查的一类事故。
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  // 宿主注入的全局库走 external：jquery -> window.$, lodash -> window._, zod -> window.z
  // react / react-dom 严禁放这里：外链会导致双 React 实例 -> 白屏 / hook 报错
  externals: {
    jquery: '$',
    lodash: '_',
    zod: 'z',
  },
  performance: { hints: false },
  devtool: false,
  stats: { preset: 'errors-warnings' },
};

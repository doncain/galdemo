// 「锁定前端」脚本的独立构建配置。
//
// ── 为什么单独一份配置、单独一个输出目录 ───────────────────────
// 1. 它是**独立交付件**：以酒馆助手脚本的形式部署，走自己的 CDN 路径，
//    与前端产物的发布节奏不一定同步。混在一个 entry 里会让它变成前端的一部分。
// 2. 主配置的 `output.clean: true` 会清空输出目录 —— 两个 entry 若写同一个
//    目录，后构建的那个会把前一个的产物删掉。
// 3. 主配置的 externals（jquery→$ 等）对它没意义：它必须零依赖，
//    因为没人保证宿主注入的全局在它运行的那个上下文里存在。

const path = require('path');

module.exports = {
  entry: path.resolve(__dirname, 'src/lock/index.ts'),
  output: {
    // 用 ASCII 目录名，不用中文 —— 中文路径在 URL 里要编码，
    // 而 CDN / import 语句里多一层编码就多一个出错的地方（本项目已在
    // git 的中文路径转义上吃过一次亏）。
    path: path.resolve(__dirname, 'dist/minigal-lock'),
    filename: 'index.js',
    clean: true,
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [{ test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
  performance: { hints: false },
  devtool: false,
  stats: { preset: 'errors-warnings' },
};

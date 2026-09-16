// 交付件的共用解析逻辑（正则 json 的形状）。
//
// ── 为什么必须共用（真实的连环失误）────────────────────────────
// 「从 replaceString 里取出 load 的 URL」这件事在三个脚本里各写了一遍：
//   verify-delivery.mjs / publish.mjs / verify-cdn.mjs
//
// 最初的写法是 /\.load\('([^']+)'\)/ —— 要求 URL 后面**紧跟一个 `)`**。
// 后来我给正则加了「加载失败提示」（load 变成 .load(url, function(...){})），
// URL 后面跟的就变成 `',` 了，于是三个脚本全部提取不到 URL。
//
// 症状是最坏的一种：**检查显示通过，备注里却是「(未解析到 URL)」**——
// 绿的，但什么都没查到。我先修了 verify-delivery，再修 publish，
// 第三次才在 verify-cdn 上撞见同一个 bug（它直接报「解析不出地址」而退出）。
//
// 抄三遍就会漏两遍。所以提取逻辑只留这一份。

/** 取出 replaceString 里所有 `$('body').load(url` 的 URL（支持带回调的写法）。 */
export function loadUrls(replaceString) {
  if (typeof replaceString !== 'string') return [];
  return [...replaceString.matchAll(/\.load\('([^']+)'/g)].map((m) => m[1]);
}

/** 取第一个 load URL；没有则返回 null。 */
export function loadUrl(replaceString) {
  return loadUrls(replaceString)[0] ?? null;
}

/**
 * 地址是否用的是**分支引用**（@master / @main / @latest 之类）。
 *
 * 为什么值得单独判一件事：jsDelivr 对分支的解析结果有缓存，且实测极不可靠 ——
 * 会长期返回几轮之前的内容，purge 文件与 purge 分支都无效。
 * 而 @<commit-sha> 是内容寻址，立刻正确。
 * 所以「用了分支引用」本身就是一个应当告警的状态，而不是一个可接受的选择。
 */
export function isBranchRef(url) {
  if (typeof url !== 'string') return false;
  const m = /@([^/]+)\//.exec(url);
  if (!m) return false;
  const ref = m[1];
  // 40 位十六进制 = 完整提交号；7~12 位全十六进制也当作提交号
  return !/^[0-9a-f]{7,40}$/i.test(ref);
}

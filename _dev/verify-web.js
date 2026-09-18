'use strict';
/**
 * 前端静态审查 —— 在浏览器之外抓住"会静默失效"的问题。
 *
 * 用法: node _dev/verify-web.js [web目录，默认 ../web]
 *
 * 覆盖的失效模式：
 *   1. 夜间模式令牌漏项 → 暗色下出现白底白字
 *   2. 组件层残留硬编码色值 → 同上，且极难排查
 *   3. 外部 css/js 路径不存在 → 页面静默空白（本项目已踩过一次）
 *   4. UMD 在浏览器环境（无 module 对象）下没挂到全局
 *   5. 内联脚本语法错误
 *   6. getElementById 的目标 id 在 HTML 里不存在
 */

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const WEB = path.resolve(process.argv[2] || path.join(__dirname, '..', 'web'));
const PAGE = path.join(WEB, 'styleguide.html');
const CSS = path.join(WEB, 'css', 'design-system.css');
const LIB = path.join(WEB, 'js', 'mbti-types.js');

let failed = 0;
const bad = (msg) => { failed++; console.log('   ❌ ' + msg); };
const good = (msg) => console.log('   ✅ ' + msg);

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

const css = read(CSS);
const html = read(PAGE);

if (!html) { console.error('找不到页面: ' + PAGE); process.exit(1); }

/* ───────── 1. 夜间模式令牌 ───────── */
console.log('\n═══ 1) 夜间模式令牌 ═══');
if (!css) {
  bad('样式表不存在');
} else {
  // 取第一个 :root 块（浅色令牌）
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  // 取 dark 媒体查询里的 :root 块
  const darkMatch = css.match(
    /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}/
  );

  if (!rootMatch) bad('未找到 :root 令牌块');
  if (!darkMatch) bad('未找到 prefers-color-scheme: dark 覆盖块');
  else good('存在 prefers-color-scheme: dark 媒体查询');

  if (rootMatch && darkMatch) {
    const names = (block) =>
      [...new Set([...block.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((m) => m[1]))];
    const light = names(rootMatch[1]);
    const dark = names(darkMatch[1]);

    console.log('   浅色令牌 ' + light.length + ' 个 · 深色覆盖 ' + dark.length + ' 个');

    // 颜色与阴影类令牌必须在深色下被覆盖，否则暗色模式会露馅
    const mustOverride = light.filter((n) => /^(c-|sh-)/.test(n));
    const missing = mustOverride.filter((n) => !dark.includes(n));
    if (missing.length) bad('以下颜色/阴影令牌缺少深色覆盖: ' + missing.join(', '));
    else good('全部 ' + mustOverride.length + ' 个颜色/阴影令牌均有深色覆盖');
  }
}

/* ───────── 2. 组件层硬编码颜色 ───────── */
console.log('\n═══ 2) 组件层硬编码颜色 ═══');
if (css) {
  // 令牌定义处本就该写死色值，剥掉两个令牌块后再扫组件层；
  // 同时剥掉注释——头部注释里记录了官方色值出处，那是文档不是样式。
  const rootBlock = (css.match(/:root\s*\{[\s\S]*?\n\}/) || [''])[0];
  const darkBlock =
    (css.match(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{[\s\S]*?\n\s*\}/) || [''])[0];
  const rest = css
    .replace(rootBlock, '')
    .replace(darkBlock, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const hexes = [...new Set([...rest.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]))];
  const fns = [...rest.matchAll(/\b(?:rgba?|hsla?)\s*\(/g)];
  const named = [
    ...new Set(
      [...rest.matchAll(/:\s*(white|black|red|blue|green|gray|grey)\s*[;!]/gi)].map((m) =>
        m[1].toLowerCase()
      )
    )
  ];

  if (hexes.length) bad('组件层残留 hex 色值: ' + hexes.join(' '));
  else good('组件层无 hex 色值');

  if (fns.length) bad('组件层残留 rgb()/rgba()/hsl(): ' + fns.length + ' 处');
  else good('组件层无 rgb()/rgba()/hsl()');

  if (named.length) bad('组件层残留具名色: ' + named.join(' '));
  else good('组件层无具名色');
}

/* ───────── 3. 资源可达性 + UMD 挂载 ───────── */
console.log('\n═══ 3) 资源与 UMD ═══');
const refs = [...html.matchAll(/(?:href|src)="([^"]+\.(?:css|js))"/g)].map((m) => m[1]);
if (!refs.length) bad('页面未引用任何 css/js');
refs.forEach((r) => {
  const p = path.resolve(WEB, r);
  if (fs.existsSync(p)) good(r + ' 存在');
  else bad(r + ' 不存在（页面会静默空白）');
});

const lib = read(LIB);
if (!lib) {
  bad('mbti-types.js 不存在');
} else {
  // 关键：真实浏览器里没有 module 对象，UMD 必须回落到 self
  const sandbox = { self: {} };
  vm.createContext(sandbox);
  try {
    vm.runInContext(lib, sandbox);
    const M = sandbox.self.MBTI;
    if (!M) bad('UMD 未把 MBTI 挂到 self（浏览器下会 undefined）');
    else {
      good('UMD 挂载正常，' + M.TYPES.length + ' 型 / ' + M.AXES.length + ' 维度');
      const incomplete = M.TYPES.filter((t) => !t.cn || !t.en || !t.color || !t.group);
      if (incomplete.length) bad('以下类型缺字段: ' + incomplete.map((t) => t.code).join(', '));
      else good('16 型字段完整（中文名 / 英文名 / 主题色 / 分组）');
      if (M.buildCode({ IE: 'I', NS: 'N', TF: 'T', PJ: 'J' }) !== 'INTJ') bad('buildCode 结果错误');
      else good('buildCode 正确');
      if (M.isValidCode('XXXX') !== false) bad('isValidCode 未拒绝非法代码');
      else good('isValidCode 正确拒绝非法代码');
    }
  } catch (e) {
    bad('库执行失败: ' + e.message);
  }
}

/* ───────── 4. 内联脚本语法 + DOM id ───────── */
console.log('\n═══ 4) 内联脚本与 DOM ═══');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  (m) => m[1]
);
console.log('   内联脚本 ' + scripts.length + ' 段');
let syntaxOk = true;
scripts.forEach((s, i) => {
  try {
    new Function(s);
  } catch (e) {
    syntaxOk = false;
    bad('第 ' + (i + 1) + ' 段语法错误: ' + e.message);
  }
});
if (syntaxOk) good('内联脚本语法通过');

const src = scripts.join('\n');
const wanted = [...new Set([...src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))];
const have = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const missingIds = wanted.filter((id) => !have.has(id));
if (missingIds.length) bad('引用不到的 DOM id: ' + missingIds.join(', '));
else good('全部 ' + wanted.length + ' 个 DOM id 都存在');

/* ───────── 5. 业务约束抽查 ───────── */
console.log('\n═══ 5) 业务约束抽查 ═══');
const checks = [
  ['密码为单个输入框（无 4 格）', /class="input input--pin"/.test(html) && !/class="pin"/.test(html)],
  ['注册区不出现"1 万种组合"类恐吓', !/1\s*万种组合|10000\s*种/.test(html)],
  ['注册区不含性别字段', !/性别/.test(html.split('个人主页')[0] || '')],
  ['性别不含"其他"选项', !/>其他</.test(html)],
  ['性别含"暂不填写"', /暂不填写/.test(html)],
  ['保留"买不起验证服务"告知', /买不起短信验证/.test(html)],
  ['修改密码需两次输入', ['pw-old', 'pw-new', 'pw-confirm'].every((id) => have.has(id))],
  ['两次不一致有错误提示', /field__error/.test(html) && /不一致/.test(html)],
  ['保存按钮默认禁用', /id="pw-save"[^>]*\bdisabled\b/.test(html)],
  ['暗色跟随系统、无手动开关', /prefers-color-scheme/.test(css || '') && !/data-theme|theme-toggle/i.test(html)]
];
checks.forEach(([name, pass]) => (pass ? good(name) : bad(name)));

/* ───────── 汇总 ───────── */
console.log('\n' + '='.repeat(50));
console.log(failed === 0 ? '  静态审查通过' : '  发现 ' + failed + ' 处问题');
console.log('='.repeat(50) + '\n');
process.exit(failed ? 1 : 0);

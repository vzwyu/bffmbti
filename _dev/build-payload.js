'use strict';
/**
 * 载荷构建 —— 把要部署的文件打成单文件压缩包，便于 scp 一次传输。
 *
 * 用法: node _dev/build-payload.js
 * 产出: _build/payload.br      （brotli 压缩，服务器用 node 解压）
 *       _build/payload.json    （明文，便于本地核对）
 *
 * 关键点（踩过坑）：
 *   - 路径分隔符必须**转成正斜杠**。Windows 上 path.join 产出反斜杠，
 *     传到 Linux 会被当成文件名的一部分，目录结构全乱。
 *   - 去注释与空行能显著减小体积（中文注释在 UTF-8 下每字 3 字节）。
 *   - brotli(11) 比 gzip(9) 小约 20%。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_build');

/** 要打包的文件（相对项目根，一律用正斜杠书写） */
const FILES = [
  'server/package.json',
  'server/bin/mbticli.js',
  'server/src/config.js',
  'server/src/db.js',
  'server/src/http.js',
  'server/src/index.js',
  'server/src/security.js',
  'server/src/routes/auth.js',
  'server/src/routes/profile.js',
  'server/src/routes/vote.js',

  'shared/mbti-types.js',

  'web/index.html',
  'web/css/design-system.css',
  'web/js/mbti-types.js',
  'web/js/api.js',
  'web/js/ui.js',
  'web/js/quiz.js',
  'web/js/app.js',
  'web/js/views/home.js',
  'web/js/views/login.js',
  'web/js/views/visitor.js',
  'web/js/views/profile.js'
];

// 16 张人格形象（webp）：按目录扫描，避免手工维护清单
const AVATAR_DIR = path.join(ROOT, 'web', 'assets', 'avatars');
if (fs.existsSync(AVATAR_DIR)) {
  fs.readdirSync(AVATAR_DIR)
    .filter((f) => f.endsWith('.webp'))
    .sort()
    .forEach((f) => FILES.push('web/assets/avatars/' + f));
}

/** 去块注释、行注释、行首缩进与多余空行。仅用于减小体积，不改变语义。 */
function strip(src, isCss) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  if (!isCss) {
    // 行注释：避免误伤 URL 里的 //，只处理不在冒号后面的
    s = s.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }
  s = s.replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n').replace(/\s+$/, '') + '\n';
  return s;
}

/** 二进制资源：必须走 base64，绝不能当文本去注释，否则文件会被损坏 */
const BINARY_EXT = /\.(webp|png|jpe?g|gif|ico|woff2?|svg)$/i;

const payload = [];
let rawTotal = 0;
let strippedTotal = 0;

for (const rel of FILES) {
  const abs = path.join(ROOT, ...rel.split('/'));
  if (!fs.existsSync(abs)) {
    console.error('❌ 缺少文件: ' + rel);
    process.exit(1);
  }

  // 强制统一为正斜杠 —— 这是给 Linux 用的
  const key = rel.split(path.sep).join('/');

  if (BINARY_EXT.test(rel)) {
    const buf = fs.readFileSync(abs);
    rawTotal += buf.length;
    strippedTotal += buf.length;
    payload.push({ f: key, b64: buf.toString('base64') });
    continue;
  }

  const src = fs.readFileSync(abs, 'utf8');
  rawTotal += Buffer.byteLength(src);
  const body = /\.json$/.test(rel) ? src : strip(src, /\.css$/.test(rel));
  strippedTotal += Buffer.byteLength(body);
  payload.push({ f: key, body });
}

// 兜底断言：任何一条路径都不许含反斜杠
for (const it of payload) {
  if (it.f.includes('\\')) {
    console.error('❌ 路径仍含反斜杠: ' + it.f);
    process.exit(1);
  }
}

// ---- 前端 JS 合并成单个 bundle ----
// 为什么必须合并：
//   页面原本要 9 个独立请求（8 个 JS + 1 个 CSS）才能启动。移动端网络抖动、
//   部分缓存失效、或任何一个文件没到位，就会缺一个全局对象，
//   整页只剩「页面未能正确加载」——2026-09-18 手机端反复出现的就是这个。
//   合并后降到 2 个请求（bundle + css），从根上消灭「部分加载」这一类失败。
// 为什么顺序必须固定：各视图文件在 IIFE 顶部就用 `var UI = global.UI` 抓住引用，
//   所以 ui.js 必须在视图之前执行，app.js 必须最后。
//   quiz.js 同理 —— visitor.js 顶部有 `var Quiz = global.Quiz`，必须排在视图之前。
//   顺序写死在这里，不要随意调整。
const JS_ORDER = [
  'web/js/mbti-types.js',
  'web/js/api.js',
  'web/js/ui.js',
  'web/js/quiz.js',
  'web/js/views/home.js',
  'web/js/views/login.js',
  'web/js/views/visitor.js',
  'web/js/views/profile.js',
  'web/js/app.js'
];

const BUNDLE_KEY = 'web/js/bundle.js';
{
  const parts = [];
  for (const key of JS_ORDER) {
    const it = payload.find((p) => p.f === key);
    if (!it || typeof it.body !== 'string') {
      console.error('❌ 合并失败，载荷里缺少条目: ' + key);
      process.exit(1);
    }
    // 分隔注释便于线上排错时定位是哪个源文件；build 已在 strip 阶段去掉原注释。
    parts.push('/* ==== ' + key + ' ==== */\n' + it.body);
  }
  const body =
    '/* 自动生成，请勿手改。源文件在 web/js/ 下，由 _dev/build-payload.js 构建期合并。 */\n' +
    parts.join('\n');
  payload.push({ f: BUNDLE_KEY, body });
  strippedTotal += Buffer.byteLength(body);
  // 落一份到 _build/，供冒烟测试直接验证「真正上线的那个产物」，而不是只测源文件
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'bundle.js'), body);
  console.log('JS 合并     : ' + JS_ORDER.length + ' 个文件 → web/js/bundle.js（' +
    (Buffer.byteLength(body) / 1024).toFixed(1) + ' KB）');
}

// ---- 缓存击穿处理 ----
// 部署会整体替换静态文件，但浏览器可能仍用缓存里的旧 JS，
// 造成「新版 HTML + 旧版 JS」不匹配（表现为「页面未能正确加载」）。
// 给所有静态资源引用加上内容指纹，发版后 URL 变化，缓存自然失效。
function fingerprint(rel) {
  const item = payload.find((p) => p.f === rel);
  if (!item) return '0';
  return crypto.createHash('sha256').update(item.body).digest('hex').slice(0, 8);
}

const idx = payload.find((p) => p.f === 'web/index.html');
if (idx) {
  let html = idx.body;

  // 第 1 步：把源码里的 8 个 <script src> 折叠成一个 bundle。
  // 源文件保持 8 个标签不变（便于本地 jsdom 测试与按文件调试），
  // 只在构建产物里合并 —— 真正上线的是合并后的这一版。
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tags = JS_ORDER.map((k) => {
    const url = '/' + k.replace(/^web\//, 'games/mbti/');
    return '<script src="' + url + '"></script>';
  });
  const blockRe = new RegExp(tags.map(esc).join('[\\s\\S]*?'));
  if (!blockRe.test(html)) {
    console.error('❌ index.html 里找不到那 8 个 <script src> 标签，无法合并。');
    console.error('   源文件的引用必须与 JS_ORDER 完全一致（含顺序）。');
    process.exit(1);
  }
  html = html.replace(blockRe, '<script src="/games/mbti/js/bundle.js"></script>');

  // 第 2 步：给所有静态资源引用加上内容指纹，发版后 URL 变化，缓存自然失效。
  // 资源已是绝对路径（/games/mbti/js/...），需要把前缀剥掉再映射回 web/ 下的键。
  const MOUNT = '/games/mbti/';
  html = html.replace(/(src|href)="((?!https?:|\/\/|data:)[^"?]+\.(?:js|css))"/g, (m, attr, url) => {
    let rel = url.replace(/^\.\//, '');
    if (rel.startsWith(MOUNT)) rel = rel.slice(MOUNT.length);
    else if (rel.startsWith('/')) rel = rel.slice(1);
    return attr + '="' + url + '?v=' + fingerprint('web/' + rel) + '"';
  });

  // 第 3 步：构建期断言 —— 线上只能有 1 个外链 <script>，否则说明合并没生效，
  // 那台「手机端部分加载」的老毛病就还在。这里宁可让构建失败，也不要带着隐患上线。
  const scriptCount = (html.match(/<script\s+src=/g) || []).length;
  if (scriptCount !== 1) {
    console.error('❌ 构建断言失败：index.html 仍有 ' + scriptCount + ' 个外链 <script>，应为 1。');
    process.exit(1);
  }
  if (!html.includes('/games/mbti/js/bundle.js?v=')) {
    console.error('❌ 构建断言失败：index.html 未引用带指纹的 bundle.js');
    process.exit(1);
  }

  const before = idx.body.length;
  idx.body = html;
  console.log('缓存指纹   : index.html 引用已加版本号（' + (html.length - before) + ' 字节）');
  console.log('请求数     : 9 → 2（bundle.js + design-system.css）');
}

const jsonOut = JSON.stringify(payload);
const br = zlib.brotliCompressSync(Buffer.from(jsonOut, 'utf8'), {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(jsonOut)
  }
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'payload.json'), jsonOut);
fs.writeFileSync(path.join(OUT, 'payload.br'), br);
fs.writeFileSync(path.join(OUT, 'payload.br.b64'), br.toString('base64'));

const sha = crypto.createHash('sha256').update(br).digest('hex');

console.log('条目数      : ' + payload.length);
console.log('原始        : ' + (rawTotal / 1024).toFixed(1) + ' KB');
console.log('去注释后    : ' + (strippedTotal / 1024).toFixed(1) + ' KB');
console.log('brotli(11)  : ' + (br.length / 1024).toFixed(1) + ' KB');
console.log('sha256      : ' + sha);
console.log('\n路径清单（全部正斜杠）：');
// 二进制条目只有 b64、没有 body —— 直接 Buffer.byteLength(it.body) 会抛
// ERR_INVALID_ARG_TYPE，导致脚本在产出文件之后仍以非 0 退出、拿不到 sha256。
payload.forEach((it) => {
  const size = it.b64 !== undefined
    ? Buffer.from(it.b64, 'base64').length
    : Buffer.byteLength(it.body);
  console.log('  ' + it.f + '  (' + size + 'B' + (it.b64 !== undefined ? ', bin' : '') + ')');
});
console.log('\n产出：_build/payload.br   （scp 到服务器后用 deploy.sh 解包）');

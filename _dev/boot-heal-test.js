'use strict';
/**
 * 启动自愈测试 —— 验证 index.html 里那段启动兜底脚本真的能救回来。
 *
 * 背景：2026-09-18 手机端反复报「页面未能正确加载」。根因是页面要 9 个独立请求
 * 才能启动，任意一个没到位就缺全局对象、整页报废。除了把请求合并成 2 个，
 * index.html 里还加了一层自愈：缺依赖时按原顺序重注入脚本（带 cache-buster），
 * 自愈不成才报错，且报错里带可诊断信息。
 *
 * 这段逻辑只写在 HTML 内联脚本里，普通单元测试覆盖不到，所以单独测。
 *
 * 用法: node _dev/boot-heal-test.js
 */

const path = require('node:path');
const fs = require('node:fs');
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (_) { JSDOM = require('C:/Users/vzwyu/.workbuddy/binaries/node/workspace/node_modules/jsdom').JSDOM; }

const HTML_PATH = path.resolve(__dirname, '..', 'web', 'index.html');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取 index.html 里所有内联脚本（无 src 的），按出现顺序。
 *  用 jsdom 解析后取 script 元素，而不是正则切 HTML ——
 *  HTML 注释里出现字面量 script 标签时，正则会切错（本文件踩过）。 */
function inlineScripts(window) {
  return Array.from(window.document.querySelectorAll('script'))
    .filter((s) => !s.getAttribute('src'))
    .map((s) => s.textContent);
}

/**
 * 起一个仿真环境：
 *   - 用真实 index.html 建 DOM（scripts 不自动执行，避免真的发请求）
 *   - 手动依次执行内联脚本（BASE 常量 → 启动兜底）
 *   - 钩住 head.appendChild，模拟「重注入的脚本加载成功/失败」
 */
async function boot({ healSucceeds }) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://www.oictech.cn/games/mbti/'
  });
  const { window } = dom;
  window.scrollTo = () => {};
  window.fetch = () => Promise.resolve({
    ok: true, status: 200,
    headers: { getSetCookie: () => [], get: () => 'application/json' },
    text: () => Promise.resolve('{"ok":true}'),
    json: () => Promise.resolve({ ok: true, user: null })
  });

  const injected = [];
  const head = window.document.head;
  const origAppend = head.appendChild.bind(head);
  head.appendChild = function (el) {
    origAppend(el);
    if (el && el.tagName === 'SCRIPT') {
      injected.push(el.getAttribute('src') || el.src || '');
      // jsdom 不会真的去取 src（resources 未开启），手动模拟加载结果
      window.setTimeout(function () {
        if (healSucceeds) {
          // 模拟「重拉之后模块齐了」
          window.MBTI = { TYPES: [] };
          window.API = {};
          window.UI = {};
          window.Views = {};
          window.App = { render() {} };
        }
        if (el.onerror && !healSucceeds) el.onerror(new window.Event('error'));
        else if (el.onload) el.onload(new window.Event('load'));
      }, 0);
    }
    return el;
  };

  await sleep(30);                       // 让 readyState 落定
  for (const code of inlineScripts(window)) window.eval(code);
  await sleep(200);                      // 等自愈链跑完

  const box = window.document.getElementById('bootError');
  const detail = window.document.getElementById('bootErrorDetail');
  return {
    window,
    injected,
    boxHidden: box ? box.hidden : null,
    detailHidden: detail ? detail.hidden : null,
    detailText: detail ? detail.textContent : ''
  };
}

(async function main() {
  console.log('\n启动自愈测试（真实 index.html 的内联兜底脚本）\n');

  // 静态检查：确认合并与兜底确实按设计存在
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  console.log('▸ 结构性检查');
  ok('index.html 存在启动兜底脚本（含 REQUIRED 列表）', /REQUIRED\s*=\s*\[/.test(html));
  const srcTags = (html.match(/<script\s+src=/g) || []).length;
  // 源码里每个 JS 文件一个标签（本地调试友好），构建期会折叠成 1 个（见 build-payload.js）。
  // 新增/删除前端模块时这个数字要跟着改 —— 数字对不上就说明两边没同步。
  ok('源码保留 9 个外链脚本（供本地调试）', srcTags === 9, '实际 ' + srcTags);
  ok('兜底脚本按原顺序重注入（用 querySelectorAll(\'script[src]\')）',
    /querySelectorAll\('script\[src\]'\)/.test(html));
  ok('重注入带 cache-buster', /'\?r='\s*\+\s*Date\.now\(\)|\?r=/.test(html));
  ok('只自愈一轮，不会死循环', /healed/.test(html));
  ok('有诊断容器 bootErrorDetail', /id="bootErrorDetail"/.test(html));
  ok('零请求 favicon（data: URI），不再去要 /favicon.ico',
    /rel="icon"[^>]*href="data:image\/svg\+xml/.test(html));

  console.log('\n▸ 场景一：依赖缺失 → 自愈成功（应当静默恢复，不弹错）');
  {
    const r = await boot({ healSucceeds: true });
    ok('检测到缺失并触发了重注入', r.injected.length > 0, '注入 ' + r.injected.length + ' 个');
    ok('重注入的 URL 带 ?r= 时间戳',
      r.injected.every((u) => u.includes('?r=')), JSON.stringify(r.injected.slice(0, 2)));
    ok('自愈后不再显示错误框', r.boxHidden === true, 'hidden=' + r.boxHidden);
  }

  console.log('\n▸ 场景二：自愈仍失败 → 给出可诊断信息（不应无声失败）');
  {
    const r = await boot({ healSucceeds: false });
    ok('错误框显示出来', r.boxHidden === false, 'hidden=' + r.boxHidden);
    ok('诊断区显示出来', r.detailHidden === false, 'hidden=' + r.detailHidden);
    ok('诊断里写明缺少哪些模块', /缺少模块：/.test(r.detailText), r.detailText.slice(0, 60));
    ok('诊断里列出加载失败的 URL', /加载失败：/.test(r.detailText));
    ok('诊断里带浏览器 UA（便于用户截图定位）', /浏览器：/.test(r.detailText));
  }

  console.log('\n' + '='.repeat(52));
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) console.log('  失败项:\n' + failures.map((f) => '    - ' + f).join('\n'));
  console.log('='.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(2); });

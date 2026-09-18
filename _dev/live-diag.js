'use strict';
/**
 * 线上页面直载诊断 —— 用 jsdom 直接吃真实 URL（不经过任何本地代理）。
 * 目的：复现用户浏览器里「页面未能正确加载」的真实原因。
 *
 * 用法（在服务器上）: node _dev/live-diag.js
 */

const { JSDOM, VirtualConsole } = require('jsdom');

const PAGE = process.env.DIAG_URL || 'https://www.oictech.cn/games/mbti/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  console.log('\n直载线上页面: ' + PAGE + '\n');

  const vc = new VirtualConsole();
  const jsErrors = [];
  const resErrors = [];
  const consoleMsgs = [];

  vc.on('jsdomError', (e) => jsErrors.push(e.message + (e.detail ? ' :: ' + e.detail : '')));
  vc.on('error', (...a) => consoleMsgs.push('[error] ' + a.join(' ')));
  vc.on('warn', (...a) => consoleMsgs.push('[warn] ' + a.join(' ')));
  vc.on('log', (...a) => consoleMsgs.push('[log] ' + a.join(' ')));

  const dom = await JSDOM.fromURL(PAGE, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.addEventListener('error', (e) =>
        jsErrors.push('window.onerror: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')));
    }
  });

  await sleep(5000);
  const { window } = dom;
  const doc = window.document;

  console.log('═══ 1) 资源加载结果 ═══');
  const scripts = [...doc.querySelectorAll('script[src]')];
  console.log('  页面引用的外部脚本: ' + scripts.length + ' 个');
  scripts.forEach((s) => console.log('    ' + s.getAttribute('src')));

  console.log('\n═══ 2) 全局对象检查 ═══');
  ['MBTI', 'API', 'UI', 'Views', 'App'].forEach((k) => {
    const ok = typeof window[k] !== 'undefined';
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + k + ' = ' + typeof window[k]);
  });
  if (window.Views) {
    console.log('  Views 成员: ' + Object.keys(window.Views).join(', '));
    console.log('  缺失的视图: ' +
      ['home', 'login', 'visitor', 'profile'].filter((k) => !window.Views[k]).join(', ') || '无');
  }

  console.log('\n═══ 3) bootError 状态（用户看到的就是它）═══');
  const boot = doc.getElementById('bootError');
  if (boot) {
    console.log('  hidden 属性 = ' + boot.hidden);
    console.log('  计算样式 display = ' + window.getComputedStyle(boot).display);
    console.log('  是否可见 = ' + (window.getComputedStyle(boot).display !== 'none' ? '❌ 可见（就是用户看到的提示）' : '✅ 不可见'));
  } else {
    console.log('  ❌ 找不到 bootError 元素');
  }

  console.log('\n═══ 4) #app 实际内容 ═══');
  const app = doc.getElementById('app');
  console.log('  子节点数: ' + (app ? app.children.length : 'n/a'));
  if (app) {
    console.log('  首个子元素: ' + (app.firstElementChild ? app.firstElementChild.className || app.firstElementChild.tagName : '无'));
    console.log('  文本片段: ' + String(app.textContent).replace(/\s+/g, ' ').slice(0, 200));
  }

  console.log('\n═══ 5) 脚本执行错误 ═══');
  if (jsErrors.length === 0) console.log('  （无）');
  jsErrors.forEach((e) => console.log('  ❌ ' + e.slice(0, 400)));

  console.log('\n═══ 6) 控制台输出 ═══');
  if (consoleMsgs.length === 0) console.log('  （无）');
  consoleMsgs.slice(0, 20).forEach((m) => console.log('  ' + m.slice(0, 300)));

  window.close();
  process.exit(0);
})().catch((e) => { console.error('诊断脚本异常:', e); process.exit(2); });

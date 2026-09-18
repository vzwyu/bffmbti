'use strict';
/**
 * 前端集成测试 —— 用 jsdom 把整页真的跑起来。
 *
 * 做法：本地起一个小服务器
 *   - /games/mbti/*         → 直接读本地 web/ 目录（避开 jsdom 的 TLS 问题）
 *   - /games/mbti/api/*     → 反向代理到线上，真打真实接口
 * 然后让 jsdom 从 http://127.0.0.1:PORT 加载页面。
 *
 * 这样验证的是：真实 HTML + 真实脚本 + 真实后端，属于真集成，不是打桩。
 *
 * 用法: node _dev/frontend-test.js
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

// jsdom 解析：优先常规 node_modules 查找（服务器上直接可用），
// 找不到再退回本机受管工作区
let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  JSDOM = require('C:/Users/vzwyu/.workbuddy/binaries/node/workspace/node_modules/jsdom').JSDOM;
}

const WEB = process.env.WEB_DIR
  ? path.resolve(process.env.WEB_DIR)
  : path.resolve(__dirname, '..', 'web');

// 接口上游：默认打**测试环境**（127.0.0.1:3001，独立数据库）。
// 本测试会真实注册账号，绝不能默认打生产。
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:3001';
const PORT = Number(process.env.TEST_PORT || 8899);

if (/oictech\.cn/.test(UPSTREAM) && !process.env.MBTI_ALLOW_PROD) {
  console.error('\n⛔ 拒绝对生产环境运行：本测试会真实注册账号。');
  console.error('   设置 MBTI_ALLOW_PROD=1 可强行运行（不建议）。\n');
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');

      // ---- 接口：转发到线上 ----
      if (url.pathname.startsWith('/games/mbti/api/')) {
        const target = UPSTREAM + url.pathname + url.search;
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const headers = Object.assign({}, req.headers);
          delete headers.host;
          headers['x-forwarded-for'] = '127.0.0.1';
          headers['x-real-ip'] = '127.0.0.1';
          const up = new URL(target);
          headers.host = up.host;
          // 上游可能是 http（测试环境）也可能是 https（线上），按协议选择
          const client = up.protocol === 'https:' ? https : http;
          const r2 = client.request({
            hostname: up.hostname,
            port: up.port || (up.protocol === 'https:' ? 443 : 80),
            path: up.pathname + up.search,
            method: req.method, headers: headers
          }, (resp) => {
            res.writeHead(resp.statusCode, resp.headers);
            resp.pipe(res);
          });
          r2.on('error', (e) => { res.writeHead(502); res.end('proxy error: ' + e.message); });
          if (body.length) r2.write(body);
          r2.end();
        });
        return;
      }

      // ---- 静态：读本地 web 目录 ----
      let p = url.pathname.replace(/^\/games\/mbti/, '') || '/';
      if (p === '/') p = '/index.html';
      const file = path.join(WEB, p);
      if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        // SPA 回退
        const idx = path.join(WEB, 'index.html');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(fs.readFileSync(idx));
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 极简 cookie 罐 */
function makeJar() {
  const jar = new Map();
  return {
    header() { return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; '); },
    absorb(list) {
      for (const sc of list || []) {
        const pair = sc.split(';')[0];
        const i = pair.indexOf('=');
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (/Max-Age=0/i.test(sc) || !v) jar.delete(k); else jar.set(k, v);
      }
    }
  };
}

(async function main() {
  const server = await startServer();
  const PAGE = 'http://127.0.0.1:' + PORT + '/games/mbti/';
  console.log('\n前端集成测试（jsdom + 本地代理）');
  console.log('页面: ' + PAGE + '   接口 → ' + UPSTREAM + '\n');

  const jar = makeJar();
  const pageErrors = [];

  const dom = await JSDOM.fromURL(PAGE, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.AbortController = AbortController;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? new URL(input, PAGE).href : String(input);
        const opts = Object.assign({}, init || {});
        opts.headers = Object.assign({}, opts.headers || {});
        const c = jar.header();
        if (c) opts.headers.Cookie = c;
        return fetch(url, opts).then((res) => {
          jar.absorb(typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
          return res;
        });
      };
      window.matchMedia = window.matchMedia || function () {
        return { matches: false, addEventListener() {}, removeEventListener() {} };
      };
      window.scrollTo = function () {};
      window.addEventListener('error', (e) => pageErrors.push(String(e.message || e)));
      window.addEventListener('unhandledrejection', (e) =>
        pageErrors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason)));
    }
  });

  const { window } = dom;
  const doc = window.document;
  await sleep(4000);

  console.log('【1】脚本加载与应用启动');
  ok('MBTI 就绪', typeof window.MBTI !== 'undefined');
  ok('API 就绪', typeof window.API !== 'undefined');
  ok('UI 就绪', typeof window.UI !== 'undefined');
  const keys = window.Views ? Object.keys(window.Views) : [];
  ok('四个视图全部注册', ['home', 'login', 'visitor', 'profile'].every((k) => keys.includes(k)),
    '实际: ' + keys.join(', '));
  ok('App 已启动', typeof window.App !== 'undefined');

  // 关键：兜底错误提示必须不可见，否则用户会看到「页面未能正确加载」
  const bootEl = doc.getElementById('bootError');
  ok('bootError 元素存在', !!bootEl);
  if (bootEl) {
    const cs = window.getComputedStyle(bootEl);
    ok('bootError 处于隐藏状态（属性）', bootEl.hidden === true, 'hidden=' + bootEl.hidden);
    ok('bootError 计算样式为 display:none', cs.display === 'none', 'display=' + cs.display);
  }
  const missing = ['MBTI', 'API', 'UI', 'Views', 'App'].filter((k) => typeof window[k] === 'undefined');
  ok('五个全局对象无一缺失', missing.length === 0, '缺失: ' + missing.join(','));

  // 记录每个脚本的加载结果，便于判断是否有 404
  const failedScripts = [...doc.querySelectorAll('script[src]')].filter((s) => {
    // 已执行的脚本其 src 能被 resources 加载；这里用性能条目兜底判断
    return false;
  });
  ok('启动阶段无未捕获错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  console.log('\n【2】顶部栏与首页视图');
  const brand = doc.querySelector('.topbar__brand');
  ok('顶部栏已渲染', !!brand);
  ok('品牌文字正确', !!brand && brand.textContent.includes('在朋友眼中'), brand && brand.textContent);
  const app = doc.getElementById('app');
  ok('#app 有内容', !!app && app.children.length > 0,
    '#app 子节点=' + (app ? app.children.length : 'n/a'));
  ok('骨架屏已被替换', !doc.querySelector('#app .skeleton'));

  console.log('\n【3】注册弹窗（未登录态）');
  const modal = doc.querySelector('.modal__panel');
  ok('注册弹窗已弹出', !!modal);
  if (!modal) {
    // 诊断：把 #app 的实际内容打出来，便于定位
    const a = doc.getElementById('app');
    console.log('     ↳ #app 子节点 ' + (a ? a.children.length : 'n/a') +
      '，内容片段: ' + String(a && a.textContent).replace(/\s+/g, ' ').slice(0, 200));
    if (a) console.log('     ↳ HTML: ' + a.innerHTML.replace(/\s+/g, ' ').slice(0, 300));
  }
  if (modal) {
    const t = modal.textContent;
    ok('标题「先认识一下」', t.includes('先认识一下'));
    ok('含称呼输入框', !!modal.querySelector('input'));
    ok('含"买不起验证服务"告知', t.includes('买不起'));
    ok('含隐私说明', t.includes('不会使用') || t.includes('个人信息'));
  }

  console.log('\n【4】16 型网格');
  const grid = doc.querySelectorAll('.types-grid .type-card');
  ok('渲染了 16 张卡片', grid.length === 16, '实际 ' + grid.length);
  if (grid.length) {
    const groups = [...grid].map((g) => g.getAttribute('data-group'));
    ok('四组齐全', new Set(groups).size === 4, [...new Set(groups)].join(','));
    ok('前 4 张为 NT（紫，分析家）', groups.slice(0, 4).every((g) => g === 'NT'));
    ok('第 5-8 张为 NF（绿，外交家）', groups.slice(4, 8).every((g) => g === 'NF'));
    ok('第 9-12 张为 SJ（蓝，守护者）', groups.slice(8, 12).every((g) => g === 'SJ'));
    ok('第 13-16 张为 SP（黄，探险家）', groups.slice(12, 16).every((g) => g === 'SP'));
    const txt = grid[0].textContent;
    ok('卡片含代码+中文名+英文名', /INTJ/.test(txt) && /架构师/.test(txt) && /Architect/.test(txt), txt.trim());
  }

  console.log('\n【5】主题色令牌');
  const rs = window.getComputedStyle(doc.documentElement);
  const expect = { '--c-nt': '#88619A', '--c-nf': '#33A474', '--c-sj': '#4298B4', '--c-sp': '#E4AE3A' };
  Object.keys(expect).forEach((k) => {
    const v = rs.getPropertyValue(k).trim().toUpperCase();
    ok(k + ' = ' + expect[k], v === expect[k], v);
  });

  console.log('\n【6】路由');
  window.App.navigate('/login');
  await sleep(1500);
  const loginTxt = (doc.getElementById('app') || {}).textContent || '';
  ok('/login 渲染登录视图', loginTxt.includes('欢迎回来') || !!doc.querySelector('#lg-acc'),
    loginTxt.slice(0, 60));

  window.App.navigate('/me');
  await sleep(1500);
  const meTxt = (doc.getElementById('app') || {}).textContent || '';
  ok('未登录访问 /me 提示先登录', meTxt.includes('请先登录'), meTxt.slice(0, 60));

  window.App.navigate('/s/nonexistenttoken123');
  await sleep(2500);
  const vTxt = (doc.getElementById('app') || {}).textContent || '';
  ok('无效分享链接友好报错', vTxt.includes('链接无效') || vTxt.includes('失效'), vTxt.slice(0, 60));

  console.log('\n【7】端到端：注册 → 选型 → 分享');
  window.App.navigate('/');
  await sleep(1500);
  const acc = 'fe' + Math.random().toString(36).slice(2, 10) + '@test.com';
  try {
    const reg = await window.API.register('前端测试用户', acc, '3729');
    ok('前端 API 层注册成功', !!(reg && reg.share_token), JSON.stringify(reg).slice(0, 80));
    ok('拿到找回码', /^[A-Z0-9]{4}-/.test(reg.recovery_code || ''), reg.recovery_code);
    window.App.store.set(reg.user);

    const set = await window.API.setMbti('INTJ');
    ok('设置 MBTI 成功', set && set.user && set.user.mbti_self === 'INTJ');

    // 必须刷新会话状态，否则 store.user.mbti_self 仍是 null，首页会停在选择页
    await window.App.store.refresh();
    window.App.render();
    await sleep(1500);
    const afterTxt = (doc.getElementById('app') || {}).textContent || '';
    ok('登录后首页显示分享链接', afterTxt.includes('专属链接') || afterTxt.includes('复制'),
      afterTxt.slice(0, 80));

    const sum = await window.API.summary(reg.share_token);
    ok('汇总接口可访问', sum && sum.summary && sum.summary.total_votes === 0);
  } catch (e) {
    ok('端到端流程', false, e.message);
    console.log('     ↳ code=' + e.code + ' status=' + e.status);
    // 直连线上接口对照，区分「前端问题」与「后端/网络问题」
    try {
      const direct = await fetch(UPSTREAM + '/games/mbti/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: '直连对照', account: 'd' + Math.random().toString(36).slice(2, 10) + '@t.com', password: '3729' })
      });
      const dt = await direct.text();
      console.log('     ↳ 直连线上对照: HTTP ' + direct.status + ' ' + dt.slice(0, 160));
    } catch (e2) {
      console.log('     ↳ 直连线上也失败: ' + e2.message);
    }
    // 走本地代理对照
    try {
      const viaProxy = await window.fetch('/games/mbti/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: '代理对照', account: 'p' + Math.random().toString(36).slice(2, 10) + '@t.com', password: '3729' })
      });
      const pt = await viaProxy.text();
      console.log('     ↳ 经本地代理: HTTP ' + viaProxy.status + ' ' + pt.slice(0, 160));
    } catch (e3) {
      console.log('     ↳ 本地代理失败: ' + e3.message);
    }
  }

  console.log('\n【8】深链接回归测试（分享链接必须能正常加载）');
  // 曾经的 bug：index.html 用相对路径 js/xxx.js，在 /games/mbti/s/<token> 下
  // 基准变成 /games/mbti/s/，请求 /games/mbti/s/js/xxx.js 被 SPA 回退成 HTML，
  // 浏览器拒绝执行 → 全局对象全空 → 弹「页面未能正确加载」。用户点自己的分享链接必踩。
  {
    const deepPath = 's/sometoken123';
    let deepOk = false, deepErr = '', deepGlobals = [];
    try {
      const ddom = await JSDOM.fromURL(
        'http://127.0.0.1:' + PORT + '/games/mbti/' + deepPath,
        {
          runScripts: 'dangerously',
          resources: 'usable',
          pretendToBeVisual: true,
          beforeParse(w) {
            w.AbortController = AbortController;
            w.fetch = function () { return Promise.reject(new Error('hit')); };
            w.matchMedia = w.matchMedia || function () {
              return { matches: false, addEventListener() {}, removeEventListener() {} };
            };
            w.scrollTo = function () {};
          }
        }
      );
      await sleep(3500);
      const dw = ddom.window;
      deepGlobals = ['MBTI', 'API', 'UI', 'Views', 'App'].filter((k) => typeof dw[k] === 'undefined');
      const dboot = dw.document.getElementById('bootError');
      deepOk = deepGlobals.length === 0 && dboot && dboot.hidden === true
        && !!dw.Views && !!dw.Views.visitor;
      const srcs = [...dw.document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
      const allAbsolute = srcs.every((s) => s.startsWith('/'));
      ok('深链接下脚本引用全部为绝对路径', allAbsolute, srcs[0]);
      dw.close();
    } catch (e) {
      deepErr = e.message;
    }
    ok('深链接 /games/mbti/s/<token> 下页面正常启动', deepOk,
      deepErr || ('缺失全局: ' + deepGlobals.join(',')));
  }

  console.log('\n【9】全程无未捕获错误');
  ok('无 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  console.log('\n' + '='.repeat(52));
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) console.log('  失败项:\n' + failures.map((f) => '    - ' + f).join('\n'));
  console.log('='.repeat(52) + '\n');

  window.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(2); });

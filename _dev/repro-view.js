'use strict';
/**
 * 最小复现：profile 视图的 appendChild 收到了非 Node。
 * 钩住 Node.prototype.appendChild 抓真实调用栈。
 */

const path = require('node:path');
const fs = require('node:fs');
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (_) { JSDOM = require('C:/Users/vzwyu/.workbuddy/binaries/node/workspace/node_modules/jsdom').JSDOM; }

const WEB = process.env.WEB_DIR
  ? path.resolve(process.env.WEB_DIR)
  : path.resolve(__dirname, '..', 'web');

const VIEW = process.argv[2] || 'profile.js';

const dom = new JSDOM(
  '<!DOCTYPE html><body><header id="topbar"></header><main id="app"></main></body>',
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/games/mbti/' }
);
const { window } = dom;

window.matchMedia = window.matchMedia || function () {
  return { matches: false, addEventListener() {} };
};
window.scrollTo = function () {};
window.__MBTI_BASE__ = '/games/mbti/api';
window.__MBTI_BASE_PATH__ = '/games/mbti';
window.AbortController = AbortController;

// 造一些像样的假响应，让视图能走到较深的渲染分支
const FAKE = {
  user: {
    token: 'TESTTOKEN123', nickname: '测试用户', gender: 'female',
    login_account: 't***@test.com', mbti_self: 'INTJ', mbti_edit_count: 0,
    created_at: new Date().toISOString()
  },
  summary: {
    total_votes: 6, low_sample: false, has_votes: true,
    majority_mbti: 'INTJ', self_mbti: 'INTJ', divergence_axes: ['TF'],
    axes: [
      { key: 'IE', left: 'I', right: 'E', leftCn: '内向', rightCn: '外向',
        leftCount: 4, rightCount: 2, majority: 'I', tie: false,
        selfChoice: 'I', agreeWithMajority: true },
      { key: 'NS', left: 'N', right: 'S', leftCn: '直觉', rightCn: '实感',
        leftCount: 4, rightCount: 2, majority: 'N', tie: false,
        selfChoice: 'N', agreeWithMajority: true },
      { key: 'TF', left: 'T', right: 'F', leftCn: '思考', rightCn: '情感',
        leftCount: 3, rightCount: 3, majority: 'T', tie: true,
        selfChoice: 'T', agreeWithMajority: true },
      { key: 'PJ', left: 'P', right: 'J', leftCn: '感知', rightCn: '判断',
        leftCount: 2, rightCount: 4, majority: 'J', tie: false,
        selfChoice: 'J', agreeWithMajority: true }
    ]
  },
  votes: {
    total: 2,
    votes: [
      { voter_nickname: '小林', result_mbti: 'ENFJ',
        detail: { code: 'ENFJ', cn: '主人公', en: 'Protagonist', group: 'NF', color: '#33A474' },
        created_at: new Date().toISOString() },
      { voter_nickname: '阿哲', result_mbti: 'ENFP',
        detail: { code: 'ENFP', cn: '活动家', en: 'Campaigner', group: 'NF', color: '#33A474' },
        created_at: new Date().toISOString() }
    ]
  },
  perm: { ok: true, can_edit: true, reason: 'available', remaining_edits: 1, label: '你还可以修改 1 次（仅此一次）' }
};

window.fetch = function (input, init) {
  const url = String(input);
  let body = { ok: true };
  if (url.includes('/auth/me')) body = { ok: true, user: FAKE.user };
  else if (url.includes('/summary')) body = { ok: true, summary: FAKE.summary };
  else if (url.includes('/votes')) body = FAKE.votes;
  else if (url.includes('mbti-permission')) body = FAKE.perm;
  else if (url.includes('/auth/logout')) body = { ok: true };
  return Promise.resolve({
    ok: true, status: 200,
    headers: { getSetCookie: () => [], get: () => 'application/json' },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body)
  });
};

function load(rel) {
  window.eval(fs.readFileSync(path.join(WEB, rel), 'utf8'));
}

load('js/mbti-types.js');
load('js/api.js');
load('js/ui.js');
for (const v of ['home', 'login', 'visitor', 'profile']) load('js/views/' + v + '.js');
load('js/app.js');

// 钩住 appendChild
(function patch() {
  const proto = window.Node.prototype;
  const orig = proto.appendChild;
  proto.appendChild = function (child) {
    const isNode = child && typeof child === 'object' && typeof child.nodeType === 'number';
    if (!isNode) {
      const tag = this.tagName ? this.tagName.toLowerCase() : String(this);
      console.log('\n❌ appendChild 收到非 Node');
      console.log('   父节点: <' + tag + '> class="' + (this.className || '') + '"');
      console.log('   类型: ' + Object.prototype.toString.call(child));
      if (Array.isArray(child)) console.log('   ⚠️ 数组，长度 ' + child.length);
      console.log('   内容: ' + String(child).slice(0, 160));
      console.log('   调用栈:');
      console.log(new Error().stack.split('\n').slice(2, 9).join('\n'));
      console.log('');
    }
    return orig.call(this, child);
  };
})();

// 也钩住 console.error，捕捉视图内部的错误日志
const origErr = window.console.error;
window.console.error = function () {
  const s = Array.prototype.map.call(arguments, String).join(' ');
  if (!/fetch is not defined/.test(s)) console.log('[view console.error] ' + s.slice(0, 300));
  return origErr.apply(window.console, arguments);
};

(async function main() {
  const name = VIEW.replace('.js', '');
  console.log('\n调用 Views.' + name + '()…\n');

  const ctx = {
    params: { token: 'TESTTOKEN123' },
    query: {},
    store: {
      user: FAKE.user,
      isLoggedIn() { return true; },
      shareToken() { return FAKE.user.token; },
      set() {}, clear() {}, refresh() { return Promise.resolve(FAKE.user); }
    },
    navigate() {}
  };

  try {
    const node = await window.Views[name](ctx);
    console.log('返回: ' + Object.prototype.toString.call(node));
    if (node && node.nodeType) {
      console.log('标签: <' + node.tagName.toLowerCase() + '>');
      const html = node.outerHTML || '';
      console.log('子节点数: ' + (node.children ? node.children.length : 'n/a'));
      console.log('片段: ' + html.replace(/\s+/g, ' ').slice(0, 300));
    } else {
      console.log('⚠️ 返回的不是 DOM 节点！' + String(node).slice(0, 200));
    }
  } catch (e) {
    console.log('❌ 抛出异常: ' + e.message);
    console.log(e.stack.split('\n').slice(0, 8).join('\n'));
  }

  await new Promise((r) => setTimeout(r, 1500));
  window.close();
  process.exit(0);
})();

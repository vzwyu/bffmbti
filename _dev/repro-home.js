'use strict';
/**
 * 最小复现：把 UI / MBTI / api 加载进 jsdom，直接调 Views.home()，
 * 打印完整调用栈，精确定位 appendChild 收到非 Node 的位置。
 */

const path = require('node:path');
const fs = require('node:fs');
const WS = 'C:/Users/vzwyu/.workbuddy/binaries/node/workspace/node_modules';
const { JSDOM } = require(path.join(WS, 'jsdom'));

const WEB = path.resolve(__dirname, '..', 'web');

const dom = new JSDOM('<!DOCTYPE html><body><header id="topbar"></header><main id="app"></main></body>', {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost/games/mbti/'
});
const { window } = dom;

window.matchMedia = window.matchMedia || function () {
  return { matches: false, addEventListener() {} };
};
window.scrollTo = function () {};
window.fetch = function () { return Promise.reject(new Error('offline')); };
window.AbortController = AbortController;
window.__MBTI_BASE__ = '/games/mbti/api';
window.__MBTI_BASE_PATH__ = '/games/mbti';

function load(rel) {
  const src = fs.readFileSync(path.join(WEB, rel), 'utf8');
  window.eval(src);
}

load('js/mbti-types.js');
load('js/api.js');
load('js/ui.js');
load('js/views/home.js');

const ctx = {
  params: {},
  query: {},
  store: {
    user: null,
    isLoggedIn() { return false; },
    shareToken() { return null; },
    set() {}, clear() {}, refresh() { return Promise.resolve(null); }
  },
  navigate() {}
};

// 全局钩住 appendChild：任何非 Node 参数立刻打出真实调用栈
(function patchAppendChild() {
  const proto = window.Node.prototype;
  const orig = proto.appendChild;
  proto.appendChild = function (child) {
    const isNode = child && typeof child === 'object' && typeof child.nodeType === 'number';
    if (!isNode) {
      const tag = this.tagName ? this.tagName.toLowerCase() : String(this);
      console.log('\n❌ appendChild 收到非 Node！');
      console.log('   父节点: <' + tag + '>  class="' + (this.className || '') + '"');
      console.log('   参数类型: ' + Object.prototype.toString.call(child));
      console.log('   参数内容: ' + String(child).slice(0, 200));
      if (Array.isArray(child)) {
        console.log('   ⚠️ 是数组（长度 ' + child.length + '），UI.el 与 appendChild 都不接受嵌套数组');
      }
      console.log('   真实调用栈:');
      console.log(new Error().stack.split('\n').slice(2, 10).join('\n'));
      console.log('');
    }
    return orig.call(this, child);
  };
})();

console.log('\n调用 Views.home()…\n');
try {
  const node = window.Views.home(ctx);
  console.log('返回类型: ' + Object.prototype.toString.call(node));
  if (node && node.nodeType) {
    console.log('节点标签: <' + node.tagName.toLowerCase() + '>');
    console.log('子节点数: ' + node.children.length);
  }
  const html = node && node.outerHTML ? node.outerHTML : String(node);
  console.log('\n渲染结果片段:\n' + html.replace(/\s+/g, ' ').slice(0, 600));
} catch (e) {
  console.log('❌ home() 抛出异常: ' + e.message);
  console.log(e.stack);
}

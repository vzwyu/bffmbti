'use strict';
/**
 * 应用外壳 —— 会话状态、路由、视图挂载。
 *
 * 视图契约（各视图模块必须遵守）：
 *   window.Views.xxx = function (ctx) { ... return Node | Promise<Node> }
 *   ctx = {
 *     params,        // 路径参数，如 { token: 'abc' }
 *     query,         // { k: v }
 *     store,         // 会话状态，store.user 为 selfUser 或 null
 *     navigate(path) // 站内跳转（相对挂载前缀，如 '/me'）
 *   }
 *   返回值：要挂进 #app 的 DOM 节点。视图自己负责把所有异常处理掉，
 *   路由层只兜底，不替视图吞错。
 */

(function (global) {
  var UI = global.UI;
  var API = global.API;

  var BASE_PATH = (global.__MBTI_BASE_PATH__ || '/games/mbti').replace(/\/+$/, '');
  var appRoot = null;

  /* ------------------------------------------------------------------ */
  /* 会话状态                                                            */
  /* ------------------------------------------------------------------ */

  var store = {
    user: null,
    ready: false,
    /** @returns {Promise<object|null>} */
    refresh: function () {
      return API.me()
        .then(function (r) {
          store.user = r && r.user ? r.user : null;
          store.ready = true;
          return store.user;
        })
        .catch(function () {
          // 未登录是正常状态，不是错误
          store.user = null;
          store.ready = true;
          return null;
        });
    },
    set: function (user) { store.user = user || null; store.ready = true; },
    clear: function () { store.user = null; store.ready = true; },
    isLoggedIn: function () { return !!store.user; },
    /** 分享链接用的公开标识 */
    shareToken: function () { return store.user ? store.user.token : null; }
  };

  /* ------------------------------------------------------------------ */
  /* 路由                                                                */
  /* ------------------------------------------------------------------ */

  var ROUTES = [
    { pattern: '/', view: 'home' },
    { pattern: '/login', view: 'login' },
    { pattern: '/me', view: 'profile' },
    { pattern: '/s/:token', view: 'visitor' }
  ];

  function match(pathname) {
    var segs = pathname.split('/').filter(Boolean);
    for (var i = 0; i < ROUTES.length; i++) {
      var pat = ROUTES[i].pattern.split('/').filter(Boolean);
      if (pat.length !== segs.length) continue;
      var params = {};
      var ok = true;
      for (var j = 0; j < pat.length; j++) {
        if (pat[j].charAt(0) === ':') params[pat[j].slice(1)] = decodeURIComponent(segs[j]);
        else if (pat[j] !== segs[j]) { ok = false; break; }
      }
      if (ok) return { view: ROUTES[i].view, params: params };
    }
    return null;
  }

  /** 当前浏览器地址对应的站内路径（已剥掉挂载前缀） */
  function currentPath() {
    var p = global.location.pathname;
    if (BASE_PATH && p.indexOf(BASE_PATH) === 0) p = p.slice(BASE_PATH.length);
    return p || '/';
  }

  function navigate(path) {
    var url = BASE_PATH + path;
    if (url === global.location.pathname + global.location.search) return;
    global.history.pushState({}, '', url);
    render();
  }

  function parseQuery() {
    var out = {};
    new URLSearchParams(global.location.search).forEach(function (v, k) { out[k] = v; });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 顶部栏                                                              */
  /* ------------------------------------------------------------------ */

  function renderTopbar(title) {
    var bar = document.getElementById('topbar');
    UI.clear(bar);

    var inner = UI.el('div', { class: 'topbar__inner' });
    var brand = UI.el('div', { class: 'topbar__brand', text: title || '在朋友眼中，你的MBTI是什么？' });
    inner.appendChild(brand);

    var actions = UI.el('div', { class: 'topbar__actions' });

    if (store.isLoggedIn()) {
      var meBtn = UI.el('button', { class: 'btn btn--ghost btn--sm', text: '我的主页' });
      meBtn.addEventListener('click', function () { navigate('/me'); });
      actions.appendChild(meBtn);
    } else {
      var loginBtn = UI.el('button', { class: 'btn btn--quiet btn--sm', text: '登录' });
      loginBtn.addEventListener('click', function () { navigate('/login'); });
      actions.appendChild(loginBtn);
    }
    inner.appendChild(actions);
    bar.appendChild(inner);
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  var renderToken = 0;

  function render() {
    var path = currentPath();
    var hit = match(path);
    var myToken = ++renderToken;

    if (!hit) {
      renderTopbar();
      UI.clear(appRoot);
      appRoot.appendChild(UI.empty('404', '页面不存在', '检查一下网址，或者回到首页重新开始'));
      var back = UI.el('div', { class: 'center', style: { marginTop: 'var(--sp-4)' } }, [
        UI.el('button', { class: 'btn', text: '回到首页', onclick: function () { navigate('/'); } })
      ]);
      appRoot.appendChild(back);
      global.scrollTo(0, 0);
      return;
    }

    var view = global.Views && global.Views[hit.view];
    if (typeof view !== 'function') {
      UI.clear(appRoot);
      appRoot.appendChild(UI.alertBox('error', '页面模块 "' + hit.view + '" 未加载，请刷新重试'));
      return;
    }

    var ctx = { params: hit.params, query: parseQuery(), store: store, navigate: navigate };

    Promise.resolve()
      .then(function () { return view(ctx); })
      .then(function (node) {
        // 期间用户已经跳走，丢弃这次结果，避免旧视图覆盖新页面
        if (myToken !== renderToken) return;
        UI.clear(appRoot);
        appRoot.appendChild(node);
        renderTopbar();
        global.scrollTo(0, 0);
      })
      .catch(function (err) {
        if (myToken !== renderToken) return;
        console.error('[view error]', err);
        UI.clear(appRoot);
        appRoot.appendChild(UI.empty('!', '页面加载失败',
          (err && err.message) ? err.message : '请稍后重试'));
        var retry = UI.el('div', { class: 'center', style: { marginTop: 'var(--sp-4)' } }, [
          UI.el('button', {
            class: 'btn', text: '重试',
            onclick: function () { render(); }
          })
        ]);
        appRoot.appendChild(retry);
      });
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    appRoot = document.getElementById('app');

    // 站内链接拦截：让 <a data-nav="/me"> 走前端路由，不触发整页刷新
    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-nav]') : null;
      if (!a) return;
      e.preventDefault();
      navigate(a.getAttribute('data-nav'));
    });

    global.addEventListener('popstate', render);

    // 先确认真实登录态再渲染，避免"闪一下未登录"
    store.refresh().then(function () {
      render();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.App = { store: store, navigate: navigate, render: render, BASE_PATH: BASE_PATH };
})(typeof window !== 'undefined' ? window : this);

'use strict';
/**
 * 视图冒烟测试 —— 用假数据把四个视图真的渲染一遍。
 *
 * 为什么需要它：静态检查只能查「调用了不存在的函数」，
 * 查不出「访问了返回值上不存在的属性」（如 field.wrap vs field.el），
 * 这类问题只会在运行时炸，而且报错信息往往是
 * "appendChild: parameter 1 is not of type 'Node'" 这种看不出根因的。
 *
 * 用法: node _dev/view-smoke-test.js
 */

const path = require('node:path');
const fs = require('node:fs');
let JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (_) { JSDOM = require('C:/Users/vzwyu/.workbuddy/binaries/node/workspace/node_modules/jsdom').JSDOM; }

const WEB = process.env.WEB_DIR
  ? path.resolve(process.env.WEB_DIR)
  : path.resolve(__dirname, '..', 'web');

// MBTI_BUNDLE=<path> 时改跑「构建期合并产物」（真正上线的那份，见 build-payload.js）
const BUNDLE = process.env.MBTI_BUNDLE ? path.resolve(process.env.MBTI_BUNDLE) : null;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------- 假数据 ---------- */
const USER = {
  token: 'TESTTOKEN123', nickname: '测试用户', gender: 'female',
  login_account: 't***@test.com', mbti_self: 'INTJ', mbti_edit_count: 0,
  created_at: new Date(Date.now() - 86400000 * 40).toISOString()
};
const SUMMARY = {
  total_votes: 6, low_sample: false, has_votes: true,
  majority_mbti: 'INTJ', self_mbti: 'INTJ', divergence_axes: ['TF'],
  axes: [
    { key: 'IE', left: 'I', right: 'E', leftCn: '内向', rightCn: '外向',
      leftCount: 4, rightCount: 2, majority: 'I', tie: false, selfChoice: 'I', agreeWithMajority: true },
    { key: 'NS', left: 'N', right: 'S', leftCn: '直觉', rightCn: '实感',
      leftCount: 4, rightCount: 2, majority: 'N', tie: false, selfChoice: 'N', agreeWithMajority: true },
    { key: 'TF', left: 'T', right: 'F', leftCn: '思考', rightCn: '情感',
      leftCount: 3, rightCount: 3, majority: 'T', tie: true, selfChoice: 'T', agreeWithMajority: true },
    { key: 'PJ', left: 'P', right: 'J', leftCn: '感知', rightCn: '判断',
      leftCount: 2, rightCount: 4, majority: 'J', tie: false, selfChoice: 'J', agreeWithMajority: true }
  ]
};
const VOTES = {
  total: 2,
  valid_total: 1,
  invalid_total: 1,
  votes: [
    { id: 11, voter_nickname: '小林', result_mbti: 'ENFJ', invalid: false,
      detail: { code: 'ENFJ', cn: '主人公', en: 'Protagonist', group: 'NF', color: '#33A474' },
      created_at: new Date().toISOString() },
    { id: 12, voter_nickname: '🦊 狐狸先生', result_mbti: 'ENFP', invalid: true,
      detail: { code: 'ENFP', cn: '活动家', en: 'Campaigner', group: 'NF', color: '#33A474' },
      created_at: new Date().toISOString() }
  ]
};
/* ---------- 我发给别人的评价（「查看我对他人的评价」用） ---------- */
const GIVEN_VOTES = {
  ok: true,
  total: 2,
  votes: [
    { id: 31, target_token: 'TARGETAAA', target_nickname: '小林', my_choice: 'ENFP',
      my_choice_detail: { code: 'ENFP', cn: '活动家', en: 'Campaigner', group: 'NF', color: '#33A474' },
      target_majority: 'INTJ', target_self: 'ENFJ', created_at: new Date().toISOString() },
    { id: 30, target_token: 'TARGETBBB', target_nickname: '还没有人选类型的人', my_choice: 'ISTP',
      my_choice_detail: { code: 'ISTP', cn: '鉴赏家', en: 'Virtuoso', group: 'SP', color: '#E4AE3A' },
      target_majority: null, target_self: null, created_at: new Date().toISOString() }
  ]
};

const PERM = { ok: true, can_edit: true, reason: 'available', remaining_edits: 1,
  label: '你还可以修改 1 次（仅此一次）' };

function makeDom(opts) {
  opts = opts || {};
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
  window.navigator.clipboard = { writeText: () => Promise.resolve() };

  window.fetch = function (input) {
    const url = String(input);
    let body = { ok: true };
    if (url.includes('/auth/me')) body = { ok: true, user: USER };
    else if (url.includes('/auth/register')) body = { ok: true, user: USER, recovery_code: 'AAAA-BBBB-CCCC', share_token: USER.token };
    else if (url.includes('/auth/login')) body = { ok: true, user: USER };
    else if (url.includes('/me/mbti')) body = { ok: true, user: USER, changed: true, remaining_edits: 0 };
    else if (url.includes('mbti-permission')) body = PERM;
    else if (url.includes('/my-vote')) {
      body = opts.alreadyVoted
        ? { ok: true, voted: true,
            // 注意：真实接口**不返回** invalid —— 失效状态不透给评价人
            vote: { id: 7, your_choice: 'ENFP',
              your_choice_detail: { code: 'ENFP', cn: '活动家', en: 'Campaigner', group: 'NF', color: '#33A474' },
              created_at: new Date().toISOString() },
            summary: SUMMARY }
        : { ok: true, voted: false, vote: null, summary: SUMMARY };
    }
    else if (url.includes('/me/votes-given')) body = opts.givenVotes || GIVEN_VOTES;
    else if (url.includes('/summary')) body = { ok: true, summary: SUMMARY };
    else if (url.includes('/votes')) body = VOTES;
    // 注意顺序：/u/<token>/vote 也包含 "/u/"，这条**必须排在 /u/ 之前**，
    // 否则投票会拿到"公开用户信息"的桩数据，结果页就渲染不出来。
    else if (url.includes('/vote')) body = { ok: true, your_choice: 'ENFJ',
      your_choice_detail: { code: 'ENFJ', cn: '主人公', en: 'Protagonist', group: 'NF', color: '#33A474' }, summary: SUMMARY };
    else if (url.includes('/u/')) body = { ok: true, user: { token: 'X', nickname: '被评价者',
      gender: opts.targetGender || 'unset', mbti_self: 'INTJ' } };
    return Promise.resolve({
      ok: true, status: 200,
      headers: { getSetCookie: () => [], get: () => 'application/json' },
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body)
    });
  };

  const load = (rel) => window.eval(fs.readFileSync(path.join(WEB, rel), 'utf8'));
  if (BUNDLE) {
    // 直接跑「真正上线的那份合并产物」，而不是逐个源文件。
    // 否则「源文件都对、合并后出错」这类只在线上暴露的问题永远测不出来。
    window.eval(fs.readFileSync(BUNDLE, 'utf8'));
  } else {
    load('js/mbti-types.js');
    load('js/api.js');
    load('js/ui.js');
    load('js/quiz.js');
    for (const v of ['home', 'login', 'visitor', 'profile']) load('js/views/' + v + '.js');
    load('js/app.js');
  }

  // 钩住 appendChild：抓到非 Node 立即记录真实调用栈
  const violations = [];
  const proto = window.Node.prototype;
  const orig = proto.appendChild;
  proto.appendChild = function (child) {
    const isNode = child && typeof child === 'object' && typeof child.nodeType === 'number';
    if (!isNode) {
      const frames = (new Error().stack || '').split('\n').slice(1, 8)
        .map((s) => s.trim().replace(/^at\s+/, ''))
        .map((s) => {
          // 只保留有意义的一行，去掉 eval 包裹的噪音
          const m = s.match(/<anonymous>:(\d+):(\d+)/);
          return m ? 'line ' + m[1] : s.slice(0, 80);
        });
      violations.push('<' + (this.tagName || '?').toLowerCase() + '>.appendChild(' +
        Object.prototype.toString.call(child) + ')  栈: ' + frames.join(' ← '));
    }
    return orig.call(this, child);
  };

  // 钩住 UI.el：它是所有子节点进入 DOM 的唯一入口。
  // 直接指出「哪个标签、第几个子项、是什么类型」，比追 appendChild 的栈清楚得多。
  const origEl = window.UI.el;
  window.UI.el = function (tag, props, children) {
    if (children != null) {
      const arr = Array.isArray(children) ? children : [children];
      arr.forEach((c, i) => {
        if (c == null || c === false) return;
        const isNode = c && typeof c === 'object' && typeof c.nodeType === 'number';
        const isText = typeof c === 'string' || typeof c === 'number';
        if (!isNode && !isText) {
          violations.push('UI.el("<' + tag + '">) 第 ' + i + ' 个子项是 ' +
            Object.prototype.toString.call(c) + '，值=' + String(c).slice(0, 80));
        }
      });
    }
    return origEl.call(window.UI, tag, props, children);
  };

  const pageErrors = [];
  window.addEventListener('error', (e) => pageErrors.push(String(e.message || e)));

  return { dom, window, violations, pageErrors };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 逐个视图跑 ---------- */
const CASES = [
  {
    name: 'home（未登录，应弹注册窗 + 显示 16 型网格 + 去登录入口）',
    view: 'home',
    store: { user: null, isLoggedIn: () => false, shareToken: () => null },
    params: {}, expectSel: '.types-grid .type-card', expectCount: 16,
    // 注册窗里必须同时有主按钮和「已有账号？去登录」
    extraChecks: (doc) => {
      const texts = [...doc.querySelectorAll('.modal__panel button')].map((b) => b.textContent);
      const t = doc.body.textContent;
      const labels = [...doc.querySelectorAll('.modal__panel .field__label')].map((l) => l.textContent);
      return [
        ['注册窗含「创建并开始选择」', texts.some((x) => /创建并开始选择/.test(x))],
        ['注册窗含「已有账号？去登录」', texts.some((x) => /已有账号.*去登录/.test(x))],
        ['密码提示已改为「等其他密码一致」',
          /请勿与银行卡密码等其他密码一致/.test(t)],
        // 2026-09-18 合规整改：不再索要 QQ 号（微信外链规范 2.11.3）
        ['注册窗全窗不再出现「QQ」字样', !/QQ/i.test(t)],
        ['账号字段 label 为「邮箱 / 手机号」',
          labels.some((x) => /邮箱\s*\/\s*手机号/.test(x)) && !labels.some((x) => /QQ/i.test(x))]
      ];
    }
  },
  {
    name: 'home（已登录未选类型，应显示可交互网格）',
    view: 'home',
    store: { user: Object.assign({}, USER, { mbti_self: null }), isLoggedIn: () => true, shareToken: () => USER.token },
    params: {}, expectSel: '.types-grid .type-card', expectCount: 16
  },
  {
    name: 'home（已有类型，应显示分享页）',
    view: 'home',
    store: { user: USER, isLoggedIn: () => true, shareToken: () => USER.token },
    params: {}, expectSel: '.share-box__url', expectCount: 1
  },
  {
    name: 'login（纯登录表单，找回功能已关闭）',
    view: 'login',
    store: { user: null, isLoggedIn: () => false, shareToken: () => null },
    params: {}, expectSel: 'input', expectMin: 2,
    extraChecks: (doc) => {
      const t = doc.body.textContent;
      return [
        ['显示「欢迎回来」', /欢迎回来/.test(t)],
        ['不再有「忘记密码」入口', !/忘记密码/.test(t)],
        ['不再有找回码输入', !/找回码|XXXX-XXXX-XXXX/.test(t)],
        ['含「还没有账号？去创建」', /还没有账号/.test(t)]
      ];
    }
  },
  {
    name: 'visitor（访客评价页：先弹问称呼，点确认后出四轴量表）',
    view: 'visitor',
    store: { user: null, isLoggedIn: () => false, shareToken: () => null },
    params: { token: 'TESTTOKEN123' },
    // 初始应只有弹窗，没有量表
    beforeClickSel: '.modal__panel', beforeClickCount: 1,
    clickActionBtn: true,
    expectSel: '.axis', expectCount: 4,
    extraChecks: (doc) => {
      // 注意：此时已点过「开始评价」，弹窗已关闭，所以只能查页面本体。
      // 「已有账户？去登录」的断言放在下面那条独立用例里（弹窗还开着的时候查）。
      const t = doc.body.textContent;
      return [
        ['量表已渲染（弹窗关闭后）', /的 MBTI 更倾向/.test(t)],
        ['未登录时不显示「以某某身份署名」', !/的身份署名/.test(t)]
      ];
    }
  },
  {
    name: 'visitor（未登录：称呼弹窗里应有「已有账户？去登录」）',
    view: 'visitor',
    // isLoggedIn 为 false → 走问称呼流程，弹窗保持打开
    store: { user: null, isLoggedIn: () => false, shareToken: () => null },
    params: { token: 'TESTTOKEN123' },
    // 不设 clickActionBtn → 不点「开始评价」，弹窗保持打开，便于断言按钮
    expectSel: '.modal__panel', expectCount: 1,
    extraChecks: (doc) => {
      const btns = [...doc.querySelectorAll('.modal__panel button')].map((b) => b.textContent);
      return [
        ['弹窗里有「开始评价」', btns.some((x) => /开始评价/.test(x))],
        ['弹窗里有「已有账户？去登录」', btns.some((x) => /已有账户.*去登录/.test(x))],
        ['两个按钮区分主次（primary + ghost）',
          !!doc.querySelector('.modal__panel .btn') && !!doc.querySelector('.modal__panel .btn--ghost')]
      ];
    }
  },
  {
    name: 'visitor（已登录 + 之前评价过 → 弹「你之前已经评价过他了」）',
    view: 'visitor',
    // 已登录：走 myVote 分支；domOpts.alreadyVoted 让桩接口返回"投过"
    store: { user: { token: 'ME', nickname: '我', mbti_self: 'INTJ' }, isLoggedIn: () => true, shareToken: () => 'ME' },
    params: { token: 'TESTTOKEN123' },
    domOpts: { alreadyVoted: true },
    expectSel: '.modal__panel', expectCount: 1,
    extraChecks: (doc) => {
      const t = doc.body.textContent;
      const btns = [...doc.querySelectorAll('.modal__panel button')].map((b) => b.textContent);
      const btnEls = [...doc.querySelectorAll('.modal__panel button')];
      const out = [
        ['弹窗标题为「你之前已经评价过他了」', /你之前已经评价过他了/.test(t)],
        ['说明一个人只算一次', /只算一次/.test(t)],
        ['展示我当时的判断', /你当时的判断：ENFP/.test(t)],
        ['按钮 1：去查看结果', btns.some((x) => /去查看结果/.test(x))],
        ['按钮 2：去修改', btns.some((x) => /去修改/.test(x))],
        ['按钮 3：回到主页', btns.some((x) => /回到主页/.test(x))],
        // dismissible:false → 没有右上角 ×，出口靠这三个按钮
        ['三个按钮齐全（共 3 个）', btns.length === 3, '实际 ' + btns.length],
        // 被对方标为失效这件事不能透给评价人 —— 等于替对方传话，只会制造矛盾
        ['不出现「失效」字样（不替对方传话）', !/失效/.test(t)],
        ['不出现「不计入统计」字样', !/不计入统计/.test(t)],
        ['没有四轴量表（不该再让人评一遍）', doc.querySelectorAll('.axis').length === 0],
        ['也没有再问称呼', !/我该怎么称呼您/.test(t)]
      ];

      // 点「去查看结果」→ 结果页的称呼必须指被评价人，不能是「你」
      const go = btnEls.find((b) => /去查看结果/.test(b.textContent));
      if (go) go.click();
      out.push(['点「去查看结果」能进结果页', doc.querySelectorAll('.result-card').length >= 2]);
      out.push(['被评价人没填性别 → 用「他/她」', /大家怎么看他\/她/.test(doc.body.textContent)]);
      out.push(['计分条标签也用「他/她：」（不是「你：」）',
        /他\/她：[A-Z]/.test(doc.body.textContent) &&
        !/你：/.test(doc.body.textContent)]);
      return out;
    }
  },
  {
    name: 'visitor（被评价人是女生 → 结果页用「她」）',
    view: 'visitor',
    store: { user: { token: 'ME', nickname: '我', mbti_self: 'INTJ' }, isLoggedIn: () => true, shareToken: () => 'ME' },
    params: { token: 'TESTTOKEN123' },
    domOpts: { alreadyVoted: true, targetGender: 'female' },
    expectSel: '.modal__panel', expectCount: 1,
    extraChecks: (doc) => {
      const go = [...doc.querySelectorAll('.modal__panel button')].find((b) => /去查看结果/.test(b.textContent));
      if (go) go.click();
      const t = doc.body.textContent;
      return [
        ['进到结果页', doc.querySelectorAll('.result-card').length >= 2],
        ['标题用「她」：大家怎么看她', /大家怎么看她/.test(t)],
        ['不出现「大家怎么看你」', !/大家怎么看你/.test(t)],
        ['计分条标签用「她：」', /她：[A-Z]/.test(t)],
        ['计分条里不再出现「你：」', !/你：/.test(t)],
        // 「你认为」是评价人自己的判断，必须保留「你」
        ['评价人自己的卡片仍写「你认为」', /你认为/.test(t)]
      ];
    }
  },
  {
    name: 'profile（个人主页）',
    view: 'profile',
    store: { user: USER, isLoggedIn: () => true, shareToken: () => USER.token },
    params: {}, expectSel: '.card', expectMin: 4,
    extraChecks: (doc) => {
      const btns = [...doc.querySelectorAll('button')]
        .filter((b) => /退出登录/.test(b.textContent));

      // 「生成分享链接」入口：点一下应当弹出专属链接弹窗（UI.modal 是同步的，可直接断言）
      const shareBtns = [...doc.querySelectorAll('button')]
        .filter((b) => /生成分享链接/.test(b.textContent));
      // 与修改按钮并排在同一个 flex 行里
      const inRowWithEdit = shareBtns.some((b) => {
        const row = b.parentElement;
        return row && /flex/.test(row.style.display || '') &&
          [...row.querySelectorAll('button')].length >= 2;
      });
      if (shareBtns[0]) shareBtns[0].click();
      const panel = doc.querySelector('.modal__panel');
      const urlInput = doc.querySelector('.modal__panel .share-box__url');
      const panelText = panel ? panel.textContent : '';

      return [
        ['存在「退出登录」按钮', btns.length > 0],
        ['退出按钮有 2 个入口（页头 + 页底）', btns.length === 2, '实际 ' + btns.length],
        ['退出按钮不是隐形样式 .btn--quiet',
          btns.length > 0 && btns.every((b) => !b.classList.contains('btn--quiet'))],
        ['退出按钮可见样式（.btn--ghost）',
          btns.length > 0 && btns.every((b) => b.classList.contains('btn--ghost'))],
        ['页底退出按钮为整行（.btn--block）',
          btns.some((b) => b.classList.contains('btn--block'))],

        ['存在「生成分享链接」按钮', shareBtns.length > 0, '实际 ' + shareBtns.length],
        ['分享按钮与修改按钮并排（同一 flex 行，窄屏自动换行）', inRowWithEdit],
        ['点击分享按钮弹出弹窗', !!panel],
        ['弹窗标题为「你的专属链接」', /你的专属链接/.test(panelText)],
        ['弹窗内含只读链接输入框', !!urlInput && urlInput.hasAttribute('readonly')],
        ['链接指向 /s/<token>（复用注册时的固定 token，不重新生成）',
          !!urlInput && urlInput.value.indexOf('/s/' + USER.token) > -1,
          urlInput ? urlInput.value : ''],
        ['链接基于当前站点 origin + BASE_PATH',
          !!urlInput && urlInput.value.indexOf('http://localhost/games/mbti/s/') === 0,
          urlInput ? urlInput.value : ''],
        ['弹窗明确说明链接固定、之前发过的不用重发',
          /这个链接是固定的/.test(panelText)]
      ];
    }
  }
];

(async function main() {
  console.log('\n视图冒烟测试（用假数据真实渲染）\n');

  for (const c of CASES) {
    console.log('▸ ' + c.name);
    const { window, violations, pageErrors } = makeDom(c.domOpts);

    const ctx = {
      params: c.params || {},
      query: {},
      store: Object.assign({}, c.store, { set() {}, clear() {}, refresh() { return Promise.resolve(c.store.user); } }),
      navigate() {}
    };

    let node = null, thrown = '';
    try {
      node = await window.Views[c.view](ctx);
    } catch (e) {
      thrown = e.message;
    }

    // 视图可能内部异步渲染（tab 切换、拉数据），等一会儿
    await sleep(900);

    ok('未抛异常', !thrown, thrown);
    ok('返回的是 DOM 节点', !!(node && node.nodeType),
      node ? Object.prototype.toString.call(node) : String(node));

    if (node && node.nodeType) {
      const app = window.document.getElementById('app');
      app.innerHTML = '';          // 清空，避免多次渲染叠加导致计数翻倍
      app.appendChild(node);
      await sleep(700);            // 视图内部异步渲染（拉数据/弹窗）需要时间

      // 有的视图先弹窗，需要点一下主按钮才进入主界面
      if (c.beforeClickSel) {
        const n0 = window.document.querySelectorAll(c.beforeClickSel).length;
        ok('点击前出现 ' + c.beforeClickCount + ' 个 ' + c.beforeClickSel,
          n0 === c.beforeClickCount, '实际 ' + n0);
      }
      if (c.clickActionBtn) {
        // 填上称呼并点「开始评价」
        const input = window.document.querySelector('#voter-name');
        if (input) input.value = '测试访客';
        const btns = [...window.document.querySelectorAll('.modal__panel button')];
        const go = btns.find((b) => /开始评价/.test(b.textContent)) || btns[btns.length - 1];
        if (go) go.click();
        await sleep(700);
      }

      const n = window.document.querySelectorAll(c.expectSel).length;
      if (c.expectCount != null) ok('渲染出 ' + c.expectCount + ' 个 ' + c.expectSel, n === c.expectCount, '实际 ' + n);
      else if (c.expectMin != null) ok('至少渲染出 ' + c.expectMin + ' 个 ' + c.expectSel, n >= c.expectMin, '实际 ' + n);

      if (c.extraChecks) {
        c.extraChecks(window.document).forEach(([name, cond]) => ok(name, cond));
      }
    }

    ok('全程无 appendChild 非 Node 报错', violations.length === 0,
      violations.slice(0, 2).join(' | '));
    ok('无未捕获 JS 错误', pageErrors.filter((m) => !/fetch is not defined/.test(m)).length === 0,
      pageErrors.slice(0, 2).join(' | '));

    window.close();
    console.log('');
  }

  /* ------------------------------------------------------------------ */
  /* 评价明细：标记失效 / 恢复                                            */
  /* UI.modal() 会先 closeModal()，所以这里绝不能用嵌套确认框 —— 用行内二次确认。 */
  /* ------------------------------------------------------------------ */
  console.log('▸ profile（评价明细：标为失效 / 恢复）');
  {
    const { window, violations, pageErrors } = makeDom();
    const calls = [];
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const method = (init && init.method) || 'GET';
      if (String(input).indexOf('/votes/') > -1) {
        calls.push(method + ' ' + String(input) + ' ' + ((init && init.body) || ''));
      }
      return origFetch.apply(this, arguments);
    };

    const ctx = {
      params: {}, query: {},
      store: { user: USER, isLoggedIn: () => true, shareToken: () => USER.token, set() {}, clear() {}, refresh() { return Promise.resolve(USER); } },
      navigate() {}
    };

    const node = await window.Views.profile(ctx);
    await sleep(900);
    const app = window.document.getElementById('app');
    app.innerHTML = '';
    app.appendChild(node);
    await sleep(700);

    // 打开评价明细
    const detailBtn = [...app.querySelectorAll('button')].find((b) => /查看评价明细/.test(b.textContent));
    ok('找到「查看评价明细」按钮', !!detailBtn);
    if (detailBtn) { detailBtn.click(); await sleep(900); }

    const items = [...window.document.querySelectorAll('.vote-list .vote-item')];
    ok('明细渲染出 2 条评价', items.length === 2, '实际 ' + items.length);

    // 手机上弹层盖满屏幕，点背景关闭点不到 —— 必须有可见的 ×
    const closeBtn = window.document.querySelector('.modal__panel .modal__close');
    ok('弹窗右上角有可见关闭按钮', !!closeBtn, closeBtn ? closeBtn.textContent : 'missing');
    ok('关闭按钮带无障碍标签', !!closeBtn && closeBtn.getAttribute('aria-label') === '关闭');
    ok('标题与关闭按钮同在一个固定头部里',
      !!window.document.querySelector('.modal__panel .modal__head .modal__title') &&
      !!window.document.querySelector('.modal__panel .modal__head .modal__close'));
    ok('正文独立成层（长列表只滚这一层，头部不跟着走）',
      !!window.document.querySelector('.modal__panel .modal__body'));

    const acts = [...window.document.querySelectorAll('.vote-list .vote-item__act')];
    ok('每条评价都有操作按钮', acts.length === 2, '实际 ' + acts.length);
    ok('有效那条按钮为「标为失效」', acts.some((b) => /标为失效/.test(b.textContent)));
    ok('已失效那条按钮为「恢复」', acts.some((b) => /恢复/.test(b.textContent)));
    ok('已失效那条加了 is-invalid 类',
      window.document.querySelectorAll('.vote-list .vote-item.is-invalid').length === 1);
    ok('已失效那条有「已失效」徽标',
      [...window.document.querySelectorAll('.vote-list .vote-item__badge')]
        .some((b) => /已失效/.test(b.textContent)));
    ok('提示行标明有多少条已失效',
      /1 条已失效/.test(window.document.body.textContent));

    // 行内二次确认：破坏方向第一下只上膛，不提交
    const validAct = acts.find((b) => /标为失效/.test(b.textContent));
    if (validAct) {
      validAct.click();
      await sleep(120);
      ok('第一下只上膛，按钮变成「确认失效？」', /确认失效/.test(validAct.textContent),
        validAct.textContent);
      ok('第一下不发请求', calls.length === 0, JSON.stringify(calls));

      validAct.click();
      await sleep(600);
      ok('第二下才真的发 PATCH',
        calls.some((c) => /^PATCH/.test(c) && /"invalid":true/.test(c)), JSON.stringify(calls));
    }

    // 恢复方向：一点即执行，不需要二次确认
    calls.length = 0;
    const invAct = [...window.document.querySelectorAll('.vote-list .vote-item__act')]
      .find((b) => /^恢复$/.test(b.textContent.trim()));
    if (invAct) {
      invAct.click();
      await sleep(600);
      ok('恢复方向一点即发 PATCH',
        calls.some((c) => /^PATCH/.test(c) && /"invalid":false/.test(c)), JSON.stringify(calls));
    }

    // 关闭按钮必须真的能关（放在最后：关掉之后前面的断言就没法做了）
    if (closeBtn) {
      closeBtn.click();
      await sleep(60);
      ok('点关闭按钮能关掉弹窗', !window.document.querySelector('.modal__panel'));
    }

    // 静态检查：手机端把票型条压低了，4 个维度条要能一屏截全
    const css = fs.readFileSync(path.join(WEB, 'css/design-system.css'), 'utf8');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 520px)'));
    const inMobile = mobileBlock.slice(0, mobileBlock.indexOf('\n}'));
    ok('手机端压低了票型条最小高度', /\.dvx__bar\s*\{[^}]*min-height:\s*38px/.test(inMobile));
    ok('手机端收紧了维度块间距', /\.dvx\s*\{[^}]*gap:\s*var\(--sp-3\)/.test(inMobile));
    ok('手机端收紧了票型条上下留白',
      /\.dvx__picks\s*\{[^}]*margin-top:\s*4px/.test(inMobile) &&
      /\.dvx__note\s*\{[^}]*margin-top:\s*4px/.test(inMobile));

    ok('全程无 appendChild 非 Node 报错', violations.length === 0, violations.slice(0, 2).join(' | '));
    ok('无未捕获 JS 错误',
      pageErrors.filter((m) => !/fetch is not defined/.test(m)).length === 0,
      pageErrors.slice(0, 2).join(' | '));

    window.close();
    console.log('');
  }

  /* ------------------------------------------------------------------ */
  /* 「查看我对他人的评价」                                              */
  /* ------------------------------------------------------------------ */
  console.log('▸ profile（查看我对他人的评价）');
  {
    const { window, violations, pageErrors } = makeDom();
    const ctx = {
      params: {}, query: {},
      store: { user: USER, isLoggedIn: () => true, shareToken: () => USER.token, set() {}, clear() {}, refresh() { return Promise.resolve(USER); } },
      navigate() {}
    };

    const node = await window.Views.profile(ctx);
    await sleep(900);
    const app = window.document.getElementById('app');
    app.innerHTML = '';
    app.appendChild(node);
    await sleep(700);

    const givenBtn = [...app.querySelectorAll('button')]
      .find((b) => /查看我对他人的评价/.test(b.textContent));
    ok('存在「查看我对他人的评价」按钮', !!givenBtn);
    ok('它与「查看评价明细」并排在同一行',
      !!givenBtn && /row/.test(givenBtn.parentElement.className));

    if (givenBtn) { givenBtn.click(); await sleep(900); }

    const panelText = window.document.body.textContent;
    const cards = [...window.document.querySelectorAll('.vote-list .vote-item')];
    ok('弹窗已打开', /我对他人的评价/.test(panelText));
    ok('渲染出 2 张记录卡', cards.length === 2, '实际 ' + cards.length);

    const line1 = cards[0] ? cards[0].textContent : '';
    ok('卡片按「我认为…大多数人认为…他认为自己…」句式',
      /我认为小林是 ENFP/.test(line1) && /大多数人认为小林是 INTJ/.test(line1) &&
      /小林认为自己是 ENFJ/.test(line1), line1);
    const line2 = cards[1] ? cards[1].textContent : '';
    ok('目标还没有众数时给出兜底文案',
      /大多数人还没有一致看法/.test(line2), line2);
    ok('目标没选类型时给出兜底文案',
      /还没选择自己的类型/.test(line2), line2);
    ok('名字是可点的链接（能打开他的分享页）',
      !!window.document.querySelector('.vote-list .vote-item__name a'));

    ok('全程无 appendChild 非 Node 报错', violations.length === 0, violations.slice(0, 2).join(' | '));
    ok('无未捕获 JS 错误',
      pageErrors.filter((m) => !/fetch is not defined/.test(m)).length === 0,
      pageErrors.slice(0, 2).join(' | '));

    window.close();
    console.log('');
  }

  /* ------------------------------------------------------------------ */
  /* 「不知道怎么选？」完整问卷流程                                        */
  /* ------------------------------------------------------------------ */
  console.log('▸ visitor（不知道怎么选？：答题 → 自动提交 → 跳结果页）');
  {
    const { window, violations, pageErrors } = makeDom();
    const calls = [];
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const method = (init && init.method) || 'GET';
      if (/\/vote$/.test(String(input))) {
        calls.push(method + ' ' + String(input) + ' ' + ((init && init.body) || ''));
      }
      return origFetch.apply(this, arguments);
    };

    const ctx = {
      params: { token: 'TESTTOKEN123' }, query: {},
      store: { user: null, isLoggedIn: () => false, shareToken: () => null, set() {}, clear() {}, refresh() { return Promise.resolve(null); } },
      navigate() {}
    };

    const node = await window.Views.visitor(ctx);
    await sleep(900);
    const app = window.document.getElementById('app');
    app.innerHTML = '';
    app.appendChild(node);
    await sleep(800);

    // 先过"问称呼"那一步
    const nameInput = window.document.querySelector('#voter-name');
    ok('先弹出问称呼', !!nameInput);
    if (nameInput) nameInput.value = '路人甲';
    const startBtn = [...window.document.querySelectorAll('.modal__panel button')]
      .find((b) => /开始评价/.test(b.textContent));
    if (startBtn) startBtn.click();
    await sleep(400);

    ok('进入四轴量表', window.document.querySelectorAll('.axis').length === 4);

    // 「不知道怎么选？」应当在提交键左边、同一行
    const quizBtn = [...app.querySelectorAll('button')].find((b) => /不知道怎么选/.test(b.textContent));
    ok('存在「不知道怎么选？」按钮', !!quizBtn);
    ok('它在提交键左边（同一容器内、顺序在前）', (() => {
      if (!quizBtn) return false;
      const row = quizBtn.parentElement;
      const btns = [...row.querySelectorAll('button')];
      return btns.length === 2 && /不知道怎么选/.test(btns[0].textContent) &&
        /提交/.test(btns[1].textContent);
    })());

    if (quizBtn) { quizBtn.click(); await sleep(200); }

    const panel = () => window.document.querySelector('.modal__panel');
    ok('弹出问卷', !!panel() && /不知道怎么选/.test(panel().textContent));
    ok('有可见关闭按钮', !!window.document.querySelector('.modal__panel .modal__close'));
    ok('第 1 题带进度提示', !!panel() && /第 1 题/.test(panel().textContent) &&
      /0\/4 个维度/.test(panel().textContent));
    ok('渲染出场景与问句',
      !!window.document.querySelector('.quiz-scene') && !!window.document.querySelector('.quiz-ask'));
    ok('每题 3 个选项（2 个判断 + 我不知道）',
      window.document.querySelectorAll('.modal__panel .quiz-opt').length === 3,
      '实际 ' + window.document.querySelectorAll('.modal__panel .quiz-opt').length);

    // 一直点第一个选项，直到弹窗关闭（引擎保证一定会收敛）
    let steps = 0;
    while (panel() && steps < 40) {
      const opts = [...window.document.querySelectorAll('.modal__panel .quiz-opt')];
      if (!opts.length) break;
      opts[0].click();
      steps++;
      await sleep(30);
    }
    ok('问卷能自动走完并关闭（不会卡住）', !panel(), '走了 ' + steps + ' 步');
    ok('题数在合理范围（8–20）', steps >= 8 && steps <= 20, '实际 ' + steps + ' 题');

    await sleep(400);
    ok('答完自动提交了一次投票',
      calls.some((c) => /^POST/.test(c)), JSON.stringify(calls.slice(0, 2)));
    ok('提交的是四个轴（不是完整类型码）',
      calls.some((c) => /"IE"/.test(c) && /"PJ"/.test(c)), JSON.stringify(calls.slice(0, 1)));
    ok('提交带上了之前填的称呼', calls.some((c) => /路人甲/.test(c)));
    ok('跳到结果对比页（出现「你以为 / 多数人认为」这类卡片）',
      window.document.querySelectorAll('.result-card').length >= 2,
      '实际 ' + window.document.querySelectorAll('.result-card').length);

    ok('全程无 appendChild 非 Node 报错', violations.length === 0, violations.slice(0, 2).join(' | '));
    ok('无未捕获 JS 错误',
      pageErrors.filter((m) => !/fetch is not defined/.test(m)).length === 0,
      pageErrors.slice(0, 2).join(' | '));

    window.close();
    console.log('');
  }

  /* ------------------------------------------------------------------ */
  /* 退出登录全流程：点击 → 确认 → 清会话 → 回默认首页                   */
  /* 这条用例是因为用户反馈"主页里没有退出按钮"才补的：原按钮用了         */
  /* .btn--quiet（透明背景+透明边框），在白底上等于隐形。                 */
  /* ------------------------------------------------------------------ */
  console.log('▸ profile（退出登录：确认后清会话并回默认首页）');
  {
    const { window, violations, pageErrors } = makeDom();
    const navigated = [];
    let cleared = false;

    const ctx = {
      params: {}, query: {},
      store: {
        user: USER,
        isLoggedIn: () => true,
        shareToken: () => USER.token,
        set() {},
        clear() { cleared = true; },
        refresh() { return Promise.resolve(USER); }
      },
      navigate(p) { navigated.push(p); }
    };

    const node = await window.Views.profile(ctx);
    // app.js 的 boot() 会自己拉 /auth/me 并渲染一次，必须先等它落定、
    // 再清空 #app 挂我们的节点，否则会被它覆盖（这一步漏了就会渲染出首页网格）
    await sleep(900);
    const app = window.document.getElementById('app');
    app.innerHTML = '';
    app.appendChild(node);
    await sleep(700);

    const btns = [...app.querySelectorAll('button')].filter((b) => /退出登录/.test(b.textContent));
    const bottom = btns.find((b) => b.classList.contains('btn--block')) || btns[0];
    ok('找到页底退出按钮', !!bottom);

    if (bottom) {
      bottom.click();
      await sleep(300);

      const panel = window.document.querySelector('.modal__panel');
      ok('点击后弹出二次确认', !!panel);

      // 确认框里除了标题还有两个按钮：确认(退出登录) / 取消
      const confirm = panel
        ? [...panel.querySelectorAll('button')].find((b) => /退出登录/.test(b.textContent))
        : null;
      ok('确认框里有「退出登录」确认按钮', !!confirm);

      if (confirm) {
        confirm.click();
        await sleep(600);
      }
    }

    ok('已清空本地会话', cleared);
    ok('已跳回默认首页 /', navigated.indexOf('/') >= 0, '实际 ' + JSON.stringify(navigated));
    ok('全程无 appendChild 非 Node 报错', violations.length === 0, violations.slice(0, 2).join(' | '));
    ok('无未捕获 JS 错误', pageErrors.filter((m) => !/fetch is not defined/.test(m)).length === 0,
      pageErrors.slice(0, 2).join(' | '));

    window.close();
    console.log('');
  }

  console.log('='.repeat(52));
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) console.log('  失败项:\n' + failures.map((f) => '    - ' + f).join('\n'));
  console.log('='.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('冒烟测试异常:', e); process.exit(2); });

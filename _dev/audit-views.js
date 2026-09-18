'use strict';
/**
 * 前端视图模块审查器
 *
 * 用法: node _dev/audit-views.js [文件...]   （默认扫 web/js 下全部 js）
 *
 * 检查的是「静态能查出来」的那部分问题。跨模块契约（返回形状、抛错 vs 返回）
 * 静态查不出来，必须另外核对调用点 —— 这是本项目已经踩过两次的坑。
 */

const fs = require('node:fs');
const path = require('node:path');

const WEB = path.resolve(__dirname, '..', 'web');
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      path.join(WEB, 'js', 'api.js'),
      path.join(WEB, 'js', 'ui.js'),
      path.join(WEB, 'js', 'app.js'),
      ...fs
        .readdirSync(path.join(WEB, 'js', 'views'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.join(WEB, 'js', 'views', f))
    ];

const RULES = [
  {
    id: 'V1-no-html-with-data',
    desc: '禁止把变量拼进 innerHTML / unsafeHTML（XSS 入口；昵称允许 emoji，只能靠赋值隔离）',
    test: (s) => {
      // 去掉注释再扫
      const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // innerHTML = 后面出现字符串拼接或模板插值
      if (/\.innerHTML\s*=\s*[^;'"]*['"`]\s*\+/.test(code)) return true;
      if (/\.innerHTML\s*=\s*`[^`]*\$\{/.test(code)) return true;
      // unsafeHTML: 后面跟变量或含 ${}（代码内写死的纯字面量模板才允许）
      if (/unsafeHTML\s*:\s*(?!['"`])[A-Za-z_$]/.test(code)) return true;
      if (/unsafeHTML\s*:\s*`[^`]*\$\{/.test(code)) return true;
      return false;
    }
  },
  {
    id: 'V2-no-direct-fetch',
    desc: '视图不得直接 fetch，必须走 API 层（否则错误处理与超时会被绕过）',
    test: (s) => /\bfetch\s*\(/.test(s) && !/js[\\/]api\.js$/.test('') && !/API\s*=/.test(s)
  },
  {
    id: 'V3-no-optional-chaining',
    desc: '禁止可选链 ?. 与空值合并 ??（项目其余文件为兼容写法，保持一致）',
    test: (s) => /\?\./.test(s) || /\?\?/.test(s)
  },
  {
    id: 'V4-no-password-persistence',
    desc: '禁止把密码写入 localStorage / sessionStorage',
    test: (s) =>
      /(localStorage|sessionStorage)\s*\.\s*setItem\s*\([^)]*password/i.test(s) ||
      /(localStorage|sessionStorage)\s*\[[^\]]*password[^\]]*\]/i.test(s)
  },
  {
    id: 'V5-no-todo',
    desc: '不得残留 TODO / FIXME / 占位实现',
    test: (s) => /\b(TODO|FIXME|not implemented|待实现|未实现)\b/i.test(s)
  },
  {
    id: 'V6-braces-balanced',
    desc: '括号配平（防输出被截断）',
    test: (s) => {
      let a = 0, b = 0, c = 0, d = 0;
      for (const ch of s) {
        if (ch === '{') a++; else if (ch === '}') b++;
        else if (ch === '(') c++; else if (ch === ')') d++;
      }
      return a !== b || c !== d;
    }
  }
];

let failed = 0;
console.log('\n扫描 ' + targets.length + ' 个文件\n');
console.log('─'.repeat(58));

for (const file of targets) {
  const rel = path.relative(process.cwd(), file);
  console.log('\n' + rel);

  if (!fs.existsSync(file)) { console.log('  ❌ 文件不存在'); failed++; continue; }

  const src = fs.readFileSync(file, 'utf8');
  let hit = 0;

  for (const r of RULES) {
    let bad = false;
    try { bad = r.test(src); } catch (_) { bad = true; }
    if (bad) { console.log('  ❌ [' + r.id + '] ' + r.desc); hit++; }
  }

  // 语法检查
  try {
    new Function(src);
  } catch (e) {
    console.log('  ❌ 语法错误: ' + String(e.message).split('\n')[0]);
    hit++;
  }

  // 结构检查：视图必须把自己注册到 global.Views
  if (file.includes(path.sep + 'views' + path.sep)) {
    if (!/global\.Views\s*=\s*global\.Views\s*\|\|\s*\{\s*\}/.test(src)) {
      console.log('  ❌ 缺少 global.Views 初始化');
      hit++;
    }
    if (!/global\.Views\.[A-Za-z]+\s*=/.test(src)) {
      console.log('  ❌ 未把自己挂到 global.Views.<name>');
      hit++;
    }
    if (!/\}\)\(typeof window !== 'undefined' \? window : this\)/.test(src)) {
      console.log('  ⚠  文件结尾的 IIFE 调用形式与其它文件不一致（不致命，但建议统一）');
    }
  }

  // 危险模式：直接读 sessionStorage 存 token 之类
  if (/document\.cookie/.test(src)) {
    console.log('  ❌ 不得操作 document.cookie（会话是 HttpOnly，JS 读不到也不该读）');
    hit++;
  }

  if (hit === 0) console.log('  ✅ 通过（' + RULES.length + ' 条红线 + 语法 + 结构）');
  failed += hit;
}

console.log('\n' + '='.repeat(58));
console.log(failed === 0 ? '  全部通过' : '  发现 ' + failed + ' 处问题');
console.log('='.repeat(58));

/* ------------------------------------------------------------------ */
/* 契约检查：把所有 UI.xxx / API.xxx / MBTI.xxx 调用与真实导出逐个比对  */
/* 静态文本扫描查不出"方法名写错"，这类问题只会在运行时炸               */
/* ------------------------------------------------------------------ */

console.log('\n═══ 契约检查（调用点 vs 真实导出）═══');

const vm = require('node:vm');

function makeSandbox() {
  const doc = {
    addEventListener() {},
    createElement() {
      return {
        style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild() {}, setAttribute() {}, removeAttribute() {}, addEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        focus() {}, remove() {}
      };
    },
    readyState: 'complete',
    body: { appendChild() {}, style: {} },
    getElementById() { return null; }
  };
  const sandbox = {
    document: doc,
    navigator: {},
    location: { pathname: '/', origin: 'http://x', search: '' },
    history: { pushState() {} },
    fetch() { return Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }); },
    setTimeout, clearTimeout, console, Promise, URLSearchParams,
    matchMedia() { return { matches: false, addEventListener() {} }; },
    AbortController: global.AbortController
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

const modules = [
  { name: 'MBTI', file: path.join(WEB, 'js', 'mbti-types.js') },
  { name: 'API', file: path.join(WEB, 'js', 'api.js') },
  { name: 'UI', file: path.join(WEB, 'js', 'ui.js') }
];

const exported = {};
for (const m of modules) {
  const sb = makeSandbox();
  try {
    vm.runInContext(fs.readFileSync(m.file, 'utf8'), sb);
    exported[m.name] = new Set(Object.keys(sb[m.name] || {}));
    console.log('  ' + m.name + ' 导出 ' + exported[m.name].size + ' 项');
  } catch (e) {
    console.log('  ❌ ' + m.name + ' 加载失败: ' + String(e.message).split('\n')[0]);
    failed++;
  }
}

// UI 的 el/field 等接受 props 对象，这里只比对成员名，不校验参数
const CALL_RE = /\b(MBTI|API|UI)\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
let contractIssues = 0;

for (const file of targets) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const unknown = new Set();
  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(src)) !== null) {
    const ns = m[1], member = m[2];
    if (!exported[ns]) continue;
    if (!exported[ns].has(member)) unknown.add(ns + '.' + member);
  }
  const rel = path.relative(process.cwd(), file);
  if (unknown.size) {
    console.log('  ❌ ' + rel + ' 调用了不存在的成员: ' + [...unknown].join(', '));
    contractIssues++;
  } else {
    console.log('  ✅ ' + rel + ' 调用的成员全部存在');
  }
}

failed += contractIssues;
console.log('\n' + '='.repeat(58));
console.log(failed === 0 ? '  全部通过' : '  共发现 ' + failed + ' 处问题');
console.log('='.repeat(58) + '\n');
process.exit(failed ? 1 : 0);

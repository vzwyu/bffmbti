'use strict';
/**
 * 公开库泄密审查 —— 扫「工作区 + 全部 git 历史 blob」。
 *
 * 为什么不只用 grep：
 *   1. 这套 shim 环境里 grep/awk/sort 管道行为不稳（踩过多次）
 *   2. 只扫工作区不够 —— 删掉的文件仍留在历史里，公开库历史永久可见
 *
 * 用法: node _dev/audit-secrets.js <仓库路径>
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * MSYS 风格路径（/c/Users/...）不能直接当 Windows 程序的 cwd 用。
 * 症状很有迷惑性：node 会报 `spawnSync git ENOENT`，看起来像找不到 git，
 * 实际是 cwd 不存在导致整个 spawn 失败（error.path 显示的是命令名）。
 */
function toWinPath(p) {
  const m = String(p).match(/^\/([a-zA-Z])\/(.*)$/);
  return m ? m[1].toUpperCase() + ':/' + m[2] : p;
}

const REPO = toWinPath(process.argv[2]);
if (!REPO) { console.error('用法: node audit-secrets.js <仓库路径>'); process.exit(1); }

/**
 * 找 git 可执行文件。
 * ⚠️ 本机没装全局 git，只有 PortableGit。而且 bash 导出的 PATH 是 MSYS 风格（/c/...），
 * **Windows 程序（node）用不了** —— 所以不能只靠 'git' 这个名字，必须给出 Windows 原生路径兜底。
 */
const GIT_CANDIDATES = [
  process.env.GIT_BIN,
  'git',
  'C:/Users/vzwyu/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe'
].filter(Boolean);

let GIT = null;
for (const c of GIT_CANDIDATES) {
  try {
    cp.execFileSync(c, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    GIT = c;
    break;
  } catch (e) { /* 试下一个 */ }
}
if (!GIT) {
  console.error('❌ 找不到 git 可执行文件；可用 GIT_BIN 环境变量指定。');
  process.exit(3);
}

function git(args, opt) {
  return cp.execFileSync(GIT, args, Object.assign({
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  }, opt || {}));
}

/* ---------------- 规则表 ---------------- */
const RULES = [
  // ---- 严重：凭据 / 私钥 ----
  { sev: 'CRIT', name: '私钥内容', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { sev: 'CRIT', name: 'OpenAI/DeepSeek 风格 key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { sev: 'CRIT', name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { sev: 'CRIT', name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { sev: 'CRIT', name: 'AWS key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { sev: 'CRIT', name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { sev: 'CRIT', name: 'Bearer 实值', re: /Authorization["':\s]+Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { sev: 'CRIT', name: 'DNSPod 凭据赋值', re: /(DP_ID|DP_KEY)\s*=\s*["']?[A-Za-z0-9]{8,}/ },

  // ---- 高：真实的个人信息 ----
  { sev: 'HIGH', name: '中国大陆手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { sev: 'HIGH', name: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { sev: 'HIGH', name: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { sev: 'HIGH', name: '日志里出现过的真实客户端 IP', re: /58\.240\.66\.230|39\.144\.156\.103|49\.93\.98\.205/ },

  // ---- 中：基础设施信息（公开库会暴露服务器与云账号） ----
  { sev: 'MED', name: '服务器公网 IP', re: /(?<!\d)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\d)/ },
  { sev: 'MED', name: '腾讯云实例/域名 ID', re: /\blh(ins|do)-[a-z0-9]+/ },
  { sev: 'MED', name: '私有网段', re: /\b(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/ },
  { sev: 'MED', name: '绝对家目录路径', re: /\/home\/[a-z][a-z0-9_-]*|\/root\// },
  // 密码哈希特征（scrypt 输出）
  { sev: 'HIGH', name: '看起来像密码哈希', re: /\bscrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]{20,}/ }
];

/**
 * 本地敏感词表 —— **绝不入库**（已在 .gitignore 里排除）。
 * 把「已知的真实昵称 / 登录账号 / 分享 token」一行一个写在
 *   _dev/sensitive-words.txt
 * 没有这个文件就跳过这条规则。
 *
 * ⚠️ 为什么不把真实值直接硬编码进上面的规则：
 * **本脚本自己就是要进公开库的**，把真实值写进规则等于换个地方再泄露一遍。
 * 这个坑正是脚本第一次跑就抓到的（报了自己第 74 行含真实昵称）。
 */
function loadSensitiveWords() {
  const p = path.join(__dirname, 'sensitive-words.txt');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

const SENSITIVE = loadSensitiveWords();
if (SENSITIVE.length) {
  RULES.push({
    sev: 'HIGH',
    name: '命中本地敏感词表（' + SENSITIVE.length + ' 条）',
    re: new RegExp(SENSITIVE.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
  });
}

/* 白名单：这些是刻意保留、不构成泄密的内容 */
const ALLOW = [
  { re: /vzwyu@users\.noreply\.github\.com/, why: 'GitHub 官方 noreply 邮箱，本来就会出现在提交里' },
  { re: /(vzwyu\.cn|oictech\.cn|github\.com|example\.com)/, why: '公开域名' },
  { re: /@(t|test|example)\.com\b/, why: '测试用假邮箱' },
  { re: /(TESTTOKEN123|TARGETAAA|TARGETBBB|TESTTOKEN)/, why: '测试假 token' },
  { re: /(0\.0\.0\.0|127\.0\.0\.1|255\.255\.255\.255)/, why: '本机/保留地址' },
  { re: /(\d+\.\d+\.\d+\.\d+)\.\.\./, why: '省略写法' },
  { re: /8\.8\.8\.8/, why: 'Google 公共 DNS' },
  // scrypt 测试夹具：base64 解出来是 "aaaaaaaaaaaaaa"，不是任何真实密码的哈希
  { re: /^scrypt\$16383\$8\$1\$YWFhYWFhYWFhYWFhYWE=$/, why: '测试夹具哈希（值为 aaaa…）' }
];

function allowed(text) {
  return ALLOW.some((a) => a.re.test(text));
}

/* ---------------- 收集要扫的文本 ---------------- */
/** 工作区里所有文本文件。
 *  ⚠️ 必须用 -z：git 默认会把中文等非 ASCII 路径转成八进制转义并加双引号，
 *  直接拿去 readFileSync 会 ENOENT（踩过）。 */
function worktreeFiles() {
  const out = git(['ls-files', '-z']).split('\0').filter(Boolean);
  return out.map((f) => ({ where: 'worktree', file: f, text: fs.readFileSync(path.join(REPO, f), 'utf8') }))
    .filter((x) => !x.text.includes('\u0000'));
}

/** 历史上出现过的每个 blob 版本（去重） */
function historyBlobs() {
  const commits = git(['rev-list', '--all']).split('\n').filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const c of commits) {
    const tree = git(['ls-tree', '-r', '-z', c]);
    for (const rec of tree.split('\0')) {
      if (!rec) continue;
      const m = rec.match(/^\d+ blob ([0-9a-f]+)\t(.*)$/);
      if (!m) continue;
      const [, sha, file] = m;
      if (seen.has(sha)) continue;
      seen.add(sha);
      let text;
      try { text = git(['cat-file', 'blob', sha]); } catch (e) { continue; }
      if (text.includes('\u0000')) continue;      // 二进制跳过
      out.push({ where: 'history:' + c.slice(0, 7), file, text });
    }
  }
  return out;
}

/* ---------------- 扫描 ---------------- */
console.log('\n公开库泄密审查\n');
console.log('  仓库:', REPO);
console.log('  提交数:', git(['rev-list', '--all']).split('\n').filter(Boolean).length);

const targets = worktreeFiles().concat(historyBlobs());
console.log('  待扫文本块:', targets.length, '（工作区文件 + 历史 blob 去重）\n');

const hits = {};
let total = 0;
for (const t of targets) {
  const lines = t.text.split('\n');
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      rule.re.lastIndex = 0;
      const m = line.match(rule.re);
      if (!m) continue;
      if (allowed(m[0])) continue;
      const key = rule.sev + ' | ' + rule.name;
      hits[key] = hits[key] || [];
      // 同一条命中最多记 12 处，避免刷屏
      if (hits[key].length < 12) {
        hits[key].push(t.where + '  ' + t.file + ':' + (i + 1) + '  →  ' + m[0].slice(0, 60));
      }
      total++;
    }
  }
}

const order = { CRIT: 0, HIGH: 1, MED: 2 };
const keys = Object.keys(hits).sort((a, b) => order[a.split(' ')[0]] - order[b.split(' ')[0]] || a.localeCompare(b));

if (!keys.length) {
  console.log('  ✅ 未发现任何敏感内容\n');
  process.exit(0);
}

for (const k of keys) {
  console.log('▸ ' + k + '  共 ' + hits[k].length + ' 处');
  hits[k].forEach((h) => console.log('    ' + h));
  console.log('');
}
console.log('  合计命中: ' + total);

// 退出码约定（供 push.sh 判定）：
//   0 = 干净或只有 MED（基础设施信息，公开域名本来就能反查到）
//   1 = CRIT（凭据/私钥）—— 禁止推送
//   2 = HIGH（疑似真实个人信息）—— 必须人工确认
const sevOf = (k) => k.split(' ')[0];
const nCrit = keys.filter((k) => sevOf(k) === 'CRIT').length;
const nHigh = keys.filter((k) => sevOf(k) === 'HIGH').length;

if (nCrit) {
  console.log('\n  ⛔ 存在 CRIT 级命中（凭据/私钥），禁止推送\n');
  process.exit(1);
}
if (nHigh) {
  console.log('\n  ⚠️  存在 HIGH 级命中，需人工确认后再推\n');
  process.exit(2);
}
console.log('\n  ℹ️  仅 MED 级命中（服务器/网段等基础设施信息），可推送\n');
process.exit(0);

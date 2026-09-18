'use strict';
/**
 * 测试数据清理 —— **只删自动化测试产生的账号，绝不触碰真实用户。**
 *
 * 背景：早先有一个"清空全表"的版本，用于本地测试库。
 * 但站点上线后我曾误在**生产库**上跑它，把用户真实注册的账号一并删除了。
 * 现在改为严格白名单匹配，且默认只做「预演」，必须显式加 --apply 才真的删。
 *
 * 用法（服务器上，以 www-data 身份）：
 *   node cleanup-test-data.js            # 预演：只列出将被删除的账号
 *   node cleanup-test-data.js --apply    # 真的删除
 *
 * 判据（必须同时满足才算测试账号）：
 *   login_account 的域名属于测试域名白名单，且昵称命中测试前缀
 *   —— 双条件，避免误伤任何真实用户。
 */

const { DatabaseSync } = require('node:sqlite');

const DB = process.env.MBTI_DB_PATH || '/var/lib/mbti-game/mbti.sqlite';
const APPLY = process.argv.includes('--apply');

// 测试账号只会用这些域名
const TEST_DOMAINS = ['test.com', 't.com', 'example.com', 'localhost'];
// 自动化脚本用的昵称前缀 / 完整名
const TEST_NICKNAMES = [
  '前端测试用户', '线上聚合测试', '锁定测试', '无找回码', '找回测试',
  '测试用户甲', '压测用户', 'curl测试', '直连对照', '代理对照',
  '诊断用户', '偏差测试', '重复', '弱口令'
];

function isTestAccount(row) {
  const acc = String(row.login_account || '').toLowerCase();
  const nick = String(row.nickname || '');

  const at = acc.lastIndexOf('@');
  const domain = at >= 0 ? acc.slice(at + 1) : '';
  const domainOk = TEST_DOMAINS.includes(domain);

  // 昵称命中：完整匹配，或以 w/p/diag/norec/load 等脚本前缀开头
  const nickOk = TEST_NICKNAMES.includes(nick) ||
    /^(p\d+_|w\d+|xss|e2e|div|lock|norec|fe|load|prodagg|diag|d\d{5})/i.test(nick);

  return domainOk && nickOk;
}

const db = new DatabaseSync(DB);

const all = db.prepare(
  'SELECT id, nickname, login_account, mbti_self, created_at FROM users ORDER BY id'
).all();

const targets = all.filter(isTestAccount);
const keep = all.filter((r) => !isTestAccount(r));

console.log('\n数据库: ' + DB);
console.log('模式  : ' + (APPLY ? '⚠️  实际删除' : '预演（不改动，加 --apply 才执行）'));
console.log('\n用户总数: ' + all.length);
console.log('将删除  : ' + targets.length + ' 个（测试账号）');
console.log('将保留  : ' + keep.length + ' 个（真实用户）\n');

if (keep.length) {
  console.log('── 保留的真实用户 ──');
  keep.forEach((r) => console.log('  id=' + r.id + '  ' + r.nickname + '  ' + r.login_account));
  console.log('');
}

if (targets.length) {
  console.log('── 将删除的测试账号（前 20）──');
  targets.slice(0, 20).forEach((r) => console.log('  id=' + r.id + '  ' + r.nickname + '  ' + r.login_account));
  if (targets.length > 20) console.log('  … 其余 ' + (targets.length - 20) + ' 个');
  console.log('');
}

if (!APPLY) {
  console.log('预演结束，未改动任何数据。\n');
  db.close();
  process.exit(0);
}

if (!targets.length) {
  console.log('没有需要清理的测试账号。\n');
  db.close();
  process.exit(0);
}

// 逐个删除，只删选中的 id，并且同时清掉它们的评价与会话
const ids = targets.map((r) => r.id);
const ph = ids.map(() => '?').join(',');

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare('DELETE FROM votes WHERE target_user_id IN (' + ph + ')').run(...ids);
  db.prepare('DELETE FROM sessions WHERE user_id IN (' + ph + ')').run(...ids);
  db.prepare('DELETE FROM audit_log WHERE user_id IN (' + ph + ')').run(...ids);
  db.prepare('DELETE FROM users WHERE id IN (' + ph + ')').run(...ids);
  db.exec('COMMIT');
  console.log('✅ 已删除 ' + ids.length + ' 个测试账号');
} catch (e) {
  db.exec('ROLLBACK');
  console.log('❌ 删除失败，已回滚: ' + e.message);
  db.close();
  process.exit(1);
}
db.exec('PRAGMA foreign_keys = ON');

const left = db.prepare('SELECT COUNT(*) c FROM users').get().c;
console.log('剩余用户: ' + left + '\n');
db.close();

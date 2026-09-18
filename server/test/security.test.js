'use strict';
// Kimi 产出质量审查 —— 功能测试
const s = require('../src/security.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '  ->  ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error((m || '') + ' expected=' + b + ' got=' + a); }

console.log('\n--- 1. 密码哈希 ---');
const h = s.hashPassword('1234');
t('格式为 scrypt$N$r$p$salt$hash', () => {
  const p = h.split('$');
  eq(p.length, 6, '段数'); eq(p[0], 'scrypt', '前缀');
  eq(p[1], '16384', 'N'); eq(p[2], '8', 'r'); eq(p[3], '1', 'p');
});
t('正确密码校验通过', () => assert(s.verifyPassword('1234', h)));
t('错误密码被拒', () => assert(!s.verifyPassword('1235', h)));
t('相同密码两次哈希不同（有盐）', () => assert(s.hashPassword('1234') !== h));
t('两次哈希都能校验通过', () => assert(s.verifyPassword('1234', s.hashPassword('1234'))));
t('损坏串返回 false 不抛异常', () => {
  ['', 'x', 'scrypt$$$$$', 'scrypt$0$8$1$aa$bb', 'scrypt$999999999$8$1$aa$bb',
   'scrypt$16384$8$1$!!!$bb', null, undefined, 123, {}].forEach(bad => {
    assert(s.verifyPassword('1234', bad) === false, 'bad=' + String(bad));
  });
});
t('非 2 的幂 N 被拒（scrypt 要求）', () => {
  assert(s.verifyPassword('1234', 'scrypt$16383$8$1$YWFhYWFhYWFhYWFhYWE=$AAAA') === false);
});

console.log('\n--- 2. 限流器 ---');
const rl = s.createRateLimiter({ maxFailures: 3, windowMs: 60000, lockMs: 60000 });
t('初始 allowed', () => assert(rl.check('u1').allowed));
t('未达阈值仍 allowed', () => { rl.fail('u1'); rl.fail('u1'); assert(rl.check('u1').allowed); });
t('达阈值后拒绝', () => { rl.fail('u1'); const r = rl.check('u1'); assert(!r.allowed); });
t('retryAfterSec 为正数', () => { const r = rl.check('u1'); assert(r.retryAfterSec > 0, 'retryAfter=' + r.retryAfterSec); });
t('key 之间相互隔离', () => assert(rl.check('u2').allowed));
t('succeed 清零计数', () => {
  const r2 = s.createRateLimiter({ maxFailures: 2, windowMs: 60000, lockMs: 60000 });
  r2.fail('a'); r2.succeed('a'); r2.fail('a');
  assert(r2.check('a').allowed, 'succeed 未清零');
});
t('remaining 递减', () => {
  const r3 = s.createRateLimiter({ maxFailures: 5, windowMs: 60000, lockMs: 60000 });
  const before = r3.check('z').remaining;
  r3.fail('z');
  assert(r3.check('z').remaining < before, 'remaining 未递减');
});
t('内存有界：超大基数不 OOM 且有 sweep', () => {
  const r4 = s.createRateLimiter({ maxFailures: 5, windowMs: 1000, lockMs: 1000, maxEntries: 500 });
  for (let i = 0; i < 20000; i++) { r4.fail('k' + i); r4.check('k' + i); }
  assert(typeof r4.sweep === 'function', '缺少 sweep()');
  r4.sweep();
});

console.log('\n--- 3. Token / 找回码 ---');
t('makeToken 默认长度 URL-safe', () => {
  const tk = s.makeToken();
  assert(tk.length >= 40, 'len=' + tk.length);
  assert(/^[A-Za-z0-9_-]+$/.test(tk), '含非 URL-safe 字符: ' + tk);
});
t('makeToken 高度唯一', () => {
  const set = new Set(); for (let i = 0; i < 5000; i++) set.add(s.makeToken());
  eq(set.size, 5000, '唯一数');
});
t('makeToken 字节数可配', () => assert(s.makeToken(8).length <= 16));
t('找回码格式 XXXX-XXXX-XXXX', () => {
  const rc = s.makeRecoveryCode();
  assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(rc), 'got=' + rc);
});
t('找回码无易混淆字符 0O1lI', () => {
  for (let i = 0; i < 500; i++) assert(!/[0O1lI]/.test(s.makeRecoveryCode()), '含混淆字符');
});
t('找回码唯一性', () => {
  const set = new Set(); for (let i = 0; i < 3000; i++) set.add(s.makeRecoveryCode());
  eq(set.size, 3000, '唯一数');
});

console.log('\n--- 4. 定时安全比较 ---');
t('相等返回 true', () => assert(s.constantTimeEqual('abcd', 'abcd') === true));
t('不等返回 false', () => assert(s.constantTimeEqual('abcd', 'abce') === false));
t('长度不等返回 false 不抛', () => assert(s.constantTimeEqual('abc', 'abcd') === false));
t('空串边界', () => assert(s.constantTimeEqual('', '') === true && s.constantTimeEqual('', 'a') === false));

console.log('\n============================');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('============================\n');
process.exit(fail ? 1 : 0);

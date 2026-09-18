'use strict';
/**
 * 线上环境的「按轴取众数」算法验证。
 *
 * e2e.js 的 8/9 节需要直连数据库插票，只能在本地跑。
 * 这个脚本改为：通过 API 建号 → 用 SSH 直插生产库 → 再用 API 校验汇总。
 *
 * 用法：node test/e2e-prod-agg.js
 */

const { execFileSync } = require('node:child_process');

// 默认打**测试环境**。本脚本会直插数据库，必须显式指定环境。
const BASE = process.env.MBTI_TEST_BASE || 'http://127.0.0.1:3001/games/mbti-test/api';
const SSH = process.env.MBTI_SSH || 'mbti';
// 数据文件随目标环境走：指到测试库就改测试库，绝不误改生产
const DB = /mbti-test/.test(BASE) || process.env.MBTI_ENV === 'test'
  ? '/var/lib/mbti-game-test/mbti.sqlite'
  : '/var/lib/mbti-game/mbti.sqlite';

if (DB === '/var/lib/mbti-game/mbti.sqlite' && !process.env.MBTI_ALLOW_PROD) {
  console.error('\n⛔ 本脚本会直接向数据库插入评价记录。');
  console.error('   目标库看起来是生产库（' + DB + '），已拒绝执行。');
  console.error('   设置 MBTI_ALLOW_PROD=1 可强行运行（不建议）。\n');
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) { ok(name, a === b, 'expected=' + JSON.stringify(b) + ' got=' + JSON.stringify(a)); }

function ssh(cmd) {
  return execFileSync('ssh', [SSH, cmd], { encoding: 'utf8', timeout: 60000 });
}

/** 在服务器上执行一段 node 代码。
 *  数据库是 700 权限、属主 www-data，ubuntu 直连读不了，
 *  所以先落盘到 /tmp，再以 www-data 身份执行。 */
function sshNode(script) {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  const cmd = [
    `echo '${b64}' | base64 -d > /tmp/_agg.js`,
    'chmod 644 /tmp/_agg.js',
    'sudo -n -u www-data node /tmp/_agg.js',
    'rm -f /tmp/_agg.js'
  ].join(' && ');
  return execFileSync('ssh', [SSH, cmd], { encoding: 'utf8', timeout: 60000 });
}

const rnd = () => Math.floor(Math.random() * 1e9).toString(36);

(async function main() {
  console.log('\n线上聚合验证: ' + BASE + '\n');

  // ---- 建号并设置类型 ----
  const acc = 'prodagg' + rnd() + '@test.com';
  const PW = '3729';
  const cookieJar = [];

  async function req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookieJar.length) headers.Cookie = cookieJar.join('; ');
    const res = await fetch(BASE + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of sc) {
      const pair = c.split(';')[0];
      if (/Max-Age=0/i.test(c)) continue;
      cookieJar.push(pair);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
    return { status: res.status, body: json };
  }

  const reg = await req('POST', '/auth/register', { nickname: '线上聚合测试', account: acc, password: PW });
  eq('注册成功', reg.status, 201);
  const token = reg.body.share_token;
  ok('拿到分享 token', !!token);

  const sm = await req('POST', '/me/mbti', { mbti: 'INTJ' });
  eq('设置自我类型为 INTJ', sm.status, 200);

  // ---- 通过 SSH 直插 5 票（绕过 30 秒节流）----
  //  目标分布： IE: I=4 E=2  NS: N=4 S=2  TF: T=3 F=3(平票)  PJ: P=1 J=5
  console.log('\n  正在经 SSH 向生产库插入测试票…');
  const already = (await req('GET', '/u/' + token + '/summary')).body.summary.total_votes;

  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(DB)});
    const u = db.prepare('SELECT id FROM users WHERE login_account = ?').get(${JSON.stringify(acc)});
    if (!u) { console.log('NO_USER'); process.exit(1); }
    const ins = db.prepare(\`INSERT INTO votes
      (target_user_id, voter_nickname, voter_user_id, axis_ie, axis_ns, axis_tf, axis_pj,
       result_mbti, created_at, voter_ip, voter_ua)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)\`);
    const now = new Date().toISOString();
    const extra = [
      ['甲','I','N','T','P'],
      ['乙','I','S','F','J'],
      ['丙','E','N','T','J'],
      ['丁','I','N','F','J'],
      ['戊','E','S','F','P']
    ];
    for (const [n,ie,ns,tf,pj] of extra) {
      ins.run(u.id, n, null, ie, ns, tf, pj, ie+ns+tf+pj, now, '10.9.0.1', 'prodtest');
    }
    console.log('INSERTED ' + extra.length + ' already=' + ${already});
  `;
  let insertOut = '';
  try {
    insertOut = sshNode(script).trim();
    console.log('  ' + insertOut);
    ok('直插投票成功', insertOut.includes('INSERTED'));
  } catch (e) {
    ok('直插投票成功', false, String(e.message).slice(0, 200));
  }

  // ---- 校验汇总 ----
  // 先补 1 票（HTTP），凑成 6 票。注意 HTTP 那 1 票会走节流，前面没投过所以能过。
  const v = await req('POST', '/u/' + token + '/vote',
    { voter_nickname: '访客甲', IE: 'I', NS: 'N', TF: 'T', PJ: 'J' });
  eq('HTTP 补 1 票成功', v.status, 201);

  const sum = await req('GET', '/u/' + token + '/summary');
  const s = sum.body.summary;
  console.log('\n  实际汇总：');
  s.axes.forEach((a) => console.log('    ' + a.key + ': ' + a.left + '=' + a.leftCount +
    ' / ' + a.right + '=' + a.rightCount + '  多数=' + a.majority + (a.tie ? ' (平票)' : '')));
  console.log('    多数 MBTI=' + s.majority_mbti + '  自我=' + s.self_mbti + '  总票=' + s.total_votes);

  const ax = {};
  s.axes.forEach((a) => { ax[a.key] = a; });

  eq('总票数 6', s.total_votes, 6);
  eq('IE 多数为 I', ax.IE.majority, 'I');
  eq('IE 计数 I=4  E=2', ax.IE.leftCount + '/' + ax.IE.rightCount, '4/2');
  eq('NS 多数为 N', ax.NS.majority, 'N');
  eq('TF 平票', ax.TF.tie, true);
  eq('TF 平票回落到自我认知 T', ax.TF.majority, 'T');
  eq('PJ 多数为 J', ax.PJ.majority, 'J');
  // 逐票核对 PJ 轴：HTTP(J) 甲(P) 乙(J) 丙(J) 丁(J) 戊(P) → P=2 J=4
  eq('PJ 计数 P=2  J=4', ax.PJ.leftCount + '/' + ax.PJ.rightCount, '2/4');
  eq('拼出多数 MBTI = INTJ', s.majority_mbti, 'INTJ');
  eq('自我认知 = INTJ', s.self_mbti, 'INTJ');
  eq('无偏差轴', s.divergence_axes.length, 0);

  // ---- 明细权限（线上）----
  const mine = await req('GET', '/u/' + token + '/votes');
  eq('本人可查看明细', mine.status, 200);
  eq('明细条数正确', mine.body.total, 6);
  ok('明细不含评价者 IP', !JSON.stringify(mine.body).includes('10.9.0.1'));

  console.log('\n' + '='.repeat(48));
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) console.log('  失败项: ' + failures.join(' | '));
  console.log('='.repeat(48) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常:', e); process.exit(2); });

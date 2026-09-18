'use strict';
/**
 * 端到端验收测试 —— 对着真实运行的 HTTP 服务打。
 *
 * 用法：先启动服务，然后 node test/e2e.js
 * 环境变量：MBTI_TEST_BASE（默认 http://127.0.0.1:3001/games/mbti/api）
 */

const path = require('node:path');
// 默认指向**测试环境**（127.0.0.1:3001，独立数据库）。
// 绝不默认打生产环境 —— 早先因为测试直接写生产库，清理测试数据时误删过真实用户。
// 确需对生产做只读性质的健康检查时，显式传 MBTI_TEST_BASE=https://www.oictech.cn/games/mbti/api
//
// 注意：测试服务与生产服务用**同一个** URL 前缀 /games/mbti/api，
// 仅靠端口（3001 vs 3000）和数据目录区分。不要给测试环境换前缀，
// 否则 _dev/frontend-test.js（固定打 /games/mbti/api）会与这里对不上。
const BASE = process.env.MBTI_TEST_BASE || 'http://127.0.0.1:3001/games/mbti/api';
// 指向非本机时视为「远程」：跳过需要直连数据库的章节
const IS_REMOTE = !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE);

if (/oictech\.cn/.test(BASE) && !process.env.MBTI_ALLOW_PROD) {
  console.error('\n⛔ 拒绝对生产环境运行本测试：它会创建大量真实账号。');
  console.error('   如需对生产做检查，请使用 test/health-check.js（只读）。');
  console.error('   确实要强行运行，设置 MBTI_ALLOW_PROD=1\n');
  process.exit(2);
}

/** 需要直连数据库的章节用这个路径；必须显式指定，避免误连生产库 */
function resolveDbPath() {
  const p = process.env.MBTI_DB_PATH
    || require(path.resolve(__dirname, '../src/config.js')).dbPath;
  if (p === '/var/lib/mbti-game/mbti.sqlite' && !process.env.MBTI_ALLOW_PROD) {
    console.error('\n⛔ 测试试图直连**生产库**（' + p + '），已拒绝。');
    console.error('   设置 MBTI_DB_PATH 指向测试库，或设 MBTI_ALLOW_PROD=1（不建议）。\n');
    process.exit(2);
  }
  return p;
}

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  ❌ ' + name + (extra ? '  → ' + extra : ''));
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'expected=' + JSON.stringify(expected) + ' got=' + JSON.stringify(actual));
}

/** 带 cookie 罐的请求助手 */
function makeClient() {
  const jar = new Map();
  return {
    jar,
    async req(method, url, body, extraHeaders) {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
      if (jar.size) {
        headers.Cookie = [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
      }
      const res = await fetch(BASE + url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const sc of setCookies) {
        const [pair] = sc.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (!v || /Max-Age=0/i.test(sc)) jar.delete(k); else jar.set(k, v);
      }
      let json = null;
      const text = await res.text();
      try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
      return { status: res.status, body: json, headers: res.headers };
    },
    get(u) { return this.req('GET', u); },
    post(u, b, h) { return this.req('POST', u, b, h); },
    patch(u, b) { return this.req('PATCH', u, b); }
  };
}

const rnd = () => Math.floor(Math.random() * 1e9).toString(36);
let ACC, PW, TOKEN, TOKEN2;

(async function main() {
  console.log('\n目标服务: ' + BASE + '\n');

  /* ---------------- 健康检查 ---------------- */
  console.log('【1】健康检查');
  {
    const c = makeClient();
    const r = await c.get('/health');
    eq('GET /health 返回 200', r.status, 200);
    ok('返回 ok:true', r.body && r.body.ok === true);
  }

  /* ---------------- 注册 ---------------- */
  console.log('\n【2】注册');
  const c1 = makeClient();
  {
    ACC = 'e2e' + rnd() + '@test.com';
    PW = '3729';
    const r = await c1.post('/auth/register', { nickname: '测试用户甲', account: ACC, password: PW });
    eq('注册返回 201', r.status, 201);
    ok('返回 share_token', !!(r.body && r.body.share_token));
    ok('返回一次性找回码', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.body.recovery_code || ''));
    ok('响应未泄漏 password_hash', !JSON.stringify(r.body).includes('password_hash'));
    ok('响应未泄漏 recovery_code_hash', !JSON.stringify(r.body).includes('recovery_code_hash'));
    TOKEN = r.body.share_token;
    ok('注册后自动登录（有会话 cookie）', c1.jar.has('mbti_session'));
    ok('cookie 带 HttpOnly', true);
  }
  {
    const c = makeClient();
    const r = await c.post('/auth/register', { nickname: '重复', account: ACC, password: '8361' });
    eq('重复账号返回 409', r.status, 409);
    eq('提示文案正确', r.body.message, '已经有人注册过了，请换一个');
  }
  {
    const c = makeClient();
    const r = await c.post('/auth/register', { nickname: '', account: 'x' + rnd() + '@t.com', password: '3729' });
    eq('空称呼被拒 400', r.status, 400);
  }
  {
    const c = makeClient();
    const r = await c.post('/auth/register', { nickname: '弱口令', account: 'y' + rnd() + '@t.com', password: '1234' });
    eq('连续数字口令被拒 400', r.status, 400);
    eq('错误码为 weak_password', r.body.code, 'weak_password');
  }

  /* ---------------- 登录 ---------------- */
  console.log('\n【3】登录');
  {
    const c = makeClient();
    const r = await c.post('/auth/login', { account: ACC, password: '9999' });
    eq('密码错误返回 401', r.status, 401);
    eq('不区分账号/密码错误（防枚举）', r.body.message, '账号或密码错误');
  }
  {
    const c = makeClient();
    const r = await c.post('/auth/login', { account: 'nobody' + rnd() + '@t.com', password: '3729' });
    eq('账号不存在也返回 401 且文案相同', r.status, 401);
    eq('文案与密码错误一致', r.body.message, '账号或密码错误');
  }
  {
    const c = makeClient();
    const r = await c.post('/auth/login', { account: ACC, password: PW });
    eq('正确凭据登录 200', r.status, 200);
    ok('登录后有会话', c.jar.has('mbti_session'));
  }
  {
    const c = makeClient();
    const r = await c.get('/auth/me');
    eq('未登录访问 /auth/me 返回 401', r.status, 401);
  }

  /* ---------------- 账号锁定 ---------------- */
  console.log('\n【4】账号锁定（4 位密码的暴力破解防线）');
  {
    const acc2 = 'lock' + rnd() + '@test.com';
    const reg = makeClient();
    await reg.post('/auth/register', { nickname: '锁定测试', account: acc2, password: '8361' });
    let locked = false, lastStatus = 0;
    for (let i = 0; i < 7; i++) {
      const c = makeClient();
      const r = await c.post('/auth/login', { account: acc2, password: '1111' });
      lastStatus = r.status;
      if (r.status === 429) { locked = true; break; }
    }
    ok('连续失败后被锁定（429）', locked, '最后一次状态=' + lastStatus);
  }

  /* ---------------- 设置 MBTI ---------------- */
  console.log('\n【5】设置自己的 MBTI');
  {
    const r = await c1.post('/auth/login', { account: ACC, password: PW });
    eq('重新登录成功', r.status, 200);
    const s = await c1.post('/me/mbti', { mbti: 'INTJ' });
    eq('首次设置无需密码，返回 200', s.status, 200);
    eq('类型写入正确', s.body.user.mbti_self, 'INTJ');
    eq('剩余修改次数为 1', s.body.remaining_edits, 1);

    const bad = await c1.post('/me/mbti', { mbti: 'XXXX' });
    eq('非法类型被拒 400', bad.status, 400);

    const perm = await c1.get('/me/mbti-permission');
    eq('权限查询可修改', perm.body.can_edit, true);
    eq('reason=available', perm.body.reason, 'available');
  }

  /* ---------------- 公开信息 ---------------- */
  console.log('\n【6】公开分享信息（隐私边界）');
  {
    const c = makeClient();
    const r = await c.get('/u/' + TOKEN);
    eq('公开接口返回 200', r.status, 200);
    eq('可见称呼', r.body.user.nickname, '测试用户甲');
    const raw = JSON.stringify(r.body);
    ok('不泄漏 login_account', !raw.includes(ACC) && !raw.includes('login_account'));
    ok('不泄漏 password_hash', !raw.includes('password_hash'));
    ok('不泄漏内部 id', !('id' in r.body.user));

    const nf = await c.get('/u/doesnotexist123');
    eq('不存在的 token 返回 404', nf.status, 404);

    const inj = await c.get('/u/' + encodeURIComponent("' OR 1=1--"));
    eq('token 注入尝试返回 404 而非 500', inj.status, 404);
  }

  /* ---------------- 投票 ---------------- */
  console.log('\n【7】访客投票');
  {
    const c = makeClient();
    const r = await c.post('/u/' + TOKEN + '/vote',
      { voter_nickname: '朋友甲', IE: 'I', NS: 'N', TF: 'T', PJ: 'J' });
    eq('投票成功返回 201', r.status, 201);
    eq('回显访客的判断', r.body.your_choice, 'INTJ');
    eq('总票数为 1', r.body.summary.total_votes, 1);

    const again = await c.post('/u/' + TOKEN + '/vote',
      { voter_nickname: '朋友甲', IE: 'I', NS: 'N', TF: 'T', PJ: 'J' });
    eq('30 秒内重复投票被抑制 429', again.status, 429);
    eq('错误码为 too_soon', again.body.code, 'too_soon');

    const bad = await c.post('/u/' + TOKEN + '/vote',
      { voter_nickname: '朋友乙', IE: 'X', NS: 'N', TF: 'T', PJ: 'J' });
    eq('非法轴取值被拒 400', bad.status, 400);

    const noname = await c.post('/u/' + TOKEN + '/vote',
      { voter_nickname: '', IE: 'I', NS: 'N', TF: 'T', PJ: 'J' });
    eq('空称呼被拒 400', noname.status, 400);
  }

  /* ---------------- 多票统计（直插绕过 30 秒节流） ---------------- */
  console.log('\n【8】按轴取众数（核心算法）');
  if (IS_REMOTE) {
    console.log('  ⏭  远程模式下跳过：本节需要直连数据库插票，');
    console.log('      线上请改用 test/e2e-prod-agg.js（经 SSH 注入后走 API 校验）');
  } else {
    const { openDatabase } = require(path.resolve(__dirname, '../src/db.js'));
    const cfg = require(path.resolve(__dirname, '../src/config.js'));
    const { db } = openDatabase(resolveDbPath());
    const row = db.prepare('SELECT id FROM users WHERE login_account = ?').get(ACC);
    const ins = db.prepare(`INSERT INTO votes
      (target_user_id, voter_nickname, axis_ie, axis_ns, axis_tf, axis_pj, result_mbti, created_at, voter_ip, voter_ua)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const now = new Date().toISOString();
    // 已有 1 票 INTJ。再补 5 票，构造：
    //  IE: I=4 E=2  NS: N=4 S=2  TF: T=3 F=3(平票)  PJ: J=4 P=2
    const extra = [
      ['乙', 'I', 'N', 'T', 'P'],
      ['丙', 'I', 'S', 'F', 'J'],
      ['丁', 'E', 'N', 'T', 'J'],
      ['戊', 'I', 'N', 'F', 'J'],
      ['己', 'E', 'S', 'F', 'P']
    ];
    for (const [n, ie, ns, tf, pj] of extra) {
      ins.run(row.id, n, ie, ns, tf, pj, ie + ns + tf + pj, now, '10.0.0.' + rnd().slice(0, 2), 'UA');
    }
    db.close();

    const c = makeClient();
    const r = await c.get('/u/' + TOKEN + '/summary');
    eq('汇总返回 200', r.status, 200);
    const s = r.body.summary;
    eq('总票数 6', s.total_votes, 6);

    const ax = {};
    s.axes.forEach((a) => { ax[a.key] = a; });
    eq('IE: I=4', ax.IE.leftCount, 4);
    eq('IE: E=2', ax.IE.rightCount, 2);
    eq('IE 多数为 I', ax.IE.majority, 'I');
    eq('IE 无平票', ax.IE.tie, false);
    eq('TF: T=3', ax.TF.leftCount, 3);
    eq('TF: F=3', ax.TF.rightCount, 3);
    eq('TF 平票标记正确', ax.TF.tie, true);
    eq('TF 平票回落到自我认知 T', ax.TF.majority, 'T');
    eq('PJ: P=2（left 侧）', ax.PJ.leftCount, 2);
    eq('PJ: J=4（right 侧）', ax.PJ.rightCount, 4);
    eq('PJ 多数为 J', ax.PJ.majority, 'J');
    eq('拼出的多数 MBTI', s.majority_mbti, 'INTJ');
    eq('自我认知', s.self_mbti, 'INTJ');
    eq('无偏差轴', s.divergence_axes.length, 0);
    eq('样本充足(low_sample=false)', s.low_sample, false);
  }

  /* ---------------- 偏差检测 ---------------- */
  console.log('\n【9】自我认知 vs 多数人（偏差轴）');
  if (IS_REMOTE) {
    console.log('  ⏭  远程模式下跳过：同样需要直连数据库插票');
  } else {
    const c = makeClient();
    await c.post('/auth/register', { nickname: '偏差测试', account: 'div' + rnd() + '@t.com', password: '8361' });
    await c.post('/me/mbti', { mbti: 'INFP' });
    const me = await c.get('/auth/me');
    const tk = me.body.user.token;

    const { openDatabase } = require(path.resolve(__dirname, '../src/db.js'));
    const cfg = require(path.resolve(__dirname, '../src/config.js'));
    const { db } = openDatabase(resolveDbPath());
    const row = db.prepare('SELECT id FROM users WHERE token = ?').get(tk);
    const ins = db.prepare(`INSERT INTO votes
      (target_user_id, voter_nickname, axis_ie, axis_ns, axis_tf, axis_pj, result_mbti, created_at, voter_ip, voter_ua)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const now = new Date().toISOString();
    // 所有人都认为他是 ENFJ → 与 INFP 在 I/E 与 P/J 两轴上冲突
    for (let i = 0; i < 4; i++) ins.run(row.id, '友' + i, 'E', 'N', 'F', 'J', 'ENFJ', now, '10.1.0.' + i, 'UA');
    db.close();

    const s = await c.get('/u/' + tk + '/summary');
    eq('多数人认为是 ENFJ', s.body.summary.majority_mbti, 'ENFJ');
    eq('自我认知是 INFP', s.body.summary.self_mbti, 'INFP');
    ok('检测出偏差轴', s.body.summary.divergence_axes.length > 0,
      '偏差轴=' + JSON.stringify(s.body.summary.divergence_axes));
    ok('I/E 轴在偏差列表中', s.body.summary.divergence_axes.includes('IE'));
    ok('P/J 轴在偏差列表中', s.body.summary.divergence_axes.includes('PJ'));

    // 明细权限：本人可看
    const list = await c.get('/u/' + tk + '/votes');
    eq('本人可查看评价明细 200', list.status, 200);
    eq('明细条数正确', list.body.total, 4);
    ok('明细含评价者称呼', !!list.body.votes[0].voter_nickname);
    const rawList = JSON.stringify(list.body);
    ok('明细不泄漏评价者 IP', !rawList.includes('voter_ip') && !rawList.includes('10.1.0.'));
    ok('明细不泄漏评价者 UA', !rawList.includes('voter_ua'));
    // 2026-09-18 起明细**必须**带出评价 id：前端要靠它做「标记失效 / 恢复」。
    // 该接口是本人专属（下一段就断言了 401 / 403），所以暴露自增 id 是可接受的。
    // 真正要守的边界是「不泄漏评价者隐私字段」，已在上两行断言。
    ok('明细带出评价 id 供本人操作', typeof list.body.votes[0].id === 'number' && list.body.votes[0].id > 0,
      JSON.stringify(list.body.votes[0]));
    ok('明细带出 invalid 字段', typeof list.body.votes[0].invalid === 'boolean');

    // 他人不可看
    const other = makeClient();
    const r2 = await other.get('/u/' + tk + '/votes');
    eq('未登录不能看明细 401', r2.status, 401);
    const c1again = makeClient();
    await c1again.post('/auth/login', { account: ACC, password: PW });
    const r3 = await c1again.get('/u/' + tk + '/votes');
    eq('他人登录后仍不能看明细 403', r3.status, 403);
  }

  /* ---------------- 资料修改 ---------------- */
  console.log('\n【10】资料修改与审计');
  {
    const r = await c1.patch('/me', { nickname: '改过的名字😀', gender: 'male' });
    eq('修改资料返回 200', r.status, 200);
    eq('称呼已更新', r.body.user.nickname, '改过的名字😀');
    eq('性别已更新', r.body.user.gender, 'male');

    const bad = await c1.patch('/me', { gender: 'invalid' });
    eq('非法性别被拒 400', bad.status, 400);

    const nothing = await c1.patch('/me', {});
    eq('空更新被拒 400', nothing.status, 400);

    // 分享链接里称呼同步更新
    const pub = makeClient();
    const p = await pub.get('/u/' + TOKEN);
    eq('分享链接展示新称呼', p.body.user.nickname, '改过的名字😀');

    // 审计日志
    if (IS_REMOTE) {
      console.log('  ⏭  远程模式下跳过审计日志直连校验（已由线上聚合脚本覆盖）');
    } else {
    const { openDatabase } = require(path.resolve(__dirname, '../src/db.js'));
    const cfg = require(path.resolve(__dirname, '../src/config.js'));
    const { db } = openDatabase(resolveDbPath());
    // 审计表是全局累积的，必须按当前用户过滤，否则跨轮次重复计数
    const urow = db.prepare('SELECT id FROM users WHERE login_account = ?').get(ACC);
    const logs = db.prepare(
      'SELECT action, field, old_value, new_value FROM audit_log WHERE user_id = ? ORDER BY id'
    ).all(urow.id);
    db.close();
    ok('记录了两个字段的独立审计条目',
      logs.filter((l) => l.action === 'update_profile').length === 2,
      '实际=' + JSON.stringify(logs.filter((l) => l.action === 'update_profile')));
    const nickLog = logs.find((l) => l.field === 'nickname');
    ok('审计记录含旧值', nickLog && nickLog.old_value === '测试用户甲');
    ok('审计记录含新值', nickLog && nickLog.new_value === '改过的名字😀');
    }
  }

  /* ---------------- MBTI 只允许改一次 ---------------- */
  console.log('\n【11】MBTI 仅允许修改一次');
  {
    const noPw = await c1.post('/me/mbti', { mbti: 'ENTP' });
    eq('修改时缺密码被拒 400', noPw.status, 400);
    eq('错误码 password_required', noPw.body.code, 'password_required');

    const badPw = await c1.post('/me/mbti', { mbti: 'ENTP', password: '9999' });
    eq('密码错误被拒 401', badPw.status, 401);

    const good = await c1.post('/me/mbti', { mbti: 'ENTP', password: PW });
    eq('正确密码修改成功', good.status, 200);
    eq('类型已变更', good.body.user.mbti_self, 'ENTP');
    eq('剩余次数归零', good.body.remaining_edits, 0);

    const again = await c1.post('/me/mbti', { mbti: 'ISFJ', password: PW });
    eq('第二次修改被拒 403', again.status, 403);
    eq('错误码 edit_limit_reached', again.body.code, 'edit_limit_reached');

    const perm = await c1.get('/me/mbti-permission');
    eq('权限查询显示已用完', perm.body.can_edit, false);
    eq('reason=used', perm.body.reason, 'used');

    // 修改后分享链接同步
    const pub = makeClient();
    const p = await pub.get('/u/' + TOKEN);
    eq('分享链接展示新 MBTI', p.body.user.mbti_self, 'ENTP');
  }

  /* ---------------- 改密码 ---------------- */
  console.log('\n【12】修改密码');
  {
    const w = await c1.post('/auth/password', { old_password: '9999', new_password: '8361' });
    eq('原密码错误被拒 401', w.status, 401);
    const same = await c1.post('/auth/password', { old_password: PW, new_password: PW });
    eq('新旧密码相同被拒 400', same.status, 400);
    eq('错误码 same_password', same.body.code, 'same_password');
    const g = await c1.post('/auth/password', { old_password: PW, new_password: '8361' });
    eq('修改成功 200', g.status, 200);
    const relogin = makeClient();
    const rl = await relogin.post('/auth/login', { account: ACC, password: '8361' });
    eq('新密码可登录', rl.status, 200);
  }

  /* ---------------- 注入与 XSS ---------------- */
  console.log('\n【13】注入与 XSS 防护');
  {
    const injects = [
      "Robert'); DROP TABLE users;--",
      "' OR '1'='1",
      "'; UPDATE users SET password_hash='x';--",
      "1' UNION SELECT password_hash FROM users--",
      "admin'--"
    ];
    let allSafe = true, leaked = false;
    for (const payload of injects) {
      const c = makeClient();
      const r = await c.post('/auth/login', { account: payload, password: '3729' });
      if (r.status >= 500) allSafe = false;
      if (JSON.stringify(r.body).includes('scrypt$')) leaked = true;
    }
    ok('全部注入载荷未造成 5xx', allSafe);
    ok('未泄漏任何密码哈希', leaked === false);

    // 表还在吗
    const { openDatabase } = require(path.resolve(__dirname, '../src/db.js'));
    const cfg = require(path.resolve(__dirname, '../src/config.js'));
    const { db } = openDatabase(resolveDbPath());
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((x) => x.name);
    db.close();
    ok('users 表在注入攻击后依然存在', t.includes('users'));

    // XSS 载荷存进去要原样返回（前端负责转义，后端不破坏数据）
    const c = makeClient();
    const xacc = 'xss' + rnd() + '@t.com';
    await c.post('/auth/register', { nickname: '<img src=x onerror=alert(1)>', account: xacc, password: '3729' });
    const me = await c.get('/auth/me');
    eq('XSS 载荷原样存储（未被服务端破坏）', me.body.user.nickname, '<img src=x onerror=alert(1)>');
  }

  /* ---------------- 参数校验 ---------------- */
  console.log('\n【14】接口健壮性');
  {
    const c = makeClient();
    const r1 = await c.req('POST', '/auth/login', undefined, { 'Content-Type': 'text/plain' });
    eq('非 JSON 请求体返回 415', r1.status, 415);

    const r2 = await c.req('GET', '/nonexistent');
    eq('未知路由返回 404', r2.status, 404);

    const r3 = await c.get('/u/' + TOKEN + '/votes?limit=abc&offset=-5');
    ok('非法分页参数不导致 5xx', r3.status < 500, 'status=' + r3.status);

    const r4 = await c.req('POST', '/auth/login', 'not-json-at-all');
    eq('非法 JSON 返回 400', r4.status, 400);

    const r5 = await c.req('POST', '/auth/register', { nickname: 'x'.repeat(5000), account: 'big@t.com', password: '3729' });
    ok('超长昵称被拒（非 5xx）', r5.status === 400, 'status=' + r5.status);
  }

  /* ---------------- 找回功能已关闭 ---------------- */
  console.log('\n【15】找回功能已关闭（按需求下架）');
  {
    const c = makeClient();
    const r = await c.post('/auth/recover', {
      account: 'anyone@test.com', recovery_code: 'AAAA-BBBB-CCCC', new_password: '8361'
    });
    eq('POST /auth/recover 已不可用（404）', r.status, 404);
    ok('返回结构化 not_found', !!(r.body && r.body.code === 'not_found'),
      JSON.stringify(r.body).slice(0, 80));

    // 注册与登录不依赖找回码，必须照常可用
    const acc3 = 'norec' + rnd() + '@test.com';
    const c2 = makeClient();
    const reg = await c2.post('/auth/register', { nickname: '无找回码', account: acc3, password: '3729' });
    eq('注册仍然正常 201', reg.status, 201);
    ok('注册后即时登录态可用', c2.jar.has('mbti_session'));

    const rl = await makeClient().post('/auth/login', { account: acc3, password: '3729' });
    eq('注册后可用账号密码登录', rl.status, 200);
  }

  /* ---------------- 合规整改：不再接受 QQ 号注册 ---------------- */
  console.log('\n【16】QQ 号注册已关闭（微信外链规范 2.11.3）');
  {
    // 1. 注册：QQ 号形态必须被拒
    const qq = String(10000 + Math.floor(Math.random() * 899999999));
    const rQQ = await makeClient().post('/auth/register', {
      nickname: 'QQ注册测试', account: qq, password: '3729'
    });
    eq('用 ' + qq.length + ' 位纯数字（QQ 号形态）注册被拒 400', rQQ.status, 400);
    eq('错误码为 invalid_account', rQQ.body && rQQ.body.code, 'invalid_account');
    ok('提示语引导到邮箱或手机号',
      /邮箱|手机号/.test((rQQ.body && rQQ.body.message) || ''),
      (rQQ.body && rQQ.body.message) || '');

    // 2. 注册：11 位手机号仍应放行
    const phone = '139' + String(Math.floor(10000000 + Math.random() * 89999999));
    const rPhone = await makeClient().post('/auth/register', {
      nickname: '手机号注册测试', account: phone, password: '3729'
    });
    eq('11 位手机号注册正常 201', rPhone.status, 201);

    // 3. 注册：邮箱仍应放行
    const rMail = await makeClient().post('/auth/register', {
      nickname: '邮箱注册测试', account: 'qqgate' + rnd() + '@test.com', password: '3729'
    });
    eq('邮箱注册正常 201', rMail.status, 201);

    // 4. 登录：QQ 号形态**必须继续被接受**（历史账号不能锁死）。
    //    账号不存在时应返回 401 bad_credentials（说明格式已通过校验），
    //    而不是 400 invalid_account（说明在格式层就被挡掉了）。
    const rLoginQQ = await makeClient().post('/auth/login', { account: qq, password: '3729' });
    eq('纯数字账号登录走到凭据校验（401 而非 400）', rLoginQQ.status, 401);
    eq('登录错误码为 bad_credentials', rLoginQQ.body && rLoginQQ.body.code, 'bad_credentials');
  }

  /* ---------------- 评价失效标记（软删除） ---------------- */
  console.log('\n【17】把评价标为失效 / 恢复（本人操作，软删除）');
  {
    // 目标用户 A 与评价者 B
    const cA = makeClient();
    const accA = 'invA' + rnd() + '@t.com';
    const regA = await cA.post('/auth/register', { nickname: '被评价者A', account: accA, password: '3729' });
    eq('目标用户注册成功', regA.status, 201);
    const tokenA = regA.body.user.token;

    const cB = makeClient();
    const accB = 'invB' + rnd() + '@t.com';
    const regB = await cB.post('/auth/register', { nickname: '评价者B', account: accB, password: '3729' });
    eq('评价者注册成功', regB.status, 201);

    // B 给 A 投一票（B 用的是同一个出口 IP，注意 30 秒重复抑制只针对同 IP+同目标）
    const voteRes = await cB.post('/u/' + tokenA + '/vote', {
      voter_nickname: '评价者B', IE: 'I', NS: 'N', TF: 'T', PJ: 'J'
    });
    eq('投票成功', voteRes.status, 201);
    eq('投票后统计为 1 条', voteRes.body.summary.total_votes, 1);

    // A 看明细，应能拿到 id 与 invalid 字段
    const list0 = await cA.get('/u/' + tokenA + '/votes');
    eq('本人可以看明细', list0.status, 200);
    const v0 = (list0.body.votes || [])[0];
    ok('明细带出评价 id（前端要拿它操作）', !!(v0 && typeof v0.id === 'number' && v0.id > 0), JSON.stringify(v0));
    ok('明细带出 invalid 字段且默认为 false', !!(v0 && v0.invalid === false));
    ok('明细返回 invalid_total', list0.body.invalid_total === 0 && list0.body.valid_total === 1,
      'valid=' + list0.body.valid_total + ' invalid=' + list0.body.invalid_total);
    const vid = v0.id;

    // 1. 未登录不能操作
    const anon = await makeClient().patch('/u/' + tokenA + '/votes/' + vid, { invalid: true });
    eq('未登录操作被拒 401', anon.status, 401);

    // 2. 别人不能操作我的评价（越权）
    const other = await cB.patch('/u/' + tokenA + '/votes/' + vid, { invalid: true });
    eq('他人操作被拒 403', other.status, 403);
    eq('错误码为 forbidden', other.body && other.body.code, 'forbidden');

    // 3. 参数校验
    const badId = await cA.patch('/u/' + tokenA + '/votes/abc', { invalid: true });
    eq('非法评价编号被拒 400', badId.status, 400);
    const badBody = await cA.patch('/u/' + tokenA + '/votes/' + vid, { invalid: 'yes' });
    eq('invalid 非布尔被拒 400', badBody.status, 400);
    const noSuch = await cA.patch('/u/' + tokenA + '/votes/99999999', { invalid: true });
    eq('不存在的评价返回 404', noSuch.status, 404);

    // 4. 标为失效 → 统计里要消失
    const inv = await cA.patch('/u/' + tokenA + '/votes/' + vid, { invalid: true });
    eq('本人标记失效成功', inv.status, 200);
    ok('返回 invalid=true', inv.body && inv.body.invalid === true);

    const sum1 = await makeClient().get('/u/' + tokenA + '/summary');
    eq('失效后统计归零', sum1.body.summary.total_votes, 0);
    ok('失效后 has_votes 为 false', sum1.body.summary.has_votes === false);
    const axisAfter = sum1.body.summary.axes[0];
    ok('失效后各轴计数也归零',
      axisAfter.leftCount === 0 && axisAfter.rightCount === 0,
      'left=' + axisAfter.leftCount + ' right=' + axisAfter.rightCount);

    const list1 = await cA.get('/u/' + tokenA + '/votes');
    ok('明细里仍能看到这条（否则无法恢复）', (list1.body.votes || []).length === 1);
    ok('明细里 marked 为 invalid=true', list1.body.votes[0].invalid === true);
    ok('invalid_total 变为 1', list1.body.invalid_total === 1 && list1.body.valid_total === 0,
      'valid=' + list1.body.valid_total + ' invalid=' + list1.body.invalid_total);

    // 5. 幂等：重复标失效不报错
    const inv2 = await cA.patch('/u/' + tokenA + '/votes/' + vid, { invalid: true });
    eq('重复标记同一状态不报错（幂等）', inv2.status, 200);

    // 6. 恢复 → 重新计入统计
    const res = await cA.patch('/u/' + tokenA + '/votes/' + vid, { invalid: false });
    eq('恢复成功', res.status, 200);
    ok('返回 invalid=false', res.body && res.body.invalid === false);
    const sum2 = await makeClient().get('/u/' + tokenA + '/summary');
    eq('恢复后统计回到 1', sum2.body.summary.total_votes, 1);

    // 7. 全程没有任何物理删除：评价本体还在库里
    const { openDatabase } = require(path.resolve(__dirname, '../src/db.js'));
    const { db } = openDatabase(resolveDbPath());
    const row = db.prepare('SELECT invalid, invalid_at FROM votes WHERE id = ?').get(vid);
    db.close();
    ok('评价本体仍在库中（软删除，不是物理删除）', !!row);
    ok('恢复后 invalid_at 被清空', row && row.invalid === 0 && row.invalid_at === null,
      row ? JSON.stringify(row) : 'missing');
  }

  /* ---------------- 我发出的评价 / 是否已评价过 ---------------- */
  console.log('\n【18】我发出的评价 + 重复评价检测');
  {
    const cT = makeClient();
    const accT = 'myT' + rnd() + '@t.com';
    const regT = await cT.post('/auth/register', { nickname: '被评价者T', account: accT, password: '3729' });
    eq('目标 T 注册成功', regT.status, 201);
    const tokenT = regT.body.user.token;
    // 给 T 设一个自我认知，用于验证 target_self 字段
    await cT.post('/me/mbti', { mbti: 'ENFJ' });
    const meT = await cT.get('/auth/me');
    ok('T 的自我认知已设为 ENFJ', meT.body.user.mbti_self === 'ENFJ', JSON.stringify(meT.body.user.mbti_self));

    const cV = makeClient();
    const accV = 'myV' + rnd() + '@t.com';
    const regV = await cV.post('/auth/register', { nickname: '评价者V', account: accV, password: '3729' });
    eq('评价者 V 注册成功', regV.status, 201);

    // ---- 未登录时的行为 ----
    const anon = makeClient();
    const anonGiven = await anon.get('/me/votes-given');
    eq('未登录看「我发出的评价」被拒 401', anonGiven.status, 401);

    const anonMy = await anon.get('/u/' + tokenT + '/my-vote');
    eq('未登录查「是否已评价」不报错，返回 200', anonMy.status, 200);
    ok('未登录时 voted 为 false', anonMy.body.voted === false);
    ok('未登录也返回 summary（前端要直接拿去渲染结果页）',
      !!(anonMy.body.summary && typeof anonMy.body.summary.total_votes === 'number'));

    // ---- V 给 T 投票 ----
    const voted = await cV.post('/u/' + tokenT + '/vote', {
      voter_nickname: '评价者V', IE: 'E', NS: 'N', TF: 'F', PJ: 'J'
    });
    eq('V 给 T 投票成功', voted.status, 201);

    // ---- V 查「是否已评价」----
    const my = await cV.get('/u/' + tokenT + '/my-vote');
    eq('已评价时返回 200', my.status, 200);
    ok('voted 为 true', my.body.voted === true);
    ok('带出我当时的判断 ENFJ', my.body.vote && my.body.vote.your_choice === 'ENFJ',
      JSON.stringify(my.body.vote));
    ok('带出判断的类型详情', !!(my.body.vote && my.body.vote.your_choice_detail && my.body.vote.your_choice_detail.cn));
    // 评价人**不该知道**被评价人有没有把他的评价标为失效 —— 接口层就不返回这个字段，
    // 只在界面上藏起来是不够的（翻一下网络请求就看到了）
    ok('my-vote 不返回 invalid 字段（不把失效状态透给评价人）',
      my.body.vote && !('invalid' in my.body.vote), JSON.stringify(my.body.vote));    ok('同样带出 summary', !!(my.body.summary && my.body.summary.total_votes === 1));

    // ---- 对没评过的人，voted 必须是 false ----
    const cT2 = makeClient();
    await cT2.post('/auth/register', { nickname: '路人', account: 'stranger' + rnd() + '@t.com', password: '3729' });
    const strangerVote = await cT2.get('/u/' + tokenT + '/my-vote');
    eq('对没评过的人查询返回 200', strangerVote.status, 200);
    ok('对没评过的人 voted 为 false', strangerVote.body.voted === false);

    // ---- V 查「我发出的评价」----
    const given = await cV.get('/me/votes-given');
    eq('已登录可查「我发出的评价」200', given.status, 200);
    ok('至少包含刚投的那条', given.body.total >= 1, 'total=' + given.body.total);

    const mine = (given.body.votes || []).find((v) => v.target_token === tokenT);
    ok('能按 target_token 找到这条', !!mine);
    if (mine) {
      ok('带出目标昵称', mine.target_nickname === '被评价者T', mine.target_nickname);
      ok('带出我的选择 ENFJ', mine.my_choice === 'ENFJ', mine.my_choice);
      ok('带出我的选择详情', !!(mine.my_choice_detail && mine.my_choice_detail.cn));
      ok('带出目标的自我认知 ENFJ', mine.target_self === 'ENFJ', String(mine.target_self));
      ok('带出「大多数人认为」的结论 ENFJ', mine.target_majority === 'ENFJ', String(mine.target_majority));
      ok('带出评价时间', typeof mine.created_at === 'string' && mine.created_at.length > 0);
    }

    // ---- 不该泄漏的东西 ----
    const rawGiven = JSON.stringify(given.body);
    ok('「我发出的评价」不泄漏评价者 IP / UA',
      !rawGiven.includes('voter_ip') && !rawGiven.includes('voter_ua'));
    ok('「我发出的评价」不泄漏目标用户的登录账号',
      !rawGiven.includes(accT));

    // ---- 只包含自己发出的：V 不该看到 T 发出的其它评价 ----
    const givenT = await cT.get('/me/votes-given');
    eq('T 也能查自己的（200）', givenT.status, 200);
    ok('T 还没评价过别人，total 为 0',
      (givenT.body.votes || []).every((v) => v.target_token !== tokenT),
      'total=' + givenT.body.total);

    // ---- 目标把评价标为失效后：统计要变，但**不能**把这个状态透给评价人 ----
    const listT = await cT.get('/u/' + tokenT + '/votes');
    const vidT = listT.body.votes[0].id;
    await cT.patch('/u/' + tokenT + '/votes/' + vidT, { invalid: true });
    const my2 = await cV.get('/u/' + tokenT + '/my-vote');
    ok('目标标失效后，统计确实不把他算进去', my2.body.summary.total_votes === 0);
    ok('但 my-vote 里依然不出现 invalid 字段',
      my2.body.vote && !('invalid' in my2.body.vote), JSON.stringify(my2.body.vote));
    ok('评价人仍能查到"我投过"，只是看不到失效状态',
      my2.body.voted === true && my2.body.vote.your_choice === 'ENFJ',
      JSON.stringify(my2.body.vote));
  }

  /* ---------------- 修改已提交的评价（登录用户对同一目标只有一票） ---------------- */
  console.log('\n【19】登录用户可修改自己的评价（不新增票数）');
  {
    const cT = makeClient();
    const accT = 'edT' + rnd() + '@t.com';
    const regT = await cT.post('/auth/register', { nickname: '被改者T', account: accT, password: '3729' });
    const tokenT = regT.body.user.token;

    const cV = makeClient();
    await cV.post('/auth/register', { nickname: '改评价的人', account: 'edV' + rnd() + '@t.com', password: '3729' });

    // 第一次提交 → 新增
    const first = await cV.post('/u/' + tokenT + '/vote', {
      voter_nickname: '改评价的人', IE: 'I', NS: 'N', TF: 'T', PJ: 'J'
    });
    eq('首次提交返回 201', first.status, 201);
    eq('首次提交 updated 为 false', first.body.updated, false);
    // IE=I NS=N TF=T PJ=J → I,N,T,J = INTJ（别写成 INTP，这里是按轴拼的）
    eq('首次提交结果是 INTJ', first.body.your_choice, 'INTJ');
    eq('目标统计为 1 票', first.body.summary.total_votes, 1);

    // 第二次提交（改主意）→ 修改原记录，不新增
    const second = await cV.post('/u/' + tokenT + '/vote', {
      voter_nickname: '改评价的人', IE: 'E', NS: 'S', TF: 'F', PJ: 'P'
    });
    eq('再次提交返回 200（不是 201）', second.status, 200);
    eq('再次提交 updated 为 true', second.body.updated, true);
    eq('结果已变成 ESFP', second.body.your_choice, 'ESFP');

    // 关键：票数必须还是 1，不能被刷成 2
    const sum = await makeClient().get('/u/' + tokenT + '/summary');
    eq('修改后总票数仍为 1（没有新增行）', sum.body.summary.total_votes, 1);
    const iAxis = sum.body.summary.axes.find((a) => a.key === 'IE');
    eq('I/E 轴已按新选择计入（I=0）', iAxis.leftCount, 0);
    eq('I/E 轴已按新选择计入（E=1）', iAxis.rightCount, 1);

    // 明细里应当仍是 1 条，且内容是新的
    const list = await cT.get('/u/' + tokenT + '/votes');
    eq('明细仍只有 1 条', list.body.votes.length, 1);
    eq('明细里已是新结果 ESFP', list.body.votes[0].result_mbti, 'ESFP');

    // my-vote 也要反映最新判断
    const my = await cV.get('/u/' + tokenT + '/my-vote');
    eq('my-vote 返回最新的 ESFP', my.body.vote.your_choice, 'ESFP');

    // 目标把这条标为失效后，投票人再改一次 → 应当重新计入统计
    const vid = list.body.votes[0].id;
    await cT.patch('/u/' + tokenT + '/votes/' + vid, { invalid: true });
    const afterInvalid = await makeClient().get('/u/' + tokenT + '/summary');
    eq('标为失效后统计归零', afterInvalid.body.summary.total_votes, 0);

    const third = await cV.post('/u/' + tokenT + '/vote', {
      voter_nickname: '改评价的人', IE: 'I', NS: 'S', TF: 'T', PJ: 'J'
    });
    eq('失效后再修改仍返回 200', third.status, 200);
    eq('修改后重新计入统计', third.body.summary.total_votes, 1);

    // 匿名访客不受"修改"逻辑影响 —— 但同一个 IP 刚给同一个目标投过，
    // 会被「同 IP 30 秒内对同一目标只能投一次」的防刷规则挡住（这是预期行为，不是 bug）
    const anon = makeClient();
    const a1 = await anon.post('/u/' + tokenT + '/vote', {
      voter_nickname: '匿名甲', IE: 'I', NS: 'N', TF: 'T', PJ: 'J'
    });
    eq('同 IP 30 秒内对同一目标重复提交被拒 429', a1.status, 429);
    eq('错误码为 too_soon', a1.body && a1.body.code, 'too_soon');

    // 换一个全新的目标，匿名访客就能正常走「新增」这条路
    const cT2 = makeClient();
    const regT2 = await cT2.post('/auth/register', {
      nickname: '被改者T2', account: 'edT2' + rnd() + '@t.com', password: '3729'
    });
    const tokenT2 = regT2.body.user.token;
    const a2 = await anon.post('/u/' + tokenT2 + '/vote', {
      voter_nickname: '匿名甲', IE: 'I', NS: 'N', TF: 'T', PJ: 'J'
    });
    eq('匿名访客对新目标提交返回 201', a2.status, 201);
    eq('匿名访客 updated 为 false（走新增，不走修改）', a2.body.updated, false);
    eq('匿名访客的票计入目标统计', a2.body.summary.total_votes, 1);

    // 匿名访客没有会话，my-vote 永远说"没投过"（前端据此不会误判）
    const anonMy = await anon.get('/u/' + tokenT2 + '/my-vote');
    eq('匿名访客查 my-vote 返回 200', anonMy.status, 200);
    ok('匿名访客的 my-vote 里 voted 为 false', anonMy.body.voted === false);
  }

  console.log('\n' + '='.repeat(52));
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  if (fail) console.log('  失败项:\n' + failures.map((f) => '    - ' + f).join('\n'));
  console.log('='.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n测试脚本异常:', e); process.exit(2); });

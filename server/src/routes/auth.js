'use strict';

const { createHash } = require('node:crypto');
const { tx, audit, nowIso } = require('../db.js');
const {
  hashPassword,
  verifyPassword,
  makeToken,
  makeRecoveryCode
} = require('../security.js');
const { sendJson, buildCookie } = require('../http.js');

const SESSION_COOKIE = 'mbti_session';
const NICKNAME_MAX_WIDTH = 64;

function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

// 限流器返回值做兼容处理：布尔或 {ok/allowed, retryAfterSec/retryAfterMs}
function checkLimiter(limiter, key) {
  const r = limiter.check(key);
  if (r === true) return { ok: true, retryAfterSec: 0 };
  if (r === false || r == null) return { ok: false, retryAfterSec: 60 };
  if (r.ok === true || r.allowed === true) return { ok: true, retryAfterSec: 0 };
  const sec = r.retryAfterSec ?? Math.ceil((r.retryAfterMs ?? 60000) / 1000);
  return { ok: false, retryAfterSec: sec };
}

function tooMany(gate) {
  const minutes = Math.max(1, Math.ceil(gate.retryAfterSec / 60));
  return fail(429, 'too_many_requests', `操作太频繁，请约 ${minutes} 分钟后再试`);
}

// ---------------- 输入规范化与校验 ----------------

function normalizeAccount(raw) {
  if (typeof raw !== 'string') throw fail(400, 'invalid_account', '账号格式不正确');
  let acc = raw.trim();
  // 邮箱不区分大小写；纯数字保持原样
  if (acc.includes('@')) {
    acc = acc.toLowerCase();
    if (acc.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(acc)) return acc;
    throw fail(400, 'invalid_account', '账号格式不正确');
  }
  // 11 位手机号
  if (/^1[3-9]\d{9}$/.test(acc)) return acc;
  // 5-12 位纯数字：历史遗留的 QQ 号账号。
  // 注册已不再接受（见 register 里的 QQ_LIKE 拦截），但登录必须放行，
  // 否则此前用 QQ 号注册的用户将永久进不来。
  if (/^[1-9]\d{4,11}$/.test(acc)) return acc;
  throw fail(400, 'invalid_account', '账号格式不正确');
}

/** 纯数字且不是 11 位手机号 —— 即 QQ 号形态 */
function looksLikeQQ(acc) {
  return /^[1-9]\d{4,11}$/.test(acc) && !/^1[3-9]\d{9}$/.test(acc);
}

function validatePassword(raw) {
  if (typeof raw !== 'string' || !/^\d{4}$/.test(raw)) {
    throw fail(400, 'invalid_password', '密码必须是 4 位数字');
  }
  // 4 位数字本就很弱，重复与递增递减序列直接拒绝
  if (raw[0] === raw[1] && raw[1] === raw[2] && raw[2] === raw[3]) {
    throw fail(400, 'weak_password', '密码过于简单，请勿使用重复数字');
  }
  let asc = true;
  let desc = true;
  for (let i = 1; i < 4; i++) {
    const d = raw.charCodeAt(i) - raw.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  if (asc || desc) {
    throw fail(400, 'weak_password', '密码过于简单，请勿使用连续数字');
  }
  return raw;
}

// 中文 / 全角 / emoji 记宽度 2，ASCII 记 1
function isWideChar(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf)
  );
}

function validateNickname(raw) {
  if (typeof raw !== 'string') throw fail(400, 'invalid_nickname', '昵称不合法');
  // 剔除控制字符与零宽字符后再计算长度
  // 用转义写而不是字面量：字面量控制字符会让整个文件被判为二进制，妨碍检索。
  const cleaned = raw.trim().replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, '');
  if (cleaned.length === 0) throw fail(400, 'invalid_nickname', '昵称不能为空');
  let width = 0;
  for (const ch of Array.from(cleaned)) {
    width += isWideChar(ch.codePointAt(0)) ? 2 : 1;
  }
  if (width > NICKNAME_MAX_WIDTH) {
    throw fail(400, 'invalid_nickname', '昵称太长，最多 32 个汉字或 64 个英文字符');
  }
  return cleaned;
}

function maskAccount(acc) {
  if (typeof acc !== 'string') return '';
  if (acc.includes('@')) {
    const at = acc.indexOf('@');
    return acc.slice(0, 1) + '***@' + acc.slice(at + 1);
  }
  if (/^1[3-9]\d{9}$/.test(acc)) return acc.slice(0, 3) + '****' + acc.slice(7);
  if (/^[1-9]\d{4,11}$/.test(acc)) return acc.slice(0, 2) + '***' + acc.slice(-2);
  return '***';
}

// ---------------- 用户对象形状 ----------------

function selfUser(row) {
  return {
    token: row.token,
    nickname: row.nickname,
    gender: row.gender,
    login_account: row.login_account,
    mbti_self: row.mbti_self,
    mbti_edit_count: row.mbti_edit_count,
    created_at: row.created_at
  };
}

// ---------------- 会话 ----------------

function createSession(db, config, userId, ip, ua) {
  const raw = makeToken(32); // 回给浏览器的明文，库里只存哈希
  const tokenHash = sha256hex(raw);
  const now = Date.now();
  db.prepare(`INSERT INTO sessions
      (token_hash, user_id, created_at, expires_at, revoked, ip, ua)
    VALUES (?,?,?,?,0,?,?)`)
    .run(
      tokenHash,
      userId,
      new Date(now).toISOString(),
      new Date(now + config.sessionTtlMs).toISOString(),
      ip,
      ua
    );
  return raw;
}

function setSessionCookie(res, config, rawToken) {
  res.setHeader('Set-Cookie', buildCookie(SESSION_COOKIE, rawToken, {
    maxAge: Math.floor(config.sessionTtlMs / 1000),
    httpOnly: true,
    secure: config.secureCookie,
    sameSite: 'Lax'
  }));
}

// 返回用户行（含 id、password_hash 等全部字段，并附带 __session_hash）或 null；供其它路由复用
function getSessionUser(db, ctx) {
  const raw = ctx.cookies ? ctx.cookies[SESSION_COOKIE] : null;
  if (!raw || typeof raw !== 'string') return null;
  const tokenHash = sha256hex(raw);
  const now = nowIso();
  // 过期会话顺手标记作废（不删除，保留审计线索）
  db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ? AND expires_at <= ?')
    .run(tokenHash, now);
  const row = db.prepare(`SELECT u.*, s.token_hash AS __session_hash
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked = 0 AND s.expires_at > ?`)
    .get(tokenHash, now);
  if (!row) return null;
  // 契约：直接返回用户行（附带 __session_hash 供登出/改密区分当前会话）。
  // 消费方直接读 row.id / row.nickname，不要再多包一层。
  return row;
}

// ---------------- 路由处理器 ----------------

async function register(ctx) {
  const { db, limiters, config } = ctx.deps;
  const gateIp = checkLimiter(limiters.registerByIp, ctx.ip);
  if (!gateIp.ok) throw tooMany(gateIp);

  const body = await ctx.json();
  const nickname = validateNickname(body.nickname);
  const account = normalizeAccount(body.account);
  const password = validatePassword(body.password);

  // 不再接受 QQ 号注册。
  // 依据微信《外部链接内容管理规范》2.11.3：条款把「QQ号码」列入禁止
  // "要求用户提供"的敏感数据。表单不再提示是最关键的一步，这里再加一道硬拦截，
  // 让"我们不索要 QQ 号"这句话是可验证的，而不只是文案上不提。
  // 登录接口不放这条限制（见 normalizeAccount），历史账号照常可登。
  if (looksLikeQQ(account)) {
    throw fail(400, 'invalid_account', '请填写邮箱或手机号');
  }

  const exists = db.prepare('SELECT id FROM users WHERE login_account = ?').get(account);
  if (exists) {
    limiters.registerByIp.fail(ctx.ip);
    throw fail(409, 'account_taken', '已经有人注册过了，请换一个');
  }

  // 公开标识需唯一，最多重试 5 次
  let token = null;
  for (let i = 0; i < 5; i++) {
    const candidate = makeToken(12);
    const hit = db.prepare('SELECT 1 FROM users WHERE token = ?').get(candidate);
    if (!hit) {
      token = candidate;
      break;
    }
  }
  if (!token) throw fail(500, 'server_error', '服务器繁忙，请稍后重试');

  const recoveryCode = makeRecoveryCode();
  const passwordHash = hashPassword(password);
  const recoveryHash = hashPassword(recoveryCode);
  const now = nowIso();

  let userId = 0;
  tx(db, () => {
    const info = db.prepare(`INSERT INTO users
        (token, nickname, gender, login_account, password_hash, recovery_code_hash,
         created_at, updated_at, reg_ip, reg_ua)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(token, nickname, 'unset', account, passwordHash, recoveryHash, now, now, ctx.ip, ctx.ua);
    userId = Number(info.lastInsertRowid);
    audit(db, { userId, action: 'register', ip: ctx.ip, ua: ctx.ua });
  });

  const sessionToken = createSession(db, config, userId, ctx.ip, ctx.ua);
  setSessionCookie(ctx.res, config, sessionToken);

  sendJson(ctx.res, 201, {
    ok: true,
    user: selfUser({
      token,
      nickname,
      gender: 'unset',
      login_account: account,
      mbti_self: null,
      mbti_edit_count: 0,
      created_at: now
    }),
    recovery_code: recoveryCode, // 明文仅此一次返回
    share_token: token
  });
}

async function login(ctx) {
  const { db, limiters, config } = ctx.deps;
  const gateIp = checkLimiter(limiters.loginByIp, ctx.ip);
  if (!gateIp.ok) throw tooMany(gateIp);

  const body = await ctx.json();
  let account;
  try {
    account = normalizeAccount(body.account);
  } catch (e) {
    // 防账号枚举：格式错误与密码错误对外口径一致
    throw fail(401, 'bad_credentials', '账号或密码错误');
  }
  const password = typeof body.password === 'string' ? body.password : '';

  const gateAcc = checkLimiter(limiters.loginByAccount, account);
  if (!gateAcc.ok) throw tooMany(gateAcc);

  const row = db.prepare('SELECT * FROM users WHERE login_account = ?').get(account);
  if (!row) {
    // 账号不存在也计失败，且不区分提示语
    limiters.loginByAccount.fail(account);
    limiters.loginByIp.fail(ctx.ip);
    throw fail(401, 'bad_credentials', '账号或密码错误');
  }
  if (row.banned) throw fail(403, 'banned', '账号已被封禁');

  if (!verifyPassword(password, row.password_hash)) {
    limiters.loginByAccount.fail(account);
    limiters.loginByIp.fail(ctx.ip);
    throw fail(401, 'bad_credentials', '账号或密码错误');
  }
  limiters.loginByAccount.succeed(account);
  limiters.loginByIp.succeed(ctx.ip);

  const now = nowIso();
  tx(db, () => {
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
    audit(db, { userId: row.id, action: 'login', ip: ctx.ip, ua: ctx.ua });
  });

  const sessionToken = createSession(db, config, row.id, ctx.ip, ctx.ua);
  setSessionCookie(ctx.res, config, sessionToken);
  sendJson(ctx.res, 200, { ok: true, user: selfUser(row) });
}

async function logout(ctx) {
  const { db, config } = ctx.deps;
  const raw = ctx.cookies ? ctx.cookies[SESSION_COOKIE] : null;
  if (raw && typeof raw === 'string') {
    db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(sha256hex(raw));
  }
  ctx.res.setHeader('Set-Cookie', buildCookie(SESSION_COOKIE, '', {
    maxAge: 0,
    httpOnly: true,
    secure: config.secureCookie,
    sameSite: 'Lax'
  }));
  sendJson(ctx.res, 200, { ok: true });
}

async function me(ctx) {
  const { db } = ctx.deps;
  const sess = getSessionUser(db, ctx);
  if (!sess) throw fail(401, 'unauthorized', '请先登录');
  sendJson(ctx.res, 200, { ok: true, user: selfUser(sess) });
}

async function recover(ctx) {
  const { db, limiters } = ctx.deps;
  const gateIp = checkLimiter(limiters.loginByIp, ctx.ip);
  if (!gateIp.ok) throw tooMany(gateIp);

  const body = await ctx.json();
  const account = normalizeAccount(body.account);
  const newPassword = validatePassword(body.new_password);
  const codeInput = typeof body.recovery_code === 'string'
    ? body.recovery_code.trim().toUpperCase()
    : '';

  const row = db.prepare('SELECT * FROM users WHERE login_account = ?').get(account);
  if (!row) throw fail(401, 'bad_credentials', '账号或找回码错误');

  const gateAcc = checkLimiter(limiters.loginByAccount, account);
  if (!gateAcc.ok) throw tooMany(gateAcc);

  if (!verifyPassword(codeInput, row.recovery_code_hash)) {
    limiters.loginByIp.fail(ctx.ip);
    limiters.loginByAccount.fail(account);
    throw fail(401, 'bad_credentials', '账号或找回码错误');
  }
  limiters.loginByIp.succeed(ctx.ip);
  limiters.loginByAccount.succeed(account);

  // 找回成功后旧找回码一次性作废，重新签发
  const newCode = makeRecoveryCode();
  const newPasswordHash = hashPassword(newPassword);
  const newCodeHash = hashPassword(newCode);
  const now = nowIso();

  tx(db, () => {
    db.prepare('UPDATE users SET password_hash = ?, recovery_code_hash = ?, updated_at = ? WHERE id = ?')
      .run(newPasswordHash, newCodeHash, now, row.id);
    // 找回视为账号可能失陷，吊销该用户全部会话
    db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(row.id);
    // 审计绝不落明文或哈希
    audit(db, {
      userId: row.id,
      action: 'recover',
      field: 'password_hash',
      oldValue: '[redacted]',
      newValue: '[redacted]',
      ip: ctx.ip,
      ua: ctx.ua
    });
  });

  sendJson(ctx.res, 200, { ok: true, recovery_code: newCode });
}

async function changePassword(ctx) {
  const { db, limiters } = ctx.deps;
  const sess = getSessionUser(db, ctx);
  if (!sess) throw fail(401, 'unauthorized', '请先登录');
  const user = sess;

  const key = 'pw:' + user.id;
  const gate = checkLimiter(limiters.loginByAccount, key);
  if (!gate.ok) throw tooMany(gate);

  const body = await ctx.json();
  const oldPassword = typeof body.old_password === 'string' ? body.old_password : '';
  if (!verifyPassword(oldPassword, user.password_hash)) {
    limiters.loginByAccount.fail(key);
    throw fail(401, 'bad_old_password', '原密码错误');
  }
  const newPassword = validatePassword(body.new_password);
  if (newPassword === oldPassword) {
    throw fail(400, 'same_password', '新密码不能与原密码相同');
  }

  const now = nowIso();
  const newHash = hashPassword(newPassword);
  tx(db, () => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(newHash, now, user.id);
    // 吊销除当前会话外的其它会话
    db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND token_hash != ?')
      .run(user.id, sess.__session_hash);
    audit(db, {
      userId: user.id,
      action: 'change_password',
      field: 'password_hash',
      oldValue: '[redacted]',
      newValue: '[redacted]',
      ip: ctx.ip,
      ua: ctx.ua
    });
  });
  limiters.loginByAccount.succeed(key);

  sendJson(ctx.res, 200, { ok: true });
}

module.exports = {
  register,
  login,
  logout,
  me,
  recover,
  changePassword,
  getSessionUser,
  maskAccount,
  normalizeAccount,
  validatePassword,
  validateNickname
};
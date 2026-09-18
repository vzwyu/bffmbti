'use strict';

const { tx, audit, nowIso } = require('../db.js');
const { verifyPassword, hashPassword } = require('../security.js');
const { sendJson } = require('../http.js');
const { getSessionUser, validateNickname, maskAccount } = require('./auth.js');
const MBTI = require('../../../shared/mbti-types.js');

// 统一的业务错误抛出
function fail(status, code, msg) {
  throw Object.assign(new Error(msg), { status, code });
}

const GENDERS = ['male', 'female', 'other', 'unset'];

// 前端权限提示文案，reason -> label
const PERMISSION_LABELS = {
  not_set: '还没有选择你的人格类型',
  available: '你还可以修改 1 次（仅此一次）',
  used: '修改机会已用完，类型不可再改',
  unchanged_pending: '你还可以修改 1 次（仅此一次）',
};

// 脱敏后的本人信息（不含任何密码相关字段）
function selfUser(row) {
  return {
    token: row.token,
    nickname: row.nickname,
    gender: row.gender,
    login_account: maskAccount(row.login_account),
    mbti_self: row.mbti_self,
    mbti_edit_count: row.mbti_edit_count,
    created_at: row.created_at,
  };
}

function freshUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

async function updateProfile(ctx) {
  const { res, ip, ua, deps } = ctx;
  const db = deps.db;
  const me = getSessionUser(db, ctx);
  if (!me) fail(401, 'unauthorized', '请先登录');

  const body = await ctx.json();
  const { nickname, gender } = body || {};

  if (nickname === undefined && gender === undefined) {
    fail(400, 'nothing_to_update', '没有需要修改的内容');
  }

  // 只收集真正发生变化的字段，逐字段更新 + 逐字段审计
  const changes = [];

  if (nickname !== undefined) {
    // validateNickname 是抛错式：非法直接抛 400，合法则返回清洗后的字符串
    const cleaned = validateNickname(nickname);
    if (cleaned !== me.nickname) {
      changes.push({ field: 'nickname', oldValue: me.nickname, newValue: cleaned });
    }
  }

  if (gender !== undefined) {
    if (!GENDERS.includes(gender)) fail(400, 'invalid_gender', '性别取值不合法');
    if (gender !== me.gender) {
      changes.push({ field: 'gender', oldValue: me.gender, newValue: gender });
    }
  }

  const now = nowIso();
  // 字段名来自固定白名单，预编译语句避免任何拼接用户输入
  const stmts = {
    nickname: db.prepare('UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?'),
    gender: db.prepare('UPDATE users SET gender = ?, updated_at = ? WHERE id = ?'),
  };

  tx(db, () => {
    for (const c of changes) {
      stmts[c.field].run(c.newValue, now, me.id);
      audit(db, {
        userId: me.id,
        action: 'update_profile',
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        ip,
        ua,
      });
    }
  });

  sendJson(res, 200, { ok: true, user: selfUser(freshUser(db, me.id)) });
}

async function setMbti(ctx) {
  const { res, ip, ua, deps } = ctx;
  const db = deps.db;
  const me = getSessionUser(db, ctx);
  if (!me) fail(401, 'unauthorized', '请先登录');

  const body = await ctx.json();
  const { mbti, password } = body || {};

  if (!MBTI.isValidCode(mbti)) fail(400, 'invalid_mbti', '人格类型不正确');

  const now = nowIso();

  // 首次设置：免密码，直接写入，并保留一次修改机会
  if (me.mbti_self == null) {
    tx(db, () => {
      db.prepare('UPDATE users SET mbti_self = ?, mbti_edit_count = 0, updated_at = ? WHERE id = ?')
        .run(mbti, now, me.id);
      audit(db, {
        userId: me.id,
        action: 'set_mbti',
        field: 'mbti_self',
        oldValue: null,
        newValue: mbti,
        ip,
        ua,
      });
    });
    return sendJson(res, 200, {
      ok: true,
      user: selfUser(freshUser(db, me.id)),
      changed: true,
      remaining_edits: 1,
    });
  }

  // 修改路径
  if (mbti === me.mbti_self) fail(400, 'same_mbti', '新类型与当前类型相同');
  if (me.mbti_edit_count >= 1) {
    fail(403, 'edit_limit_reached', 'MBTI 只能修改一次，你已经用掉了这次机会');
  }

  // 限流复用登录限流器，独立 key 避免与登录互相影响
  const limiter = deps.limiters && deps.limiters.loginByAccount;
  const limitKey = 'mbti:' + me.id;
  if (limiter && typeof limiter.check === 'function') {
    const gate = limiter.check(limitKey);
    if (gate && gate.allowed === false) {
      const minutes = Math.max(1, Math.ceil((gate.retryAfterSec || 60) / 60));
      fail(429, 'too_many_requests', '操作太频繁，请约 ' + minutes + ' 分钟后再试');
    }
  }

  if (typeof password !== 'string' || !/^\d{4}$/.test(password)) {
    fail(400, 'password_required', '修改人格类型需要输入密码');
  }
  if (!verifyPassword(password, me.password_hash)) {
    if (limiter && typeof limiter.fail === 'function') limiter.fail(limitKey);
    fail(401, 'bad_password', '密码错误');
  }
  if (limiter && typeof limiter.succeed === 'function') limiter.succeed(limitKey);

  tx(db, () => {
    db.prepare('UPDATE users SET mbti_self = ?, mbti_edit_count = mbti_edit_count + 1, updated_at = ? WHERE id = ?')
      .run(mbti, now, me.id);
    audit(db, {
      userId: me.id,
      action: 'change_mbti',
      field: 'mbti_self',
      oldValue: me.mbti_self,
      newValue: mbti,
      ip,
      ua,
    });
  });

  sendJson(res, 200, {
    ok: true,
    user: selfUser(freshUser(db, me.id)),
    changed: true,
    remaining_edits: 0,
  });
}

async function mbtiPermission(ctx) {
  const db = ctx.deps.db;
  const me = getSessionUser(db, ctx);
  if (!me) fail(401, 'unauthorized', '请先登录');

  let reason;
  if (me.mbti_self == null) reason = 'not_set';
  else if (me.mbti_edit_count === 0) reason = 'available';
  else reason = 'used';

  const can_edit = me.mbti_self == null || me.mbti_edit_count === 0;
  const remaining_edits = can_edit ? 1 : 0;

  sendJson(ctx.res, 200, {
    ok: true,
    can_edit,
    reason,
    remaining_edits,
    label: PERMISSION_LABELS[reason] || PERMISSION_LABELS.unchanged_pending,
  });
}

module.exports = { updateProfile, setMbti, mbtiPermission };
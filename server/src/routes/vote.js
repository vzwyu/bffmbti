'use strict';

const { tx, audit, nowIso } = require('../db.js');
const { sendJson } = require('../http.js');
const { getSessionUser, validateNickname } = require('./auth.js');
const MBTI = require('../../../shared/mbti-types.js');

// 刷票抑制窗口：同一 IP 对同一目标 30 秒内只能提交一次
const DUPLICATE_WINDOW_MS = 30 * 1000;

function makeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// 限流器返回值形态不固定（false / {ok:false} / {allowed:false} 都算超限）
function checkLimit(limiter, ip, message) {
  const r = limiter.check(ip);
  if (r === false || (r && r.ok === false) || (r && r.allowed === false)) {
    throw makeError(429, 'too_many_requests', message);
  }
}

function findUserByToken(db, token) {
  return db.prepare('SELECT * FROM users WHERE token = ?').get(token);
}

function requireActiveUser(db, token) {
  const user = findUserByToken(db, token);
  if (!user || user.banned === 1) {
    throw makeError(404, 'not_found', '这个链接无效或已失效');
  }
  return user;
}

/**
 * 按轴取众数的统计核心。
 * 绝不能按 result_mbti 整体取众数：16 种组合在小样本下永远凑不出多数。
 */
function computeSummary(db, userRow) {
  // 表名/列名/聚合表达式均为写死常量，仅 target_user_id 参数化
  // invalid = 0：被目标本人标为失效的评价不计入统计
  const row = db.prepare(`
    SELECT
      SUM(axis_ie='I') AS ie_i, SUM(axis_ie='E') AS ie_e,
      SUM(axis_ns='N') AS ns_n, SUM(axis_ns='S') AS ns_s,
      SUM(axis_tf='T') AS tf_t, SUM(axis_tf='F') AS tf_f,
      SUM(axis_pj='P') AS pj_p, SUM(axis_pj='J') AS pj_j,
      COUNT(*) AS total
    FROM votes WHERE target_user_id = ? AND invalid = 0
  `).get(userRow.id) || {};

  const total = Number(row.total) || 0;
  const self = typeof userRow.mbti_self === 'string' ? userRow.mbti_self : null;

  const axes = MBTI.AXES.map((axis, idx) => {
    // SUM() 在无行时返回 NULL，必须 Number() || 0 兜底
    const leftCount = Number(row[axis.key.toLowerCase() + '_' + axis.left.toLowerCase()]) || 0;
    const rightCount = Number(row[axis.key.toLowerCase() + '_' + axis.right.toLowerCase()]) || 0;

    // 自我认知在该轴的取值（IE→0, NS→1, TF→2, PJ→3），非法字符视为无
    let selfChoice = null;
    if (self && self.length === 4 && (self[idx] === axis.left || self[idx] === axis.right)) {
      selfChoice = self[idx];
    }

    let majority = null;
    let tie = false;
    if (leftCount > rightCount) {
      majority = axis.left;
    } else if (rightCount > leftCount) {
      majority = axis.right;
    } else {
      // 平票（含 0:0、即无投票）：回落到自我认知，无自我认知则为 null
      tie = true;
      majority = selfChoice;
    }

    const agreeWithMajority = (selfChoice && majority) ? (selfChoice === majority) : null;

    return {
      key: axis.key,
      left: axis.left,
      right: axis.right,
      leftCn: axis.leftCn,
      rightCn: axis.rightCn,
      leftCount,
      rightCount,
      majority,
      tie,
      selfChoice,
      agreeWithMajority
    };
  });

  // 四轴都有 majority 才拼得出多数 MBTI
  const picks = {};
  let allHaveMajority = true;
  for (const a of axes) {
    if (!a.majority) { allHaveMajority = false; break; }
    picks[a.key] = a.majority;
  }
  const majorityMbti = allHaveMajority ? MBTI.buildCode(picks) : null;

  const selfMbti = (self && MBTI.get(self)) ? self : null;

  const divergenceAxes = axes
    .filter(a => a.selfChoice && a.majority && a.selfChoice !== a.majority)
    .map(a => a.key);

  return {
    total_votes: total,
    low_sample: total < 3,
    axes,
    majority_mbti: majorityMbti,
    self_mbti: selfMbti,
    divergence_axes: divergenceAxes,
    has_votes: total > 0
  };
}

function typeDetail(code) {
  const t = MBTI.get(code);
  if (!t) return null;
  return { code: t.code, cn: t.cn, en: t.en, group: t.group, color: t.color };
}

// 路由 1：公开用户信息（访客评价页用）
async function publicUser(ctx) {
  checkLimit(ctx.deps.limiters.readByIp, ctx.ip, '请求太频繁，请稍后再试');
  const user = requireActiveUser(ctx.deps.db, ctx.params.token);
  // 只暴露白名单字段，绝不回传 login_account / password_hash / id 等敏感信息
  sendJson(ctx.res, 200, {
    ok: true,
    user: {
      token: user.token,
      nickname: user.nickname,
      gender: user.gender,
      mbti_self: user.mbti_self || null
    }
  });
}

// 路由 2：提交评价（无需登录，匿名访客也可）
async function submitVote(ctx) {
  const { db, config } = ctx.deps;

  checkLimit(ctx.deps.limiters.voteByIp, ctx.ip, '提交太频繁，请稍后再试');

  const target = requireActiveUser(db, ctx.params.token);

  const body = await ctx.json();
  const voterNickname = validateNickname(body && body.voter_nickname);

  // 四个轴必须严格等于该轴的 left 或 right
  const axisPicks = {};
  for (const axis of MBTI.AXES) {
    const v = body ? body[axis.key] : undefined;
    if (v !== axis.left && v !== axis.right) {
      throw makeError(400, 'invalid_axes', '请完成全部四个选择');
    }
    axisPicks[axis.key] = v;
  }

  const resultMbti = MBTI.buildCode(axisPicks);
  if (!resultMbti) {
    throw makeError(400, 'invalid_axes', '请完成全部四个选择');
  }

  // 提前取会话：登录用户对同一目标只能有一条评价，再次提交 = 修改原记录
  const sessionUser = getSessionUser(db, ctx);
  const voterUserId = sessionUser ? sessionUser.id : null;

  let existing = null;
  if (voterUserId) {
    existing = db.prepare(
      'SELECT id FROM votes WHERE target_user_id = ? AND voter_user_id = ? ORDER BY id DESC LIMIT 1'
    ).get(target.id, voterUserId);
  }

  const updated = !!existing;

  if (existing) {
    // 修改已有记录，不新增行：既不占新额度，也不受 30 秒重复提交限制。
    // invalid = 0 是刻意的：目标之前把这条标为失效，是针对旧内容的；
    // 投票人现在提交了新的判断，应当重新计入统计（他仍然只有一票，不会放大权重）。
    db.prepare(`
      UPDATE votes
      SET voter_nickname = ?, axis_ie = ?, axis_ns = ?, axis_tf = ?, axis_pj = ?,
          result_mbti = ?, invalid = 0, invalid_at = NULL, voter_ip = ?, voter_ua = ?
      WHERE id = ?
    `).run(
      voterNickname,
      axisPicks.IE,
      axisPicks.NS,
      axisPicks.TF,
      axisPicks.PJ,
      resultMbti,
      ctx.ip,
      ctx.ua,
      existing.id
    );
  } else {
    // 防灌库：单个目标收到的**有效**评价总量有上限。
    // 失效的不占额度 —— 否则用户把刷屏的评价标为失效后，反倒占着名额。
    const countRow = db.prepare(
      'SELECT COUNT(*) AS n FROM votes WHERE target_user_id = ? AND invalid = 0'
    ).get(target.id);
    if ((Number(countRow && countRow.n) || 0) >= config.maxVotesPerTarget) {
      throw makeError(429, 'vote_limit_reached', '该用户收到的评价已达上限');
    }

    // 同一人重复刷票抑制：同 IP 对同目标 30 秒内只能投一次
    const lastRow = db.prepare(
      'SELECT created_at FROM votes WHERE target_user_id = ? AND voter_ip = ? ORDER BY id DESC LIMIT 1'
    ).get(target.id, ctx.ip);
    if (lastRow && lastRow.created_at) {
      const elapsed = Date.now() - new Date(lastRow.created_at).getTime();
      if (Number.isFinite(elapsed) && elapsed < DUPLICATE_WINDOW_MS) {
        throw makeError(429, 'too_soon', '刚刚已经提交过了，请稍后再试');
      }
    }

    db.prepare(`
      INSERT INTO votes
        (target_user_id, voter_nickname, voter_user_id, axis_ie, axis_ns, axis_tf, axis_pj,
         result_mbti, created_at, voter_ip, voter_ua)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      target.id,
      voterNickname,
      voterUserId,
      axisPicks.IE,
      axisPicks.NS,
      axisPicks.TF,
      axisPicks.PJ,
      resultMbti,
      nowIso(),
      ctx.ip,
      ctx.ua
    );
  }

  const summary = computeSummary(db, target);

  sendJson(ctx.res, updated ? 200 : 201, {
    ok: true,
    updated,
    your_choice: resultMbti,
    your_choice_detail: typeDetail(resultMbti),
    summary
  });
}

// 路由 3：统计汇总（公开）
async function getSummary(ctx) {
  checkLimit(ctx.deps.limiters.readByIp, ctx.ip, '请求太频繁，请稍后再试');
  const user = requireActiveUser(ctx.deps.db, ctx.params.token);
  sendJson(ctx.res, 200, { ok: true, summary: computeSummary(ctx.deps.db, user) });
}

// 路由 4：评价明细（必须登录且必须是本人）
async function listVotes(ctx) {
  const { db } = ctx.deps;

  const sessionUser = getSessionUser(ctx.deps.db, ctx);
  if (!sessionUser) {
    throw makeError(401, 'unauthorized', '请先登录');
  }

  const target = findUserByToken(db, ctx.params.token);
  if (!target || target.banned === 1) {
    throw makeError(404, 'not_found', '这个链接无效或已失效');
  }

  // 归属校验：只看登录状态不够，必须是本人
  if (sessionUser.id !== target.id) {
    throw makeError(403, 'forbidden', '无权查看他人的评价明细');
  }

  // 分页参数：非法值回落默认，不抛错
  let limit = parseInt(ctx.query && ctx.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;
  let offset = parseInt(ctx.query && ctx.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  // total 是**全部**条数（含已失效），分页按它算，否则翻页会漏项；
  // valid_total / invalid_total 只用于提示。
  const countRow = db.prepare(`
    SELECT COUNT(*) AS total, SUM(invalid = 1) AS invalid_n
    FROM votes WHERE target_user_id = ?
  `).get(target.id) || {};
  const total = Number(countRow.total) || 0;
  const invalidTotal = Number(countRow.invalid_n) || 0;

  // 明细只取展示字段，绝不带出 voter_ip / voter_ua（评价者隐私）。
  // id 必须带出：前端要靠它做「标记失效 / 恢复」。
  const rows = db.prepare(`
    SELECT id, voter_nickname, result_mbti, created_at, invalid
    FROM votes
    WHERE target_user_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(target.id, limit, offset);

  sendJson(ctx.res, 200, {
    ok: true,
    total,
    valid_total: total - invalidTotal,
    invalid_total: invalidTotal,
    votes: rows.map(v => ({
      id: v.id,
      voter_nickname: v.voter_nickname,
      result_mbti: v.result_mbti,
      detail: typeDetail(v.result_mbti),
      created_at: v.created_at,
      invalid: v.invalid === 1
    }))
  });
}

/**
 * 路由 5：把某条评价标为失效 / 恢复有效（必须登录且必须是本人）
 * 用标记位而不是物理删除 —— 全库没有任何 DELETE，评价本体永远保留。
 */
async function setVoteInvalid(ctx) {
  const { db } = ctx.deps;

  // 注意参数顺序是 (db, ctx) —— 漏传 db 会静默失效
  const sessionUser = getSessionUser(db, ctx);
  if (!sessionUser) {
    throw makeError(401, 'unauthorized', '请先登录');
  }

  const target = findUserByToken(db, ctx.params.token);
  if (!target || target.banned === 1) {
    throw makeError(404, 'not_found', '这个链接无效或已失效');
  }
  if (sessionUser.id !== target.id) {
    throw makeError(403, 'forbidden', '无权操作他人的评价');
  }

  const voteId = parseInt(ctx.params.id, 10);
  if (!Number.isFinite(voteId) || voteId <= 0) {
    throw makeError(400, 'invalid_id', '评价编号不正确');
  }

  const body = await ctx.json();
  if (typeof body.invalid !== 'boolean') {
    throw makeError(400, 'invalid_payload', 'invalid 必须是布尔值');
  }
  const want = body.invalid ? 1 : 0;

  const row = db.prepare('SELECT id, target_user_id, invalid FROM votes WHERE id = ?').get(voteId);
  if (!row) {
    throw makeError(404, 'not_found', '评价不存在');
  }
  // 归属再校验：只知道评价 id 不代表能改，必须属于这个目标用户
  if (row.target_user_id !== target.id) {
    throw makeError(403, 'forbidden', '无权操作他人的评价');
  }

  // 幂等：已经是目标状态就直接返回，不写审计噪音
  if (row.invalid !== want) {
    tx(db, () => {
      db.prepare('UPDATE votes SET invalid = ?, invalid_at = ? WHERE id = ?')
        .run(want, want ? nowIso() : null, voteId);
      audit(db, {
        userId: target.id,
        action: want ? 'vote_invalidate' : 'vote_restore',
        field: 'votes.invalid',
        oldValue: String(row.invalid),
        newValue: String(want),
        ip: ctx.ip,
        ua: ctx.ua
      });
    });
  }

  sendJson(ctx.res, 200, { ok: true, vote_id: voteId, invalid: want === 1 });
}

/**
 * 路由 6：我发给别人的评价列表（必须登录）
 * 只查 voter_user_id = 我 —— 匿名访客的投票没有 user_id，天然不会出现在这里。
 */
async function listMyVotes(ctx) {
  const { db } = ctx.deps;
  const sessionUser = getSessionUser(db, ctx);
  if (!sessionUser) {
    throw makeError(401, 'unauthorized', '请先登录');
  }
  checkLimit(ctx.deps.limiters.readByIp, ctx.ip, '请求太频繁，请稍后再试');

  const q = ctx.query || {};
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;
  let offset = parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  // 封禁用户要从列表里剔掉；**总数也必须用同样的 JOIN 条件**，
  // 否则分页条数与实际返回对不上（翻页会莫名少几条）。
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS n FROM votes v JOIN users u ON u.id = v.target_user_id
    WHERE v.voter_user_id = ? AND u.banned = 0
  `).get(sessionUser.id);
  const total = Number(totalRow && totalRow.n) || 0;

  const rows = db.prepare(`
    SELECT v.id, v.result_mbti, v.created_at,
           u.id AS target_user_id, u.token AS target_token,
           u.nickname AS target_nickname, u.mbti_self AS target_self
    FROM votes v JOIN users u ON u.id = v.target_user_id
    WHERE v.voter_user_id = ? AND u.banned = 0
    ORDER BY v.id DESC
    LIMIT ? OFFSET ?
  `).all(sessionUser.id, limit, offset);

  // 同一个目标只算一次统计（computeSummary 第一参数必须是行对象）
  const summaryCache = new Map();
  for (const r of rows) {
    if (!summaryCache.has(r.target_user_id)) {
      summaryCache.set(r.target_user_id, computeSummary(db, {
        id: r.target_user_id,
        mbti_self: r.target_self
      }));
    }
  }

  sendJson(ctx.res, 200, {
    ok: true,
    total,
    votes: rows.map(r => {
      const summary = summaryCache.get(r.target_user_id) || {};
      return {
        id: r.id,
        target_token: r.target_token,
        target_nickname: r.target_nickname,
        my_choice: r.result_mbti,
        my_choice_detail: typeDetail(r.result_mbti),
        target_majority: summary.majority_mbti || null,
        target_self: (r.target_self && MBTI.get(r.target_self)) ? r.target_self : null,
        created_at: r.created_at
      };
    })
  });
}

/**
 * 路由 7：我对某个分享链接的主人是否已经评价过（访客页用）
 * 未登录**不报错** —— 访客页要能继续走匿名流程，抛 401 会把它打断。
 */
async function getMyVote(ctx) {
  const { db } = ctx.deps;
  checkLimit(ctx.deps.limiters.readByIp, ctx.ip, '请求太频繁，请稍后再试');

  const target = requireActiveUser(db, ctx.params.token);
  const sessionUser = getSessionUser(db, ctx);

  let row = null;
  if (sessionUser) {
    row = db.prepare(`
      SELECT id, result_mbti, created_at
      FROM votes WHERE target_user_id = ? AND voter_user_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(target.id, sessionUser.id);
  }

  sendJson(ctx.res, 200, {
    ok: true,
    voted: !!row,
    vote: row ? {
      id: row.id,
      your_choice: row.result_mbti,
      your_choice_detail: typeDetail(row.result_mbti),
      created_at: row.created_at
    } : null,
    // summary 无论 voted 与否都返回：前端要直接拿它渲染结果对比页。
    // 注意：这里**不返回** invalid —— 被评价人把某条标为失效是他自己的事，
    // 透给评价人只会制造矛盾（不只是界面不显示，接口层就不给）。
    summary: computeSummary(db, target)
  });
}

module.exports = {
  publicUser, submitVote, getSummary, listVotes, setVoteInvalid,
  listMyVotes, getMyVote, computeSummary
};
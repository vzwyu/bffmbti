// ========== 路由 6：我发出的评价 ==========
async function listMyVotes(ctx) {
  const { db } = ctx.deps;
  const sessionUser = getSessionUser(db, ctx);
  if (!sessionUser) {
    throw makeError(401, 'unauthorized', '请先登录');
  }
  checkLimit(ctx.deps.limiters.readByIp, ctx.ip, '请求太频繁，请稍后再试');

  let limit = parseInt(ctx.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;
  let offset = parseInt(ctx.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const totalRow = db.prepare(
    'SELECT COUNT(*) AS n FROM votes v JOIN users u ON u.id = v.target_user_id WHERE v.voter_user_id = ? AND u.banned = 0'
  ).get(sessionUser.id);
  const total = totalRow ? totalRow.n : 0;

  const rows = db.prepare(
    `SELECT v.id, v.result_mbti, v.created_at, v.invalid,
            u.id AS target_user_id, u.token AS target_token, u.nickname AS target_nickname, u.mbti_self AS target_self
     FROM votes v JOIN users u ON u.id = v.target_user_id
     WHERE v.voter_user_id = ? AND u.banned = 0
     ORDER BY v.id DESC
     LIMIT ? OFFSET ?`
  ).all(sessionUser.id, limit, offset);

  const summaryCache = new Map();
  for (const r of rows) {
    if (!summaryCache.has(r.target_user_id)) {
      summaryCache.set(r.target_user_id, computeSummary(db, { id: r.target_user_id, mbti_self: r.target_self }));
    }
  }

  sendJson(ctx.res, 200, {
    ok: true,
    total,
    votes: rows.map(r => {
      const summary = summaryCache.get(r.target_user_id);
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

// ========== 路由 7：我对某人的评价 ==========
async function getMyVote(ctx) {
  const { db } = ctx.deps;
  checkLimit(ctx.deps.limiters.readByIp, ctx.ip, '请求太频繁，请稍后再试');
  const target = requireActiveUser(db, ctx.params.token);
  const sessionUser = getSessionUser(db, ctx);

  let row = null;
  if (sessionUser) {
    row = db.prepare(
      'SELECT id, result_mbti, created_at, invalid FROM votes WHERE target_user_id = ? AND voter_user_id = ? ORDER BY id DESC LIMIT 1'
    ).get(target.id, sessionUser.id);
  }

  sendJson(ctx.res, 200, {
    ok: true,
    voted: !!row,
    vote: row ? {
      id: row.id,
      your_choice: row.result_mbti,
      your_choice_detail: typeDetail(row.result_mbti),
      created_at: row.created_at,
      invalid: row.invalid === 1
    } : null,
    summary: computeSummary(db, target)
  });
}
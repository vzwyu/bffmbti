// ========== 后端：server/src/routes/vote.js ==========
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

// ========== 前端：web/js/views/visitor.js ==========
    function confirmAlreadyVoted(user, res) {
      // 先把结果页渲染好放在下层，用户点确认直接切过去，不再等一次请求
      var goResult = function () {
        UI.clear(container);
        container.appendChild(buildResultStep(ctx, user, res.vote.your_choice, res.summary));
      };

      var note = res.vote.invalid
        ? '（注意：这条评价已被对方标为失效，不再计入他的统计。）'
        : '';
      var totalVotes = (res.summary && typeof res.summary.total_votes === 'number')
        ? res.summary.total_votes
        : 0;
      UI.modal({
        title: '你之前已经评价过他了',
        sub: '一个人只算一次。你可以看看结果，也可以改掉之前的判断。' + note,
        dismissible: false,
        body: UI.el('div', { class: 'stack' }, [
          UI.el('p', {
            text: '你当时的判断：' + (res.vote.your_choice || '—') +
              '（' + UI.fmtTime(res.vote.created_at) + '）'
          })
        ]),
        actions: [
          {
            label: '去查看结果',
            kind: 'primary',
            onClick: function () { UI.closeModal(); goResult(); }
          },
          {
            label: '去修改',
            kind: 'ghost',
            onClick: function () { UI.closeModal(); enterScale(user, totalVotes); }
          },
          {
            label: '回到主页',
            kind: 'ghost',
            onClick: function () { UI.closeModal(); ctx.navigate('/me'); }
          }
        ]
      });
    }
// ========== 后端：server/src/routes/vote.js ==========
async function setVoteInvalid(ctx) {
  const { db } = ctx.deps;
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
  if (row.target_user_id !== target.id) {
    throw makeError(403, 'forbidden', '无权操作他人的评价');
  }
  if (row.invalid !== want) {
    const tx = db.transaction(() => {
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
    tx();
  }
  sendJson(ctx.res, 200, {
    ok: true,
    vote_id: voteId,
    invalid: want === 1
  });
}

// ========== 前端：web/js/views/profile.js ==========
  function voteItem(v, ctx) {
    try {
      var d = v.detail || {};
      var item = UI.el('div', { class: 'vote-item' });
      if (d.group) item.setAttribute('data-group', d.group);
      var avatar = UI.el('div', { class: 'vote-item__avatar' });
      var abbr = UI.el('span', { text: (v.result_mbti || '').slice(0, 2) });
      abbr.style.color = 'var(--g)';
      avatar.appendChild(abbr);
      var bodyEl = UI.el('div', { class: 'vote-item__body' });
      var nameEl = UI.el('div', { class: 'vote-item__name', text: v.voter_nickname || '匿名' });
      var metaText = '认为你是 ' + (d.cn || v.result_mbti || '') +
        (d.en ? '（' + d.en + '）' : '') + ' · ' + UI.fmtTime(v.created_at);
      if (v.invalid === true) {
        item.className += ' is-invalid';
        nameEl.appendChild(UI.el('span', { class: 'vote-item__badge', text: '已失效' }));
        metaText = '已失效 · ' + metaText;
      }
      bodyEl.appendChild(nameEl);
      bodyEl.appendChild(UI.el('div', { class: 'vote-item__meta', text: metaText }));
      item.appendChild(avatar);
      item.appendChild(bodyEl);
      item.appendChild(UI.el('div', { class: 'vote-item__code', text: v.result_mbti || '' }));

      var hasId = typeof v.id === 'number' && isFinite(v.id) && v.id > 0;
      if (hasId) {
        var busy = false;
        item.addEventListener('click', function () {
          if (busy) return;
          var isInvalid = v.invalid === true;
          UI.confirmDialog({
            title: isInvalid ? '恢复这条评价' : '标记为失效',
            message: isInvalid
              ? '恢复后它会重新计入统计。'
              : '标记后这条评价不再计入统计，你随时可以恢复。',
            confirmText: isInvalid ? '恢复' : '标记失效',
            danger: !isInvalid
          }).then(function (ok) {
            if (!ok) return;
            busy = true;
            API.setVoteInvalid(ctx.store.user.token, v.id, !isInvalid).then(function () {
              busy = false;
              UI.toast(isInvalid ? '已恢复' : '已标记失效', 'success');
              if (ctx && typeof ctx.reloadVotes === 'function') {
                ctx.reloadVotes();
              }
            }, function (err) {
              busy = false;
              UI.toast((err && err.message) || '操作失败', 'error');
            });
          });
        });
      }
      return item;
    } catch (e) {
      UI.toast('操作失败，请刷新重试', 'error');
      return UI.el('div', { class: 'vote-item' });
    }
  }
'use strict';
(function (global) {
  var UI = global.UI;
  var API = global.API;
  var MBTI = global.MBTI;

  // 账号脱敏：邮箱 / 11 位手机号 / 纯数字（历史遗留的 QQ 号账号），后端不给，本地处理
  function maskAccount(acc) {
    if (!acc) return '';
    if (acc.indexOf('@') > 0) {
      var parts = acc.split('@');
      return parts[0].charAt(0) + '***@' + parts.slice(1).join('@');
    }
    if (/^\d{11}$/.test(acc)) return acc.slice(0, 3) + '****' + acc.slice(7);
    if (/^\d+$/.test(acc)) {
      if (acc.length <= 4) return acc.charAt(0) + '***';
      return acc.slice(0, 2) + '***' + acc.slice(-2);
    }
    return acc.charAt(0) + '***';
  }

  function fmtJoinDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function shareLink(token) {
    return location.origin + global.App.BASE_PATH + '/s/' + token;
  }

  // 重新渲染整个视图，优先走 App.render
  function rerender(ctx) {
    if (global.App && typeof global.App.render === 'function') global.App.render();
    else ctx.navigate('/me');
  }

  function refreshStore(ctx) {
    return Promise.resolve(ctx.store.refresh()).catch(function () { /* 刷新失败不阻塞 */ });
  }

  function errMsg(err, fallback) {
    return (err && err.message) ? err.message : fallback;
  }

  function profile(ctx) {
    if (!ctx.store.isLoggedIn()) {
      var empty = UI.empty('🔒', '请先登录', '登录后才能查看你的主页');
      var goBtn = UI.el('button', { class: 'btn btn--primary', type: 'button', text: '去登录' });
      goBtn.addEventListener('click', function () { ctx.navigate('/login'); });
      empty.appendChild(goBtn);
      return empty;
    }
    var page = UI.el('div', { class: 'page page--narrow section stack' });
    page.appendChild(buildHeader(ctx));
    page.appendChild(buildMbti(ctx));
    page.appendChild(buildProfile(ctx));
    page.appendChild(buildPassword(ctx));
    page.appendChild(buildSummary(ctx));
    page.appendChild(buildAccount(ctx));
    return page;
  }

  /* ---------- 区块 1 · 头部 ---------- */
  function buildHeader(ctx) {
    var user = ctx.store.user;
    var wrap = UI.el('section', { class: 'stack' });
    var row = UI.el('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'flex-start';
    row.style.gap = '12px';
    row.style.flexWrap = 'wrap';

    var left = UI.el('div', { class: 'stack' });
    left.appendChild(UI.el('h1', { text: (user.nickname || '') + ' 的主页' }));
    var joined = fmtJoinDate(user.created_at);
    if (joined) left.appendChild(UI.el('p', { class: 'muted', text: '加入于 ' + joined }));

    var logoutBtn = UI.el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: '退出登录' });
    logoutBtn.addEventListener('click', function () { doLogout(ctx, logoutBtn); });

    row.appendChild(left);
    row.appendChild(logoutBtn);
    wrap.appendChild(row);
    return wrap;
  }

  /**
   * 退出登录。
   * 注意：按钮**不能**用 .btn--quiet —— 那是"透明背景+透明边框+灰字"，
   * 在白底页面上等于隐形（用户反馈"主页里没有退出按钮"就是这个原因）。
   * 这里统一用 .btn--ghost（有边框、有对比度），头尾两处入口共用本函数。
   */
  function doLogout(ctx, btn) {
    UI.confirmDialog({
      title: '退出登录',
      message: '确定要退出登录吗？退出后需要重新输入账号和密码才能进来看评价。',
      confirmText: '退出登录',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      UI.withLoading(btn, function () {
        // 接口失败也允许本地退出：会话只是"记住登录"，清干净即可
        return API.logout().catch(function () {}).then(function () {
          ctx.store.clear();
          ctx.navigate('/');
        });
      });
    });
  }

  /* ---------- 区块 7 · 账号（页面底部，退出登录主入口） ---------- */
  function buildAccount(ctx) {
    var card = UI.el('section', { class: 'card card--pad-lg stack' });
    card.appendChild(UI.el('h2', { text: '账号' }));
    var user = ctx.store.user;
    card.appendChild(UI.el('p', {
      class: 'muted',
      text: '当前登录：' + maskAccount(user.login_account || '')
    }));

    var btn = UI.el('button', { class: 'btn btn--ghost btn--block', type: 'button', text: '退出登录' });
    btn.addEventListener('click', function () { doLogout(ctx, btn); });
    card.appendChild(btn);
    return card;
  }

  /* ---------- 区块 2 · 我的 MBTI ---------- */
  function buildMbti(ctx) {
    var user = ctx.store.user;
    var wrap = UI.el('section', { class: 'stack' });
    wrap.appendChild(UI.el('h2', { text: '我的 MBTI' }));

    // MBTI.get 可能返回 null，需判空
    var type = user.mbti_self ? MBTI.get(user.mbti_self) : null;

    if (type) {
      var box = UI.el('div', { class: 'stack' });
      box.setAttribute('data-group', type.group);
      box.appendChild(UI.persona(type));
      var code = UI.el('div', { text: type.code });
      code.style.fontSize = '28px';
      code.style.fontWeight = '700';
      code.style.color = type.color || 'var(--g)';
      box.appendChild(code);
      box.appendChild(UI.el('div', { text: type.cn + ' · ' + type.en }));
      if (type.tagline) box.appendChild(UI.el('p', { class: 'muted', text: type.tagline }));
      wrap.appendChild(box);

      // 修改入口：是否能改、按钮文案都由后端决定
      var editBtn = UI.el('button', { class: 'btn', type: 'button', text: '加载中…' });
      editBtn.disabled = true;
      var note = UI.el('p', { class: 'muted' });
      note.style.display = 'none';

      // 「生成分享链接」与修改按钮并排；窄屏自动换行到下一行（见下方 flexWrap）
      var actionRow = shareEntryRow(ctx, editBtn);
      wrap.appendChild(actionRow);
      wrap.appendChild(note);

      API.mbtiPermission().then(function (res) {
        editBtn.textContent = res.label || '修改人格类型';
        if (res.can_edit) {
          editBtn.disabled = false;
          editBtn.addEventListener('click', function () { openMbtiModal(ctx); });
        } else {
          note.textContent = '修改机会已用完，类型不可再改。如果确实选错了，请联系管理员。';
          note.style.display = '';
        }
      }).catch(function (err) {
        editBtn.textContent = '修改人格类型';
        UI.toast(errMsg(err, '加载修改权限失败'), 'error');
      });
    } else {
      wrap.appendChild(UI.el('p', { text: '还没选择你的类型' }));
      var pickBtn = UI.el('button', { class: 'btn btn--primary', type: 'button', text: '去选择' });
      pickBtn.addEventListener('click', function () { ctx.navigate('/'); });
      wrap.appendChild(pickBtn);
    }
    return wrap;
  }

  // 修改类型弹窗：选新类型 + 密码确认
  function openMbtiModal(ctx) {
    var user = ctx.store.user;
    var selected = user.mbti_self || null;

    var body = UI.el('div', { class: 'stack' });
    body.appendChild(UI.alertBox('warn', '人格类型原则上只能修改一次，且需要输入密码。修改后，所有分享链接展示的都会是新类型。'));

    var grid = UI.el('div', { class: 'types-grid' });
    var cards = [];
    MBTI.TYPES.forEach(function (t) {
      var card = UI.el('button', { class: 'type-card', type: 'button' });
      card.setAttribute('data-group', t.group);
      card.appendChild(UI.persona(t));
      card.appendChild(UI.el('div', { class: 'type-card__code', text: t.code }));
      card.appendChild(UI.el('div', { class: 'type-card__cn', text: t.cn }));
      card.appendChild(UI.el('div', { class: 'type-card__en', text: t.en }));
      card.appendChild(UI.el('div', { class: 'type-card__check' }));
      if (t.code === selected) card.classList.add('is-selected');
      card.addEventListener('click', function () {
        if (selected === t.code) {
          // 再点已选中的项则取消选中
          selected = null;
          card.classList.remove('is-selected');
        } else {
          selected = t.code;
          cards.forEach(function (c) { c.classList.remove('is-selected'); });
          card.classList.add('is-selected');
        }
        sync();
      });
      cards.push(card);
      grid.appendChild(card);
    });
    body.appendChild(grid);

    var pw = UI.field({
      id: 'mbti-pw',
      label: '输入密码确认',
      pin: true,
      inputmode: 'numeric',
      maxlength: 4,
      required: true,
      hint: '4 位数字密码'
    });
    body.appendChild(pw.el);

    var actions = UI.el('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'flex-end';
    var cancelBtn = UI.el('button', { class: 'btn btn--quiet', type: 'button', text: '取消' });
    cancelBtn.addEventListener('click', function () { UI.closeModal(); });
    var okBtn = UI.el('button', { class: 'btn btn--primary', type: 'button', text: '确认修改' });
    okBtn.disabled = true;
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    body.appendChild(actions);

    function sync() {
      okBtn.disabled = !(selected && pw.input.value.length === 4);
    }

    pw.input.addEventListener('input', function () {
      pw.input.value = pw.input.value.replace(/\D/g, '').slice(0, 4);
      pw.clearError();
      sync();
    });

    okBtn.addEventListener('click', function () {
      UI.withLoading(okBtn, function () {
        return API.setMbti(selected, pw.input.value).then(function () {
          UI.closeModal();
          return refreshStore(ctx);
        }).then(function () {
          UI.toast('已更新，分享链接里的类型同步变了', 'success');
          rerender(ctx);
        }).catch(function (err) {
          UI.toast(errMsg(err, '修改失败'), 'error');
          if (err && err.code === 'bad_password') pw.setError('密码错误');
        });
      });
    });

    UI.modal({ title: '修改人格类型', body: body, dismissible: false });
  }

  /* ---------- 区块 3 · 基本资料 ---------- */
  function buildProfile(ctx) {
    var user = ctx.store.user;
    var card = UI.el('section', { class: 'card card--pad-lg stack' });
    card.appendChild(UI.el('h2', { text: '基本资料' }));

    var nick = UI.field({
      id: 'pf-nick',
      label: '称呼',
      hint: '最长 32 个汉字或 64 个英文字符',
      value: user.nickname || ''
    });
    card.appendChild(nick.el);

    // 历史数据可能是 other，统一视为未选中；界面只提供三项
    var genderInit = (user.gender === 'male' || user.gender === 'female' || user.gender === 'unset') ? user.gender : null;
    var genderCur = genderInit;
    card.appendChild(UI.el('label', { text: '性别（选填）' }));
    card.appendChild(UI.segmented([
      { label: '男', value: 'male' },
      { label: '女', value: 'female' },
      { label: '暂不填写', value: 'unset' }
    ], genderInit, function (v) {
      genderCur = v;
      sync();
    }));
    card.appendChild(UI.el('p', { class: 'muted', text: '不填不影响任何功能' }));

    card.appendChild(UI.field({
      id: 'pf-account',
      label: '登录账号',
      readonly: true,
      value: maskAccount(user.login_account || ''),
      hint: '登录账号不可修改'
    }).el);

    var saveBtn = UI.el('button', { class: 'btn btn--block', type: 'button', text: '保存修改' });
    saveBtn.disabled = true;
    card.appendChild(saveBtn);

    // 仅当相对初始值发生变化时才启用
    function sync() {
      var changed = nick.input.value !== (user.nickname || '') || genderCur !== genderInit;
      saveBtn.disabled = !changed;
    }

    nick.input.addEventListener('input', function () {
      nick.clearError();
      sync();
    });

    saveBtn.addEventListener('click', function () {
      var payload = {};
      if (nick.input.value !== (user.nickname || '')) payload.nickname = nick.input.value;
      if (genderCur !== genderInit) payload.gender = genderCur === null ? 'unset' : genderCur;
      UI.withLoading(saveBtn, function () {
        return API.updateProfile(payload).then(function () {
          return refreshStore(ctx);
        }).then(function () {
          UI.toast('已保存', 'success');
          rerender(ctx);
        }).catch(function (err) {
          UI.toast(errMsg(err, '保存失败'), 'error');
          if (err && err.code === 'invalid_nickname') nick.setError(err.message || '称呼不符合要求');
        });
      });
    });

    return card;
  }

  /* ---------- 区块 4 · 修改密码 ---------- */
  function buildPassword(ctx) {
    var card = UI.el('section', { class: 'card card--pad-lg stack' });
    card.appendChild(UI.el('h2', { text: '修改密码' }));

    var oldF = UI.field({ id: 'pw-old', label: '原密码', pin: true, inputmode: 'numeric', maxlength: 4 });
    var newF = UI.field({ id: 'pw-new', label: '新密码', pin: true, inputmode: 'numeric', maxlength: 4 });
    var conF = UI.field({ id: 'pw-confirm', label: '确认新密码', pin: true, inputmode: 'numeric', maxlength: 4 });
    card.appendChild(oldF.el);
    card.appendChild(newF.el);
    card.appendChild(conF.el);

    var saveBtn = UI.el('button', { class: 'btn btn--block', type: 'button', text: '保存' });
    saveBtn.disabled = true;
    card.appendChild(saveBtn);

    function sync() {
      var o = oldF.input.value, n = newF.input.value, c = conF.input.value;
      if (n.length === 4 && c.length === 4 && n !== c) conF.setError('两次输入的新密码不一致');
      else conF.clearError();
      saveBtn.disabled = !(o.length === 4 && n.length === 4 && c.length === 4 && n === c);
    }

    [oldF, newF, conF].forEach(function (f) {
      f.input.addEventListener('input', function () {
        f.input.value = f.input.value.replace(/\D/g, '').slice(0, 4);
        f.clearError();
        sync();
      });
    });

    saveBtn.addEventListener('click', function () {
      UI.withLoading(saveBtn, function () {
        return API.changePassword(oldF.input.value, newF.input.value).then(function () {
          oldF.input.value = '';
          newF.input.value = '';
          conF.input.value = '';
          conF.clearError();
          sync();
          UI.toast('密码已更新，请用新密码登录', 'success');
        }).catch(function (err) {
          UI.toast(errMsg(err, '修改失败'), 'error');
          if (err && err.code === 'bad_old_password') oldF.setError(err.message || '原密码错误');
          else if (err && err.code === 'same_password') newF.setError(err.message || '新密码不能与原密码相同');
        });
      });
    });

    return card;
  }

  /* ---------- 区块 5 · 大多数人认为你是 ---------- */
  function buildSummary(ctx) {
    var wrap = UI.el('section', { class: 'stack' });
    wrap.appendChild(UI.el('h2', { text: '大多数人认为你是' }));
    var loading = UI.el('p', { class: 'muted', text: '加载中…' });
    wrap.appendChild(loading);

    API.summary(ctx.store.user.token).then(function (res) {
      wrap.removeChild(loading);
      renderSummary(ctx, wrap, res.summary);
    }).catch(function (err) {
      if (loading.parentNode) wrap.removeChild(loading);
      wrap.appendChild(UI.alertBox('error', errMsg(err, '评价数据加载失败')));
    });

    return wrap;
  }

  function renderSummary(ctx, wrap, s) {
    if (!s || !s.total_votes) {
      wrap.appendChild(UI.empty('👀', '还没有人评价你', '把主页链接发给朋友，看看他们眼中的你'));
      wrap.appendChild(shareEntryBtn('生成分享链接', ctx));
      // 即便没人评价过我，我也可能评价过别人 —— 这个入口要一直在
      var onlyGivenRow = UI.el('div', { class: 'row row--wrap' });
      onlyGivenRow.appendChild(givenVotesBtn(ctx));
      wrap.appendChild(onlyGivenRow);
      return;
    }

    // 汇总数据全部用后端算好的，本地不重算
    var line = '共 ' + s.total_votes + ' 位朋友评价';
    if (s.majority_mbti) {
      var mt = MBTI.get(s.majority_mbti);
      line += '，大多数人认为你是 ' + s.majority_mbti + (mt ? ' · ' + mt.cn : '');
    }
    wrap.appendChild(UI.el('p', { text: line }));

    if (s.low_sample) wrap.appendChild(UI.alertBox('info', '评价人数还少，结果仅供参考。'));

    // 偏差摘要：轴中文名从 summary.axes 里取，不硬编码
    var dv = s.divergence_axes || [];
    if (dv.length === 0) {
      wrap.appendChild(UI.alertBox('success', '朋友们的印象和你自己的认知完全一致。'));
    } else {
      var axes = s.axes || [];
      var parts = [];
      dv.forEach(function (d) {
        var key = typeof d === 'string' ? d : (d && d.key);
        var ax = null;
        axes.forEach(function (a) { if (a.key === key) ax = a; });
        if (!ax && d && d.leftCn) ax = d;
        if (!ax) return;
        parts.push(ax.leftCn + ' ' + ax.left + ' ／ ' + ax.rightCn + ' ' + ax.right +
          '（多数人认为 ' + ax.majority + '，你认为 ' + ax.selfChoice + '）');
      });
      wrap.appendChild(UI.alertBox('warn',
        dv.length + ' 个维度上，朋友的印象和你自己的认知不同：' + parts.join('；')));
    }

    var barsCard = UI.el('div', { class: 'card card--pad-lg stack' });
    barsCard.appendChild(UI.el('h3', { text: '朋友们的具体选择' }));
    barsCard.appendChild(UI.axisVoteBars(s.axes || []));
    wrap.appendChild(barsCard);

    var detailBtn = UI.el('button', { class: 'btn', type: 'button', text: '查看评价明细' });
    detailBtn.addEventListener('click', function () {
      UI.withLoading(detailBtn, function () {
        return API.listVotes(ctx.store.user.token, 50, 0).then(function (res) {
          showVotesModal(ctx, res);
        }).catch(function (err) {
          UI.toast(errMsg(err, '评价明细加载失败'), 'error');
        });
      });
    });
    // 「查看评价明细」与「查看我对他人的评价」并排，窄屏自动换行
    var actionRow = UI.el('div', { class: 'row row--wrap' });
    actionRow.appendChild(detailBtn);
    actionRow.appendChild(givenVotesBtn(ctx));
    wrap.appendChild(actionRow);
  }

  /** 「查看我对他人的评价」入口 */
  function givenVotesBtn(ctx) {
    var b = UI.el('button', { class: 'btn btn--ghost', type: 'button', text: '查看我对他人的评价' });
    b.addEventListener('click', function () { openGivenVotesModal(ctx); });
    return b;
  }

  /**
   * 我发给别人的评价列表。
   * 每条卡片一句话讲清三方视角：
   *   我认为【他】是 X，大多数人认为【他】是 Y，【他】认为自己是 Z
   */
  function openGivenVotesModal(ctx) {
    var body = UI.el('div', { class: 'stack' });
    var hint = UI.el('p', { class: 'muted', text: '加载中…' });
    var list = UI.el('div', { class: 'vote-list' });
    body.appendChild(hint);
    body.appendChild(list);

    API.myVotesGiven(50, 0).then(function (res) {
      var votes = (res && res.votes) || [];
      if (!votes.length) {
        hint.textContent = '';
        body.removeChild(hint);
        body.appendChild(UI.empty('💬', '你还没有评价过别人', '去朋友的分享链接里给他们评一评'));
        return;
      }
      hint.textContent = '共 ' + (res.total || votes.length) + ' 条，最新在前。点名字可以打开他的分享页。';
      votes.forEach(function (v) { list.appendChild(givenVoteItem(ctx, v)); });
    }).catch(function (err) {
      hint.textContent = '';
      body.removeChild(hint);
      body.appendChild(UI.alertBox('error', errMsg(err, '加载失败')));
    });

    UI.modal({
      title: '我对他人的评价',
      body: body,
      dismissible: true
    });
  }

  function givenVoteItem(ctx, v) {
    var item = UI.el('div', { class: 'vote-item' });
    var d = v.my_choice_detail || {};
    if (d.group) item.setAttribute('data-group', d.group);

    var avatar = UI.el('div', { class: 'vote-item__avatar' });
    var abbr = UI.el('span', { text: (v.my_choice || '').slice(0, 2) });
    abbr.style.color = 'var(--g)';
    avatar.appendChild(abbr);

    var bodyEl = UI.el('div', { class: 'vote-item__body' });

    // 名字做成可点的链接，直接去他的分享页
    var nameEl = UI.el('div', { class: 'vote-item__name' });
    var nameLink = UI.el('a', {
      text: v.target_nickname || '匿名',
      href: global.App.BASE_PATH + '/s/' + v.target_token,
      style: { color: 'inherit', textDecoration: 'underline' }
    });
    nameLink.addEventListener('click', function (e) {
      e.preventDefault();
      UI.closeModal();
      ctx.navigate('/s/' + v.target_token);
    });
    nameEl.appendChild(nameLink);
    bodyEl.appendChild(nameEl);

    var who = v.target_nickname || '他';
    var mine = v.my_choice || '—';
    var maj = v.target_majority
      ? '大多数人认为' + who + '是 ' + v.target_majority
      : '大多数人还没有一致看法';
    var self = v.target_self
      ? who + '认为自己是 ' + v.target_self
      : who + '还没选择自己的类型';

    bodyEl.appendChild(UI.el('div', {
      class: 'vote-item__meta',
      text: '我认为' + who + '是 ' + mine + '，' + maj + '，' + self
    }));
    bodyEl.appendChild(UI.el('div', {
      class: 'vote-item__meta',
      text: UI.fmtTime(v.created_at)
    }));

    item.appendChild(avatar);
    item.appendChild(bodyEl);
    item.appendChild(UI.el('div', { class: 'vote-item__code', text: v.my_choice || '' }));
    return item;
  }

  /* ---------- 区块 8 · 分享链接 ---------- */
  /* 分享入口。链接来自 user.token —— 那是注册时生成、此后永不改变的公开标识，
     所以链接天然固定：不需要"生成"，也没有"重新生成"这回事，
     这里只负责让用户看到并复制。 */
  function shareEntryBtn(text, ctx) {
    var b = UI.el('button', { class: 'btn btn--ghost', type: 'button', text: text });
    b.addEventListener('click', function () { openShareModal(ctx); });
    return b;
  }

  function shareEntryRow(ctx, firstBtn) {
    var row = UI.el('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.flexWrap = 'wrap';
    row.style.alignItems = 'center';
    row.appendChild(firstBtn);
    row.appendChild(shareEntryBtn('生成分享链接', ctx));
    return row;
  }

  // —— 以下 openShareModal 由 Kimi K3 按 _dev/spec-share-modal.md 生成，
  //    经红线静态审查（ES6 语法 / innerHTML / 硬编码色值 / token 赋值 全过）
  //    与契约核对（UI.el 的 onclick 走 addEventListener、readonly:true 走 setAttribute）。
  // ---------- 区块 8 · 分享链接（弹窗） ----------
  function openShareModal(ctx) {
    try {
      var user = ctx && ctx.store ? ctx.store.user : null;
      var token = user ? user.token : null;
      if (!token) {
        UI.toast('暂时取不到你的分享链接，请刷新重试', 'error');
        return;
      }
      var link = shareLink(token);

      // 分享面板（UI.sharePanel）同时提供「复制整句」和「仅复制链接」两种，
      // 整句文案：你觉得【我的称呼】的MBTI是什么：【链接】
      var body = UI.el('div', { class: 'stack' }, [
        UI.alertBox('info', '这个链接是固定的，改过人格类型后还是同一个链接，之前发过的不用重发。'),
        UI.sharePanel({ nickname: user.nickname, link: link }),
        UI.el('p', { class: 'muted', text: '「复制」复制的是整句文案，直接发给朋友就行；只想发链接就点「仅复制链接」。' })
      ]);

      UI.modal({
        title: '你的专属链接',
        body: body,
        dismissible: true
      });
    } catch (e) {
      UI.toast('打开分享链接失败，请刷新重试', 'error');
    }
  }

  /* ---------- 区块 6 · 评价明细（弹窗） ---------- */
  // 注意：这里**不用** UI.confirmDialog 做二次确认。
  // UI.modal() 的第一行就是 closeModal()，弹确认框会把明细弹窗整个顶掉，
  // 用户确认完就没法接着操作了。所以改成按钮上的「行内二次确认」：
  // 破坏方向第一下变成「确认失效？」，4 秒内再点一下才真正执行。
  function showVotesModal(ctx, first) {
    var body = UI.el('div', { class: 'stack' });
    var hint = UI.el('p', { class: 'muted' });
    var list = UI.el('div', { class: 'vote-list' });
    var moreSlot = UI.el('div');
    body.appendChild(hint);
    body.appendChild(list);
    body.appendChild(moreSlot);

    var total = 0;
    var loaded = 0;
    var emptyNode = null;

    // 传给 voteItem 的 ctx：多一个 reloadVotes，操作成功后原地重建列表
    var itemCtx = {
      store: ctx.store,
      navigate: ctx.navigate,
      reloadVotes: function () { reload(); }
    };

    function paintHint(res) {
      var t = (res && typeof res.total === 'number') ? res.total : total;
      var inv = (res && typeof res.invalid_total === 'number') ? res.invalid_total : 0;
      hint.textContent = '共 ' + t + ' 条' +
        (inv ? '（其中 ' + inv + ' 条已失效，不计入统计）' : '') + '，最新在前';
    }

    function render(res) {
      total = (res && typeof res.total === 'number') ? res.total : 0;
      var vs = (res && res.votes) || [];
      loaded = vs.length;

      UI.clear(list);
      UI.clear(moreSlot);
      if (emptyNode && emptyNode.parentNode) emptyNode.parentNode.removeChild(emptyNode);
      emptyNode = null;

      if (total === 0) {
        emptyNode = UI.empty('📭', '还没有评价', '把链接发给朋友吧');
        body.appendChild(emptyNode);
        paintHint(res);
        return;
      }

      vs.forEach(function (v) { list.appendChild(voteItem(v, itemCtx)); });
      paintHint(res);

      if (loaded < total) {
        var moreBtn = UI.el('button', { class: 'btn btn--block', type: 'button', text: '加载更多' });
        moreSlot.appendChild(moreBtn);
        moreBtn.addEventListener('click', function () {
          moreBtn.classList.add('is-loading');
          moreBtn.disabled = true;
          API.listVotes(ctx.store.user.token, 50, loaded).then(function (r2) {
            var more = (r2 && r2.votes) || [];
            more.forEach(function (v) { list.appendChild(voteItem(v, itemCtx)); });
            loaded += more.length;
            if (r2 && typeof r2.total === 'number') total = r2.total;
            paintHint(r2);
            moreBtn.classList.remove('is-loading');
            moreBtn.disabled = false;
            // 已全部加载完则按钮消失
            if (loaded >= total && moreBtn.parentNode) moreBtn.parentNode.removeChild(moreBtn);
          }).catch(function (err) {
            moreBtn.classList.remove('is-loading');
            moreBtn.disabled = false;
            UI.toast(errMsg(err, '加载失败'), 'error');
          });
        });
      }
    }

    // 操作成功后原地重建：回到第 0 页，但取回已加载过的条数，保持用户的浏览位置
    function reload() {
      var want = Math.min(Math.max(loaded, 50), 200);
      API.listVotes(ctx.store.user.token, want, 0).then(render).catch(function (err) {
        UI.toast(errMsg(err, '刷新失败'), 'error');
      });
    }

    render(first);
    UI.modal({
      title: '评价明细',
      subtitle: '点某一条右侧的按钮可标为失效或恢复',
      body: body,
      dismissible: true
    });
  }

  function voteItem(v, ctx) {
    try {
      var d = v.detail || {};
      var isInvalid = v.invalid === true;
      var actLabel = isInvalid ? '恢复' : '标为失效';

      var item = UI.el('div', { class: 'vote-item' });
      if (d.group) item.setAttribute('data-group', d.group);
      if (isInvalid) item.className += ' is-invalid';

      // 明细里不用 persona，只放代码前两位
      var avatar = UI.el('div', { class: 'vote-item__avatar' });
      var abbr = UI.el('span', { text: (v.result_mbti || '').slice(0, 2) });
      abbr.style.color = 'var(--g)';
      avatar.appendChild(abbr);

      var bodyEl = UI.el('div', { class: 'vote-item__body' });
      // 昵称允许 emoji 与超长，交给 CSS 省略，必须用 text
      var nameEl = UI.el('div', { class: 'vote-item__name', text: v.voter_nickname || '匿名' });
      if (isInvalid) {
        nameEl.appendChild(UI.el('span', { class: 'vote-item__badge', text: '已失效' }));
      }
      bodyEl.appendChild(nameEl);

      var meta = (isInvalid ? '已失效 · ' : '') + '认为你是 ' + (d.cn || v.result_mbti || '') +
        (d.en ? '（' + d.en + '）' : '') + ' · ' + UI.fmtTime(v.created_at);
      bodyEl.appendChild(UI.el('div', { class: 'vote-item__meta', text: meta }));

      var right = UI.el('div', { class: 'vote-item__right' });
      right.appendChild(UI.el('div', { class: 'vote-item__code', text: v.result_mbti || '' }));

      // 老数据可能没有 id，那就只展示、不给操作入口，也不报错
      var hasId = typeof v.id === 'number' && isFinite(v.id) && v.id > 0;
      if (hasId) {
        var busy = false;
        var armed = false;
        var armTimer = null;
        var actBtn = UI.el('button', { class: 'vote-item__act', type: 'button', text: actLabel });

        function disarm() {
          armed = false;
          if (armTimer) { clearTimeout(armTimer); armTimer = null; }
          actBtn.textContent = actLabel;
          actBtn.classList.remove('is-armed');
        }

        actBtn.addEventListener('click', function () {
          if (busy) return;
          // 恢复是安全方向，一点即执行；失效是破坏方向，要二次确认
          if (!isInvalid && !armed) {
            armed = true;
            actBtn.textContent = '确认失效？';
            actBtn.classList.add('is-armed');
            armTimer = setTimeout(disarm, 4000);
            return;
          }
          if (armTimer) { clearTimeout(armTimer); armTimer = null; }
          busy = true;
          actBtn.disabled = true;
          actBtn.textContent = '处理中…';
          API.setVoteInvalid(ctx.store.user.token, v.id, !isInvalid).then(function () {
            busy = false;
            UI.toast(isInvalid ? '已恢复，重新计入统计' : '已标记失效，不再计入统计', 'success');
            if (ctx && typeof ctx.reloadVotes === 'function') ctx.reloadVotes();
          }).catch(function (err) {
            busy = false;
            actBtn.disabled = false;
            disarm();
            UI.toast(errMsg(err, '操作失败'), 'error');
          });
        });

        right.appendChild(actBtn);
      }

      item.appendChild(avatar);
      item.appendChild(bodyEl);
      item.appendChild(right);
      return item;
    } catch (e) {
      // 单条渲染失败不能拖垮整个明细；返回一个占位条
      return UI.el('div', { class: 'vote-item' });
    }
  }

  global.Views = global.Views || {};
  global.Views.profile = profile;
})(typeof window !== 'undefined' ? window : this);
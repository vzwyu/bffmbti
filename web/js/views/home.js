'use strict';
(function (global) {
  var UI = global.UI;
  var API = global.API;
  var MBTI = global.MBTI;

  // 挂载前缀，用于拼完整分享链接
  function basePath() {
    return (global.App && global.App.BASE_PATH) || '';
  }

  /* ---------- 注册弹窗（状态 1） ---------- */
  function openRegisterModal(ctx, onSuccess) {
    var fNickname = UI.field({
      id: 'reg-nickname',
      label: '我该如何称呼您？',
      type: 'text',
      placeholder: '你的称呼',
      hint: '最长 32 个汉字或 64 个英文字符',
      required: true,
      maxlength: 64,
      autocomplete: 'nickname'
    });
    var fAccount = UI.field({
      id: 'reg-account',
      label: '邮箱 / 手机号',
      type: 'text',
      placeholder: '用于日后登录',
      hint: '换设备登录时用它',
      required: true,
      autocomplete: 'username'
    });
    var fPassword = UI.field({
      id: 'reg-password',
      label: '4 位数字密码',
      type: 'password',
      placeholder: '4 位数字',
      hint: '请勿与银行卡密码等其他密码一致',
      required: true,
      pin: true,
      inputmode: 'numeric',
      maxlength: 4,
      autocomplete: 'new-password'
    });

    // 重新输入时清除错误态
    fNickname.input.addEventListener('input', function () { fNickname.clearError(); });
    fAccount.input.addEventListener('input', function () { fAccount.clearError(); });
    // 密码只收数字，最长 4 位
    fPassword.input.addEventListener('input', function () {
      fPassword.input.value = fPassword.input.value.replace(/\D/g, '').slice(0, 4);
      fPassword.clearError();
    });

    var submitBtn = UI.el('button', {
      class: 'btn btn--lg btn--block',
      type: 'button',
      text: '创建并开始选择'
    });

    // 已有账号的入口，放在主按钮正下方
    var toLoginBtn = UI.el('button', {
      class: 'btn btn--ghost btn--block',
      type: 'button',
      text: '已有账号？去登录',
      style: { marginTop: 'var(--sp-3,12px)' }
    });
    toLoginBtn.addEventListener('click', function () {
      UI.closeModal();
      ctx.navigate('/login');
    });

    submitBtn.addEventListener('click', function () {
      var nickname = fNickname.input.value.trim();
      var account = fAccount.input.value.trim();
      var password = fPassword.input.value;

      // 前端基本校验，不通过则定位到具体字段，不发请求
      var bad = false;
      if (!nickname) { fNickname.setError('请填写你的称呼'); bad = true; }
      if (!account) { fAccount.setError('请填写邮箱或手机号'); bad = true; }
      if (!/^\d{4}$/.test(password)) { fPassword.setError('密码须为 4 位数字'); bad = true; }
      if (bad) return;

      UI.withLoading(submitBtn, function () {
        return API.register(nickname, account, password).then(function (res) {
          if (!res || !res.ok) throw new Error('注册失败，请稍后重试');
          ctx.store.set(res.user);
          UI.closeModal();
          // 找回码功能已关闭：不再展示找回码，注册完直接进入选择
          onSuccess();
        }).catch(function (err) {
          var msg = (err && err.message) || '提交失败，请稍后重试';
          // 账号占用类错误定位到账号字段
          if (err && (err.code === 'ACCOUNT_TAKEN' || /账号/.test(msg))) {
            fAccount.setError(msg);
          }
          UI.toast(msg, 'error');
        });
      });
    });

    UI.modal({
      title: '先认识一下',
      sub: '填写后即可创建你自己的测试页，并把它分享给朋友。',
      dismissible: false,
      body: [
        fNickname.wrap,
        fAccount.wrap,
        fPassword.wrap,
        UI.alertBox('warn', '我们买不起短信验证／邮箱验证服务，因此请务必妥善保存登录账号和密码。'),
        UI.el('p', {
          class: 'form-privacy',
          style: { color: '#888', fontSize: '12px', margin: '8px 0 0' },
          text: '收集这些信息仅用于让你日后登录查看自己的测试结果，我们不会使用、也不会主动泄露你的任何个人信息。'
        })
      ],
      actions: [submitBtn, toLoginBtn]
    });
  }

  /* ---------- 16 型选择网格（状态 2） ---------- */
  function renderTypesGrid(ctx, onSubmitted) {
    var selected = null; // 当前选中的类型 code

    var submitBtn = UI.el('button', {
      class: 'btn btn--lg btn--block',
      type: 'button',
      text: '提交并分享',
      disabled: true
    });

    // MBTI.TYPES 顺序即 4×4 网格顺序
    var cards = MBTI.TYPES.map(function (type) {
      var card = UI.el('button', {
        type: 'button',
        class: 'type-card',
        dataset: { group: type.group },
        'aria-pressed': 'false'
      }, [
        UI.persona(type),
        UI.el('div', { class: 'type-card__code', text: type.code }),
        UI.el('div', { class: 'type-card__cn', text: type.cn }),
        UI.el('div', { class: 'type-card__en', text: type.en }),
        UI.el('span', { class: 'type-card__check', text: '✓' })
      ]);

      card.addEventListener('click', function () {
        // 再点已选中的卡片 → 取消选中
        if (card.getAttribute('aria-pressed') === 'true') {
          card.setAttribute('aria-pressed', 'false');
          selected = null;
          submitBtn.disabled = true;
          return;
        }
        // 单选：先清空全部，再选中自己
        cards.forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
        card.setAttribute('aria-pressed', 'true');
        selected = type.code;
        submitBtn.disabled = false;
      });

      return card;
    });

    submitBtn.addEventListener('click', function () {
      if (!selected) return;
      UI.withLoading(submitBtn, function () {
        return API.setMbti(selected).then(function (res) {
          if (!res || !res.ok) throw new Error('提交失败，请稍后重试');
          return Promise.resolve(ctx.store.refresh());
        }).then(function () {
          UI.toast('已生成你的专属链接', 'success');
          onSubmitted();
        }).catch(function (err) {
          UI.toast((err && err.message) || '提交失败，请稍后重试', 'error');
        });
      });
    });

    return UI.el('div', { class: 'home-chooser' }, [
      UI.el('p', { class: 'types-grid__hint', text: '选一个最像你的类型。不用纠结，之后还能改一次。' }),
      UI.el('div', { class: 'types-grid' }, cards),
      submitBtn,
      UI.el('p', {
        class: 'types-grid__privacy',
        style: { color: '#888', fontSize: '12px', margin: '10px 0 0', textAlign: 'center' },
        text: '我们会把你的选择存下来，生成一个只有拿到链接的人才能看到你称呼的页面。'
      })
    ]);
  }

  /* ---------- 分享页（状态 3） ---------- */
  function renderSharePage(ctx) {
    var user = ctx.store.user;
    var token = ctx.store.shareToken() || (user && user.token);
    var type = user ? MBTI.get(user.mbti_self) : null;
    var url = location.origin + basePath() + '/s/' + token;

    var urlInput = UI.el('input', {
      class: 'share-box__url',
      type: 'text',
      readonly: true,
      value: url
    });
    urlInput.addEventListener('click', function () { urlInput.select(); });

    var copyBtn = UI.el('button', { class: 'btn', type: 'button', text: '复制' });
    copyBtn.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () {
          UI.toast('链接已复制', 'success');
        }).catch(function () {
          UI.toast('复制失败，请长按选中链接手动复制', 'error');
        });
      } else {
        UI.toast('复制失败，请长按选中链接手动复制', 'error');
      }
    });

    var meBtn = UI.el('button', {
      class: 'btn btn--lg btn--block',
      type: 'button',
      text: '查看我的主页'
    });
    meBtn.addEventListener('click', function () { ctx.navigate('/me'); });

    var reBtn = UI.el('button', {
      class: 'btn btn--ghost btn--block',
      type: 'button',
      text: '看起来不错，再改一次类型'
    });
    reBtn.addEventListener('click', function () {
      // 后端只允许改一次且需要密码，首页不直接改，引导到个人主页
      UI.toast('修改类型需要输入密码，请到个人主页操作');
      ctx.navigate('/me');
    });

    var children = [
      UI.el('h1', { class: 'share-title', text: '你的专属链接已生成' }),
      UI.el('p', { class: 'share-sub', text: '把它发给朋友，看看他们眼中的你是什么样。' }),
      UI.el('div', { class: 'share-box' }, [urlInput, copyBtn]),
      meBtn,
      reBtn
    ];

    // 自己的类型卡片，data-group 让主题色生效
    if (type) {
      children.push(UI.el('div', {
        class: 'share-mine type-card',
        dataset: { group: type.group }
      }, [
        UI.persona(type),
        UI.el('div', { class: 'type-card__code', text: type.code }),
        UI.el('div', { class: 'type-card__cn', text: type.cn }),
        UI.el('div', { class: 'type-card__en', text: type.en })
      ]));
    }

    var votesLine = UI.el('p', {
      class: 'share-votes',
      style: { color: '#888', fontSize: '13px', margin: '10px 0 0' }
    });
    children.push(votesLine);

    // 评价数静默获取：失败不弹错，仅不显示该行
    if (token) {
      API.summary(token).then(function (res) {
        var n = (res && res.summary && typeof res.summary.total_votes === 'number')
          ? res.summary.total_votes
          : 0;
        votesLine.textContent = n === 0
          ? '还没有朋友评价，把链接发出去吧'
          : ('已有 ' + n + ' 位朋友评价了你');
      }).catch(function () { /* 静默降级 */ });
    }

    return UI.el('div', { class: 'share-page' }, children);
  }

  /* ---------- 状态切换 ---------- */
  function renderChooser(ctx, root) {
    UI.clear(root);
    root.appendChild(renderTypesGrid(ctx, function () {
      renderShare(ctx, root);
    }));
  }

  function renderShare(ctx, root) {
    UI.clear(root);
    root.appendChild(renderSharePage(ctx));
  }

  function home(ctx) {
    var root = UI.el('div', { class: 'view-home' });

    try {
      var user = ctx.store.user;

      if (!ctx.store.isLoggedIn() || !user) {
        // 状态 1：未登录 → 背景网格不可交互 + 强制注册弹窗
        var grid = renderTypesGrid(ctx, function () {});
        var buttons = grid.querySelectorAll('button');
        Array.prototype.forEach.call(buttons, function (b) {
          b.disabled = true;
          b.setAttribute('aria-disabled', 'true');
        });
        grid.style.opacity = '0.45';
        grid.style.pointerEvents = 'none';
        root.appendChild(grid);

        openRegisterModal(ctx, function () {
          renderChooser(ctx, root);
        });
      } else if (!user.mbti_self) {
        // 状态 2：已登录未选类型 → 可交互网格
        renderChooser(ctx, root);
      } else {
        // 状态 3：已有类型 → 分享页
        renderShare(ctx, root);
      }
    } catch (err) {
      // 兜底错误态，避免只渲染骨架
      UI.clear(root);
      root.appendChild(UI.empty('⚠️', '页面出错了', (err && err.message) || '请刷新后重试'));
    }

    return root;
  }

  global.Views = global.Views || {};
  global.Views.home = home;
})(typeof window !== 'undefined' ? window : this);
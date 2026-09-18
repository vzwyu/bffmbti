'use strict';
(function (global) {
  var UI = global.UI;
  var API = global.API;

  /**
   * 登录视图。
   *
   * 说明：原「忘记密码 / 找回码」功能已按需求关闭，因此本文件不再包含
   * 找回码输入与重置流程。注册时后端仍会生成一份找回码哈希存库（保留
   * 日后重新启用的余地），但前端不再展示、也不再提供入口。
   */
  /**
   * 登录成功后的去向。
   * `?next=` 只接受站内评价页路径（/s/<token>），其余一律回个人主页 ——
   * 避免有人构造出奇怪的跳转目标。navigate() 本身只能同源跳转，
   * 这里再加一道白名单，属于纵深防御。
   */
  function safeNext(ctx) {
    var next = (ctx.query && ctx.query.next) ? String(ctx.query.next) : '';
    if (/^\/s\/[A-Za-z0-9_-]+$/.test(next)) return next;
    return '/me';
  }

  function login(ctx) {
    // 已登录时不自动跳转，只给出去主页的入口
    if (ctx.store.isLoggedIn()) {
      var donePage = UI.el('div', { class: 'page page--narrow section' });
      donePage.appendChild(UI.empty('✓', '你已经登录了', ''));
      var meBtn = UI.el('button', { class: 'btn', type: 'button', text: '去我的主页' });
      meBtn.addEventListener('click', function () { ctx.navigate('/me'); });
      var meWrap = UI.el('div', { style: 'text-align:center;margin-top:16px;' });
      meWrap.appendChild(meBtn);
      donePage.appendChild(meWrap);
      return donePage;
    }

    var page = UI.el('div', { class: 'page page--narrow section' });
    var card = UI.el('div', { class: 'card card--pad-lg', style: 'max-width:460px;margin:0 auto;' });
    card.appendChild(buildLoginForm());
    page.appendChild(card);
    return page;

    function buildLoginForm() {
      var box = UI.el('div');
      box.appendChild(UI.el('h2', { text: '欢迎回来', style: 'margin:0 0 4px;' }));
      box.appendChild(UI.el('p', {
        class: 'muted',
        text: '用注册时填的账号和密码登录。',
        style: 'margin:0 0 16px;'
      }));

      var alertSlot = UI.el('div');
      box.appendChild(alertSlot);

      var accField = UI.field({
        id: 'lg-acc',
        // 登录页不写「QQ 号」：不主动索要。但后端仍放行纯数字账号，
        // 历史用 QQ 号注册的用户照常能登进来，只是页面上不再提这件事。
        label: '登录账号',
        placeholder: '邮箱 / 手机号',
        required: true,
        autocomplete: 'username'
      });
      var pwField = UI.field({
        id: 'lg-pw',
        label: '4 位数字密码',
        required: true,
        pin: true,
        inputmode: 'numeric',
        maxlength: 4,
        autocomplete: 'current-password'
      });

      var btn = UI.el('button', { class: 'btn btn--block btn--lg', type: 'button', text: '登录' });
      btn.disabled = true;

      // 账号级锁定时用 30 秒倒计时挡住再次提交
      var locked = false;
      var lockTimer = null;

      function isValid() {
        return accField.input.value.trim().length > 0 && pwField.input.value.length === 4;
      }
      function updateBtn() {
        if (!locked) btn.disabled = !isValid();
      }
      function showAlert(text) {
        UI.clear(alertSlot);
        alertSlot.appendChild(UI.alertBox('error', text));
      }
      function startLock() {
        locked = true;
        var left = 30;
        btn.disabled = true;
        btn.textContent = '请稍等 ' + left + 's';
        if (lockTimer) clearInterval(lockTimer);
        lockTimer = setInterval(function () {
          left -= 1;
          if (left <= 0) {
            clearInterval(lockTimer);
            lockTimer = null;
            locked = false;
            btn.textContent = '登录';
            updateBtn();
          } else {
            btn.disabled = true;
            btn.textContent = '请稍等 ' + left + 's';
          }
        }, 1000);
      }

      accField.input.addEventListener('input', function () {
        accField.clearError();
        updateBtn();
      });
      pwField.input.addEventListener('input', function () {
        pwField.input.value = pwField.input.value.replace(/\D/g, '').slice(0, 4);
        pwField.clearError();
        updateBtn();
      });

      btn.addEventListener('click', function () {
        if (locked || !isValid()) return;
        var account = accField.input.value.trim();
        var password = pwField.input.value;
        UI.withLoading(btn, function () {
          return API.login(account, password).then(function (res) {
            ctx.store.set(res.user);
            UI.toast('登录成功', 'success');
            ctx.navigate(safeNext(ctx));
          }).catch(function (err) {
            var code = err && err.code;
            if (code === 'too_many_requests') {
              // 锁定是账号级的，放提示条而不是字段错误
              showAlert(err.message);
              startLock();
            } else if (code === 'bad_credentials') {
              pwField.setError('账号或密码错误');
              showAlert('账号或密码错误。连续输错 5 次会锁定账号 15 分钟。');
            } else {
              UI.toast(err && err.message ? err.message : '登录失败，请稍后再试', 'error');
            }
            updateBtn();
          });
        });
      });

      box.appendChild(accField.wrap);
      box.appendChild(pwField.wrap);
      box.appendChild(btn);

      var warn = UI.el('div', { style: 'margin-top:16px;' });
      warn.appendChild(UI.alertBox('warn',
        '我们买不起短信验证／邮箱验证服务，请务必妥善保存登录账号和密码，遗失后无法自助找回。'));
      box.appendChild(warn);

      // 没有账号时的入口，避免用户卡在这一页
      var toReg = UI.el('div', { style: 'text-align:center;margin-top:16px;' });
      var regBtn = UI.el('button', {
        class: 'btn btn--quiet btn--sm', type: 'button', text: '还没有账号？去创建'
      });
      regBtn.addEventListener('click', function () { ctx.navigate('/'); });
      toReg.appendChild(regBtn);
      box.appendChild(toReg);

      return box;
    }
  }

  global.Views = global.Views || {};
  global.Views.login = login;
})(typeof window !== 'undefined' ? window : this);

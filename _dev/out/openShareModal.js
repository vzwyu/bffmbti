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

        var urlInput = UI.el('input', {
          class: 'share-box__url',
          type: 'text',
          readonly: true,
          value: link,
          onclick: function () { this.select(); }
        });

        function manualFallback() {
          try {
            urlInput.focus();
            urlInput.select();
          } catch (e) {}
          UI.toast('复制失败，长按输入框手动复制', 'error');
        }

        var copyBtn = UI.el('button', {
          class: 'btn',
          type: 'button',
          text: '复制',
          onclick: function () {
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(link).then(function () {
                  UI.toast('链接已复制，发给朋友吧', 'success');
                }, function () {
                  manualFallback();
                });
              } else {
                manualFallback();
              }
            } catch (e) {
              manualFallback();
            }
          }
        });

        var body = UI.el('div', { class: 'stack' }, [
          UI.alertBox('info', '这个链接是固定的，改过人格类型后还是同一个链接，之前发过的不用重发。'),
          UI.el('div', { class: 'share-box' }, [urlInput, copyBtn]),
          UI.el('p', { class: 'muted', text: '拿不到链接时，长按上面的输入框选中再复制。' })
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
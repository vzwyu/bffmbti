'use strict';
/**
 * UI 工具层 —— 所有 DOM 构造的唯一入口。
 *
 * 安全铁律：**用户数据一律走 textContent，永不拼进 innerHTML**。
 * 需要插 HTML 的地方必须显式使用 `unsafeHTML`，且只能传代码里写死的模板。
 * 昵称允许 emoji 与特殊符号，所以不能用"过滤字符"的思路，只能靠赋值方式隔离。
 */

(function (global) {
  var MBTI = global.MBTI;

  /* ------------------------------------------------------------------ */
  /* 元素构造                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * @param {string} tag
   * @param {object} [props]  特殊键：text / class / unsafeHTML / dataset / style / onXxx
   * @param {Array|Node|string} [children]
   */
  function el(tag, props, children) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'text') { n.textContent = String(v); }
        else if (k === 'class') { n.className = v; }
        else if (k === 'unsafeHTML') { n.innerHTML = v; }
        else if (k === 'dataset') {
          Object.keys(v).forEach(function (d) { n.dataset[d] = v[d]; });
        } else if (k === 'style' && typeof v === 'object') {
          Object.keys(v).forEach(function (s) { n.style[s] = v[s]; });
        } else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          n.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          n.setAttribute(k, '');
        } else {
          n.setAttribute(k, String(v));
        }
      });
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        // 统一走 asNode：能识别就插入，识别不了就跳过。
        // 早先直接 appendChild 会把普通对象塞进去，抛出
        // "parameter 1 is not of type 'Node'" 并让整个视图白屏。
        // 视图侧的调用错误由 _dev/view-smoke-test.js 负责抓，这里只保证不崩。
        var node = asNode(c);
        if (node) n.appendChild(node);
      });
    }
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /** 加载态按钮：包住异步动作，期间禁用并显示转圈 */
  function withLoading(btn, fn) {
    if (btn.dataset.busy === '1') return Promise.resolve();
    btn.dataset.busy = '1';
    btn.classList.add('is-loading');
    btn.disabled = true;
    return Promise.resolve()
      .then(fn)
      .finally(function () {
        btn.dataset.busy = '0';
        btn.classList.remove('is-loading');
        btn.disabled = false;
      });
  }

  /* ------------------------------------------------------------------ */
  /* 吐司                                                                */
  /* ------------------------------------------------------------------ */

  var toastWrap = null;
  function toast(msg, kind, ms) {
    if (!toastWrap) {
      toastWrap = el('div', { class: 'toast-wrap', id: 'toastWrap' });
      document.body.appendChild(toastWrap);
    }
    var node = el('div', { class: 'toast' + (kind ? ' toast--' + kind : ''), text: msg });
    toastWrap.appendChild(node);
    setTimeout(function () {
      node.classList.add('toast--out');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 240);
    }, ms || 2800);
  }

  /* ------------------------------------------------------------------ */
  /* 弹窗                                                                */
  /* ------------------------------------------------------------------ */

  var openModal = null;

  /** 把「field 对象」或「节点」统一成节点：兼容 body: fieldXxx 与 body: fieldXxx.wrap 两种写法 */
  function asNode(x) {
    if (x == null || x === false) return null;
    if (typeof x === 'string' || typeof x === 'number') return document.createTextNode(String(x));
    if (typeof x.nodeType === 'number') return x;
    // 形如 UI.field() 的返回值：取其中的节点
    if (x.wrap && typeof x.wrap.nodeType === 'number') return x.wrap;
    if (x.el && typeof x.el.nodeType === 'number') return x.el;
    return null;   // 无法识别，丢弃而不是塞进 DOM 引发崩溃
  }

  /** 把「描述对象」或「节点」统一成按钮：兼容 actions: [{label, kind, onClick}] 与 actions: [node] */
  function asAction(x) {
    const direct = asNode(x);
    if (direct) return direct;
    if (x && typeof x === 'object' && typeof x.onClick === 'function') {
      var cls = 'btn';
      if (x.kind === 'primary') cls += '';
      else if (x.kind === 'danger') cls += ' btn--danger';
      else if (x.kind === 'ghost') cls += ' btn--ghost';
      else if (x.kind === 'quiet') cls += ' btn--quiet';
      var b = el('button', { type: 'button', class: cls, text: x.label || x.text || '确定' });
      b.addEventListener('click', function (ev) { x.onClick(ev); });
      return b;
    }
    return null;   // 跳过无法识别的项，不让它炸掉整个弹窗
  }

  /**
   * @param {{title:string, sub?:string, subtitle?:string, body?:*, actions?:Array, dismissible?:boolean}} opt
   * 兼容性说明：各视图对同一能力用过不同的键名与传参形态（sub/subtitle、
   * body 传 field 对象或节点、actions 传描述对象或节点），这里统一吸收，
   * 避免任何一个调用点因键名不符而静默崩成「appendChild 参数不是 Node」。
   */
  function modal(opt) {
    closeModal();

    var panel = el('div', { class: 'modal__panel', role: 'dialog', 'aria-modal': 'true' });

    // 头部：标题 + 关闭按钮。
    // 关闭按钮**必须**有可见形态 —— 手机上弹层贴底、几乎盖满屏幕，
    // 「点背景关闭」根本点不到，没有 × 就等于关不掉（评价明细就踩过这个坑）。
    var head = el('div', { class: 'modal__head' });
    if (opt.title) head.appendChild(el('h2', { class: 'modal__title', text: opt.title }));
    if (opt.dismissible !== false) {
      var closeBtn = el('button', {
        class: 'modal__close', type: 'button',
        'aria-label': '关闭', title: '关闭', text: '×'
      });
      closeBtn.addEventListener('click', closeModal);
      head.appendChild(closeBtn);
    }
    if (head.children.length) panel.appendChild(head);

    var sub = opt.sub || opt.subtitle;
    if (sub) panel.appendChild(el('p', { class: 'modal__sub', text: sub }));

    // 正文单独一层：面板改成 flex 纵向布局后，只有这一层滚动，
    // 标题与关闭按钮始终留在屏幕上（长列表尤其重要）。
    var bodyWrap = el('div', { class: 'modal__body' });
    var bodyList = Array.isArray(opt.body) ? opt.body : [opt.body];
    bodyList.forEach(function (b) {
      var n = asNode(b);
      if (n) bodyWrap.appendChild(n);
    });
    if (bodyWrap.children.length) panel.appendChild(bodyWrap);

    if (opt.actions && opt.actions.length) {
      var row = el('div', { class: 'row row--wrap modal__actions', style: { marginTop: 'var(--sp-5)' } });
      opt.actions.forEach(function (a) {
        var n = asAction(a);
        if (n) row.appendChild(n);
      });
      if (row.children.length) panel.appendChild(row);
    }

    var backdrop = el('div', { class: 'modal' }, [panel]);
    if (opt.dismissible !== false) {
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) closeModal();
      });
    }

    document.body.appendChild(backdrop);
    document.body.style.overflow = 'hidden';
    openModal = backdrop;

    // 焦点移入弹窗，键盘用户不会迷失
    var focusable = panel.querySelector('input, button, [tabindex]');
    if (focusable) setTimeout(function () { focusable.focus(); }, 60);

    return backdrop;
  }

  function closeModal() {
    if (openModal && openModal.parentNode) openModal.parentNode.removeChild(openModal);
    openModal = null;
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModal();
  });

  function confirmDialog(opt) {
    return new Promise(function (resolve) {
      var okBtn = el('button', {
        class: 'btn' + (opt.danger ? ' btn--danger' : ''),
        text: opt.confirmText || '确定'
      });
      var cancelBtn = el('button', { class: 'btn btn--ghost', text: '取消' });
      var body = el('div', {}, [
        el('p', { text: opt.message || '' }),
        opt.note ? el('div', { class: 'alert alert--warn', style: { marginTop: 'var(--sp-4)' } }, [
          el('span', { class: 'alert__icon', text: '!' }),
          el('div', { text: opt.note })
        ]) : null
      ]);

      okBtn.addEventListener('click', function () { closeModal(); resolve(true); });
      cancelBtn.addEventListener('click', function () { closeModal(); resolve(false); });

      modal({
        title: opt.title,
        body: body,
        actions: [okBtn, cancelBtn]
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 表单                                                                */
  /* ------------------------------------------------------------------ */

  /** 一步到位构造一个带标签/提示/错误位的输入项 */
  function field(opt) {
    var input = el('input', {
      class: 'input' + (opt.pin ? ' input--pin' : ''),
      id: opt.id,
      type: opt.type || 'text',
      placeholder: opt.placeholder || '',
      maxlength: opt.maxlength || false,
      inputmode: opt.inputmode || false,
      autocomplete: opt.autocomplete || 'off',
      value: opt.value || false,
      readonly: opt.readonly || false
    });
    var wrap = el('div', { class: 'field', id: opt.id + '-field' }, [
      el('label', { class: 'field__label', for: opt.id }, [
        opt.label,
        opt.required ? el('span', { class: 'req', text: '*' }) : null
      ]),
      input,
      opt.hint ? el('div', { class: 'field__hint', text: opt.hint }) : null,
      el('div', { class: 'field__error', text: opt.error || '请检查此项' })
    ]);
    // 同时暴露 wrap 与 el 两个名字。
    // 各处视图对同一个返回值的取名并不统一（home/login 用 .wrap，profile 用 .el），
    // 只提供其中一个会导致 appendChild(undefined) 这种难查的运行时错误。
    // 对外是同一批方法，别名不增加维护成本。
    return {
      wrap: wrap,
      el: wrap,
      input: input,
      setError: function (msg) {
        wrap.classList.add('is-invalid');
        if (msg) wrap.querySelector('.field__error').textContent = msg;
        input.setAttribute('aria-invalid', 'true');
        return false;
      },
      clearError: function () {
        wrap.classList.remove('is-invalid');
        input.removeAttribute('aria-invalid');
        return true;
      },
      isInvalid: function () { return wrap.classList.contains('is-invalid'); }
    };
  }

  /** 四组主题色的分段选择器 */
  function segmented(options, value, onChange) {
    var wrap = el('div', { class: 'segmented' });
    options.forEach(function (o) {
      var b = el('button', {
        type: 'button',
        class: 'segmented__opt',
        text: o.label,
        'aria-pressed': String(value === o.value)
      });
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(wrap.children, function (x) {
          x.setAttribute('aria-pressed', 'false');
        });
        b.setAttribute('aria-pressed', 'true');
        onChange(o.value);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  /* ------------------------------------------------------------------ */
  /* 人格形象（当前为占位，正式版替换为原创插画）                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} type  MBTI.get(code) 的结果
   * @param {string} size  'sm' | 'md' | 'lg'
   */
  function persona(type, size) {
    var box = el('div', {
      class: 'type-card__avatar' + (size === 'lg' ? '' : ''),
      dataset: { group: type.group }
    });
    if (size === 'lg') box.style.cssText = 'width:96px;height:96px';

    var img = el('img', {
      // 绝对路径：深链接（/games/mbti/s/<token>）下相对路径会解析错
      src: '/games/mbti/assets/avatars/' + type.slug + '.webp',
      alt: type.code + ' ' + type.cn,
      loading: 'lazy',
      decoding: 'async'
    });
    // 形象图尚未生成时自动退回主题色圆形，不留破图
    img.addEventListener('error', function () {
      clear(box);
      box.classList.add('type-card__avatar--placeholder');
      box.textContent = type.code.slice(0, 2);
    });
    box.appendChild(img);
    return box;
  }

  /* ------------------------------------------------------------------ */
  /* 分享                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 分享文案：发给朋友时的一句话 + 链接。
   * **只在这里定义一处** —— 首页分享页与个人主页的分享弹窗都调它，
   * 免得两处各写一句、改一处忘一处。
   */
  function shareText(nickname, link) {
    return '你觉得' + (nickname || '我') + '的MBTI是什么：' + link;
  }

  /** 复制到剪贴板。返回 Promise<boolean>，true = 成功 */
  function copy(text) {
    return new Promise(function (resolve) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { resolve(true); },
            function () { resolve(false); });
        } else {
          resolve(false);
        }
      } catch (e) {
        resolve(false);
      }
    });
  }

  /**
   * 分享面板：一句完整文案 + 两个复制按钮。
   * - 「复制」复制**整句**（直接粘给朋友就能用）
   * - 「仅复制链接」只复制 URL
   * 复制失败时统一降级为「全选 + 提示长按手动复制」——不要在调用方各写一遍。
   */
  function sharePanel(opt) {
    var link = opt.link;
    var text = shareText(opt.nickname, link);

    var input = el('input', {
      class: 'share-box__url', type: 'text', readonly: true, value: text
    });
    input.addEventListener('click', function () { input.select(); });

    function fallback() {
      try { input.focus(); input.select(); } catch (e) { /* 忽略 */ }
      toast('复制失败，长按上面的内容手动复制', 'error');
    }

    var copyAllBtn = el('button', { class: 'btn', type: 'button', text: '复制' });
    copyAllBtn.addEventListener('click', function () {
      copy(text).then(function (ok) {
        if (!ok) { fallback(); return; }
        toast('整句已复制，直接发给朋友就行', 'success');
        if (opt.onCopied) opt.onCopied('text');
      });
    });

    var copyLinkBtn = el('button', {
      class: 'btn btn--ghost btn--block', type: 'button', text: '仅复制链接'
    });
    copyLinkBtn.addEventListener('click', function () {
      copy(link).then(function (ok) {
        if (!ok) { fallback(); return; }
        toast('链接已复制', 'success');
        if (opt.onCopied) opt.onCopied('link');
      });
    });

    return el('div', { class: 'stack' }, [
      el('div', { class: 'share-box' }, [input, copyAllBtn]),
      copyLinkBtn
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* 常用区块                                                            */
  /* ------------------------------------------------------------------ */

  function empty(icon, title, desc) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'empty__icon', text: icon || '·' }),
      el('div', { style: { fontWeight: '600', color: 'var(--c-text)' }, text: title || '' }),
      desc ? el('div', { style: { fontSize: 'var(--fs-sm)' }, text: desc }) : null
    ]);
  }

  function alertBox(kind, text) {
    return el('div', { class: 'alert alert--' + kind }, [
      el('span', { class: 'alert__icon', text: kind === 'info' ? 'i' : '!' }),
      el('div', { text: text })
    ]);
  }

  /** 按轴票数画票型条（结果页与主页共用） */
  /**
   * 四轴票型条。
   * @param {Array} axes
   * @param {{selfLabel?:string, majorityLabel?:string}} [opts]
   *   selfLabel —— 自我认知那一侧标签的称呼。默认「你」。
   *     个人主页里看的是**自己**的数据 → 默认合适；
   *     访客页看的是**被评价人**的数据 → 必须传「他/她」，否则会读成"你"，
   *     既是文案错误，也让人误以为在说自己。
   */
  function axisVoteBars(axes, opts) {
    opts = opts || {};
    var selfLabel = opts.selfLabel || '你';
    var majorityLabel = opts.majorityLabel || '多数人';
    var box = el('div', { class: 'dvx' });
    axes.forEach(function (a) {
      var total = a.leftCount + a.rightCount;
      var tie = a.tie;
      var diff = a.agreeWithMajority === false;

      var status = el('span', {
        class: 'dvx__status ' + (tie ? 'dvx__status--tie' : (diff ? 'dvx__status--diff' : 'dvx__status--same')),
        text: tie ? '票数持平' : (diff ? '存在偏差' : '认知一致')
      });

      var bar = el('div', { class: 'dvx__bar' });
      [[a.left, a.leftCount, a.leftCn, 'left'], [a.right, a.rightCount, a.rightCn, 'right']].forEach(function (s) {
        var seg = el('div', {
          class: 'dvx__seg dvx__seg--' + s[3] + (a.majority === s[0] ? ' dvx__seg--win' : '')
        });
        seg.style.flexGrow = String(Math.max(s[1], 1));
        seg.style.flexBasis = '0';
        if (s[1] === 0) seg.style.minWidth = '44px';
        seg.appendChild(el('span', { class: 'dvx__letter', text: s[0] }));
        seg.appendChild(el('span', { class: 'dvx__count' }, [
          el('b', { text: String(s[1]) }), ' 人 · ' + s[2]
        ]));
        bar.appendChild(seg);
      });

      var picks = el('div', { class: 'dvx__picks' });
      [[a.left, 'left'], [a.right, 'right']].forEach(function (s) {
        var cell = el('div', { class: 'dvx__side' + (s[1] === 'right' ? ' dvx__side--right' : '') });
        if (a.selfChoice === s[0]) {
          cell.appendChild(el('span', { class: 'dvx__tag dvx__tag--self', text: selfLabel + '：' + s[0] }));
        }
        if (a.majority === s[0]) {
          cell.appendChild(el('span', { class: 'dvx__tag dvx__tag--maj', text: majorityLabel + '：' + s[0] }));
        }
        if (!cell.children.length) cell.appendChild(el('span', { class: 'dvx__tag dvx__tag--none', text: '—' }));
        picks.appendChild(cell);
      });

      var note = '';
      if (total === 0) {
        note = '还没有人评价这个维度。';
      } else {
        note = total + ' 人中，' + a.leftCount + ' 人认为是' + a.leftCn + '（' + a.left + '），'
          + a.rightCount + ' 人认为是' + a.rightCn + '（' + a.right + '）。';
        if (tie) note += '票数持平，按你自己的认知取 ' + a.majority + '。';
        else if (diff) note += '多数人认为是 ' + a.majority + '，与' + selfLabel + '的自我认知 ' + a.selfChoice + ' 不同。';
        else if (a.selfChoice) note += '多数人认为是 ' + a.majority + '，与' + selfLabel + '的自我认知一致。';
      }

      box.appendChild(el('div', {}, [
        el('div', { class: 'dvx__head' }, [
          el('span', { class: 'dvx__title', text: a.leftCn + ' ' + a.left + ' ／ ' + a.rightCn + ' ' + a.right }),
          status
        ]),
        bar,
        picks,
        el('div', { class: 'dvx__note', text: note })
      ]));
    });
    return box;
  }

  /** 时间格式化：今天显示时刻，其它显示日期 */
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var p = function (x) { return String(x).padStart(2, '0'); };
    var sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return '今天 ' + p(d.getHours()) + ':' + p(d.getMinutes());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  global.UI = {
    el: el,
    clear: clear,
    withLoading: withLoading,
    toast: toast,
    modal: modal,
    closeModal: closeModal,
    confirmDialog: confirmDialog,
    field: field,
    segmented: segmented,
    persona: persona,
    empty: empty,
    alertBox: alertBox,
    shareText: shareText,
    sharePanel: sharePanel,
    copy: copy,
    axisVoteBars: axisVoteBars,
    fmtTime: fmtTime
  };
})(typeof window !== 'undefined' ? window : this);

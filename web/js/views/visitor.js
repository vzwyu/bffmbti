'use strict';
(function (global) {
  var UI = global.UI;
  var API = global.API;
  var MBTI = global.MBTI;
  // 场景问卷的题库与推题逻辑（web/js/quiz.js）
  var Quiz = global.Quiz;

  var VOTER_KEY = 'mbti_voter_name';

  // 从 MBTI.get 的结果里取中英文名。
  // 本地数据结构实测是 { code, cn, en, slug, group, tagline, color }，
  // 所以 cn / en 必须排在最前。原来这条链漏了 t.cn，
  // 而 en 那条恰好带了 t.en —— 结果就是**结果卡一直缺中文名**，只剩代号和英文名。
  // 其余字段是历史命名兜底，保留以防上游换过名。
  function typeNames(t) {
    if (!t) return { cn: '', en: '' };
    return {
      cn: t.cn || t.cnName || t.nameCn || t.name_cn || t.name || '',
      en: t.en || t.enName || t.nameEn || t.name_en || ''
    };
  }

  function typeGroup(t) {
    if (!t) return '';
    return t.group || t.groupKey || '';
  }

  /**
   * 评价者昵称的来源优先级：
   *   1. 已登录 → 用登录账号的昵称（保证署名与账号一致，也不写进 localStorage，
   *      免得把"匿名访客用过的名字"和"本人身份"混在一起）
   *   2. 未登录 → 用本地记住的上次填过的称呼
   */
  function currentVoterName(ctx) {
    if (ctx && ctx.store && ctx.store.user && ctx.store.user.nickname) {
      return ctx.store.user.nickname;
    }
    return global.localStorage.getItem(VOTER_KEY) || '';
  }

  /**
   * 用被评价人的性别决定称呼。
   * 没维护性别（或选了"暂不填写"）时用「他/她」，不要默认「他」——
   * 那会在女生页面上写错性别。
   */
  function pronoun(user) {
    var g = user && user.gender;
    if (g === 'male') return '他';
    if (g === 'female') return '她';
    return '他/她';
  }

  function isLoggedIn(ctx) {
    return !!(ctx && ctx.store && ctx.store.user);
  }

  /** 登录后回到本页继续评价。只允许站内评价页路径，避免被塞进奇怪的值。 */
  function loginBackPath(ctx) {
    var token = ctx && ctx.params ? ctx.params.token : '';
    if (!token) return '/login';
    return '/login?next=' + encodeURIComponent('/s/' + token);
  }

  // 第 1 步：问称呼（纯本地，不调后端）
  function askVoterName(ctx, onDone) {
    var field = UI.field({
      id: 'voter-name',
      label: '您的称呼',
      placeholder: '最长 32 个汉字或 64 个英文字符，可以用 emoji',
      maxlength: 64,
      value: global.localStorage.getItem(VOTER_KEY) || ''
    });

    var modal = UI.modal({
      dismissible: false,
      title: '我该怎么称呼您？',
      subtitle: '填个名字，让你的评价有署名。',
      body: field,
      actions: [
        {
          label: '开始评价',
          kind: 'primary',
          onClick: function () {
            var input = (modal && typeof modal.querySelector === 'function')
              ? modal.querySelector('#voter-name')
              : global.document.getElementById('voter-name');
            var name = input ? String(input.value || '').trim() : '';
            if (!name) {
              UI.toast('先填个称呼吧', 'error');
              if (input && input.focus) input.focus();
              return;
            }
            global.localStorage.setItem(VOTER_KEY, name);
            UI.closeModal();
            onDone(name);
          }
        },
        {
          // 已有账号的人不必再手填一遍称呼：登录后回来直接用本人昵称署名
          label: '已有账户？去登录',
          kind: 'ghost',
          onClick: function () {
            UI.closeModal();
            ctx.navigate(loginBackPath(ctx));
          }
        }
      ]
    });
  }

  /**
   * 「不知道怎么选？」—— 用几道场景问答题反推四个维度。
   * 题库与推题逻辑在 web/js/quiz.js（Quiz），这里只负责界面与提交。
   * 答完直接走和手动选量表**完全相同的提交与结果页**，不另做一套。
   */
  function openQuizModal(ctx, user, token, onSubmitted) {
    var session = Quiz.createSession();
    var body = UI.el('div', { class: 'stack' });
    var busy = false;

    function finish() {
      var picks = Quiz.result(session);
      if (!picks) {
        // 按理走不到这里（引擎兜底会强制二选一），但绝不能让界面卡在空白
        UI.clear(body);
        body.appendChild(UI.alertBox('error', '还判断不出完整类型，请关掉重试一次。'));
        return;
      }
      if (busy) return;
      busy = true;
      API.submitVote(token, {
        voter_nickname: currentVoterName(ctx),
        IE: picks.IE, NS: picks.NS, TF: picks.TF, PJ: picks.PJ
      }).then(function (res) {
        UI.closeModal();
        onSubmitted(res);
      }).catch(function (err) {
        busy = false;
        UI.toast((err && err.message) || '提交失败，请稍后重试', 'error');
      });
    }

    function render() {
      var q = Quiz.nextQuestion(session, Quiz.QUESTIONS);
      if (!q) { finish(); return; }

      UI.clear(body);
      var p = Quiz.progress(session);
      body.appendChild(UI.el('p', {
        class: 'muted',
        text: '第 ' + (p.asked + 1) + ' 题 · 已判断 ' + p.resolved + '/' + p.total + ' 个维度'
      }));
      body.appendChild(UI.el('div', { class: 'quiz-scene', text: q.scene }));
      body.appendChild(UI.el('p', { class: 'quiz-ask', text: q.ask }));

      var opts = UI.el('div', { class: 'stack' });
      q.options.forEach(function (o) {
        var b = UI.el('button', {
          class: 'btn btn--ghost btn--block quiz-opt', type: 'button', text: o.text
        });
        b.addEventListener('click', function () {
          // 注意传的是**题目对象**，不是 q.id —— 引擎要从里面读 id/axis/forced
          Quiz.answer(session, q, o.picks);
          render();
        });
        opts.appendChild(b);
      });

      // 强制二选一的题不给「我不知道」，否则永远收敛不了
      if (!q.noUnknown) {
        var unk = UI.el('button', {
          class: 'btn btn--quiet btn--block quiz-opt', type: 'button', text: '我不知道'
        });
        unk.addEventListener('click', function () {
          Quiz.answer(session, q, null);
          render();
        });
        opts.appendChild(unk);
      }

      body.appendChild(opts);
    }

    render();
    UI.modal({
      title: '不知道怎么选？',
      sub: '答几道关于他的日常小事，我来帮你判断。拿不准就选「我不知道」。',
      body: body,
      dismissible: true
    });
  }

  // 第 2 步：四轴量表
  function buildScaleStep(ctx, user, totalVotes, onSubmitted) {
    var nickname = user.nickname;
    var token = ctx.params.token;
    var picks = { IE: null, NS: null, TF: null, PJ: null };

    var title = UI.el('h2', { class: 'visitor-title' }, [
      '你认为 ',
      UI.el('span', { text: nickname }),
      ' 的 MBTI 更倾向以下哪种？'
    ]);

    var headChildren = [title];
    if (isLoggedIn(ctx)) {
      headChildren.push(UI.el('p', {
        class: 'muted',
        text: '将以「' + currentVoterName(ctx) + '」的身份署名。',
        style: { color: 'var(--fg-muted,#888)', fontSize: 'var(--fs-sm,14px)' }
      }));
    }
    if (totalVotes === 0) {
      headChildren.push(UI.el('p', {
        class: 'muted',
        text: '你是第一个来评价的人。',
        style: { color: 'var(--fg-muted,#888)', fontSize: 'var(--fs-sm,14px)' }
      }));
    }

    var progressText = UI.el('span', { text: '已选 0 / 4' });
    var submitBtn = UI.el('button', {
      class: 'btn btn--primary',
      text: '提交',
      disabled: true
    });

    function refreshProgress() {
      var n = 0;
      MBTI.AXES.forEach(function (ax) { if (picks[ax.key]) n += 1; });
      progressText.textContent = '已选 ' + n + ' / 4';
      submitBtn.disabled = n < 4;
    }

    var axisNodes = MBTI.AXES.map(function (ax) {
      var head = UI.el('div', {
        class: 'axis__head',
        text: ax.leftCn + ' 还是 ' + ax.rightCn + ' ？'
      });

      var optButtons = [];

      function makeOpt(side) {
        var letter = side === 'left' ? ax.left : ax.right;
        var label = side === 'left' ? ax.leftCn : ax.rightCn;
        var desc = side === 'left' ? ax.leftDesc : ax.rightDesc;
        var btn = UI.el('button', { class: 'axis__opt', 'aria-pressed': 'false', type: 'button' }, [
          UI.el('span', { class: 'axis__letter', text: letter }),
          UI.el('span', { class: 'axis__label', text: label }),
          UI.el('span', { class: 'axis__desc', text: desc || '' })
        ]);
        btn.addEventListener('click', function () {
          // 同一轴单选：先清掉该轴所有按钮的选中态
          optButtons.forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
          btn.setAttribute('aria-pressed', 'true');
          picks[ax.key] = letter;
          head.textContent = '已选：' + label + '（' + letter + '）';
          refreshProgress();
        });
        optButtons.push(btn);
        return btn;
      }

      return UI.el('div', { class: 'axis' }, [
        head,
        UI.el('div', { class: 'axis__picks' }, [makeOpt('left'), makeOpt('right')])
      ]);
    });

    // 限流时禁用 10 秒并倒计时
    function cooldown(seconds) {
      var left = seconds;
      submitBtn.disabled = true;
      submitBtn.textContent = '请稍候（' + left + 's）';
      var timer = global.setInterval(function () {
        left -= 1;
        if (left <= 0) {
          global.clearInterval(timer);
          submitBtn.textContent = '提交';
          refreshProgress(); // 按当前选择数恢复可用态
        } else {
          submitBtn.textContent = '请稍候（' + left + 's）';
        }
      }, 1000);
    }

    submitBtn.addEventListener('click', function () {
      var voterName = currentVoterName(ctx);
      UI.withLoading(submitBtn, function () {
        return API.submitVote(token, {
          voter_nickname: voterName,
          IE: picks.IE, NS: picks.NS, TF: picks.TF, PJ: picks.PJ
        }).then(function (res) {
          onSubmitted(res);
        }).catch(function (err) {
          UI.toast((err && err.message) || '提交失败，请稍后重试', 'error');
          if (err && (err.code === 'too_soon' || err.code === 'too_many_requests')) {
            cooldown(10);
          }
        });
      });
    });

    // 「不知道怎么选？」放在提交键左边；窄屏时两个按钮一起换到下一行仍然并排。
    // 用 btn--ghost 而不是 btn--quiet：后者是透明背景+透明边框，在白底上几乎看不见
    // （「退出登录」就踩过这个坑）。这里既然要引导用户点，就要看得见。
    var quizBtn = UI.el('button', {
      class: 'btn btn--ghost btn--sm', type: 'button', text: '不知道怎么选？点这里'
    });
    quizBtn.addEventListener('click', function () {
      openQuizModal(ctx, user, token, onSubmitted);
    });

    var btnRow = UI.el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: '0' }
    }, [quizBtn, submitBtn]);

    var progressRow = UI.el('div', {
      class: 'visitor-progress',
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-3,12px)', flexWrap: 'wrap', marginTop: 'var(--sp-4,16px)' }
    }, [progressText, btnRow]);

    var children = headChildren.concat(axisNodes);
    children.push(progressRow);

    return UI.el('div', { class: 'visitor-step visitor-scale' }, children);
  }

  // 第 3 步：单张结果卡片
  function buildResultCard(who, code, emptyText) {
    var t = code ? MBTI.get(code) : null;
    var names = typeNames(t);
    var group = typeGroup(t);

    var attrs = {
      class: 'card result-card',
      style: { textAlign: 'center', padding: 'var(--sp-4,16px)' }
    };
    if (group) {
      attrs['data-group'] = group;
      attrs.style['--g'] = 'var(--group-' + group + ', var(--accent, currentColor))';
    }
    var card = UI.el('div', attrs);

    card.appendChild(UI.el('div', {
      class: 'result-card__who',
      text: who,
      style: { fontSize: 'var(--fs-sm,14px)', color: 'var(--fg-muted,#888)' }
    }));

    if (t) {
      // 人格形象图与类型代号放**同一排**：卡片原本一行一个元素，
      // 手机上三张卡纵向堆叠会很长，合并后省掉一整行。
      // 外层必须用 flex 显式居中 —— 卡片是 text-align:center，
      // 但那只管行内内容，块级的形象图不会跟着居中（会贴左侧，看起来像空白）。
      card.appendChild(UI.el('div', {
        class: 'result-card__row',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--sp-3,12px)',
          margin: 'var(--sp-3,12px) 0 var(--sp-2,8px)'
        }
      }, [
        UI.persona(t),
        UI.el('div', {
          class: 'result-card__code',
          text: code,
          style: { fontSize: 'var(--fs-xl,28px)', fontWeight: '700', color: 'var(--g, var(--accent, currentColor))' }
        })
      ]));
      if (names.cn) card.appendChild(UI.el('div', { class: 'result-card__cn', text: names.cn }));
      if (names.en) card.appendChild(UI.el('div', {
        class: 'result-card__en',
        text: names.en,
        style: { color: 'var(--fg-muted,#888)', fontSize: 'var(--fs-sm,14px)' }
      }));
    } else {
      card.appendChild(UI.el('div', {
        class: 'result-card__empty',
        text: emptyText,
        style: { margin: 'var(--sp-4,16px) 0', fontSize: 'var(--fs-lg,20px)', color: 'var(--fg-muted,#888)' }
      }));
    }

    return card;
  }

  // 第 3 步：结果对比
  function buildResultStep(ctx, user, yourChoice, summary) {
    var nickname = user.nickname;
    var selfMbti = summary.self_mbti || null;
    var majorityMbti = summary.majority_mbti || null;

    var triple = UI.el('div', {
      class: 'result-triple',
      style: { display: 'grid', gap: 'var(--sp-3,12px)' }
    }, [
      buildResultCard('你认为', yourChoice, ''),
      buildResultCard(nickname + ' 认为自己是', selfMbti, '还没选择'),
      buildResultCard('大多数人认为', majorityMbti, '还看不出来')
    ]);

    // 响应式：>=860px 三列
    var mql = global.matchMedia ? global.matchMedia('(min-width:860px)') : null;
    function applyCols() {
      triple.style.gridTemplateColumns = (mql && mql.matches) ? 'repeat(3, 1fr)' : '1fr';
    }
    applyCols();
    if (mql) {
      if (mql.addEventListener) mql.addEventListener('change', applyCols);
      else if (mql.addListener) mql.addListener(applyCols);
    }

    // 一句话总结：必须包含三个结果
    // 「你」始终指**评价人自己**（这是他的判断），指被评价人的地方一律用 ta
    var ta = pronoun(user);
    var sentence;
    if (!selfMbti) {
      sentence = '你认为 ' + nickname + ' 是 ' + yourChoice + '，' + ta + '还没选择自己的类型。';
    } else if (!majorityMbti) {
      sentence = '你认为 ' + nickname + ' 是 ' + yourChoice + '，' +
        nickname + ' 认为自己是 ' + selfMbti + '，大多数人那边还看不出来。';
    } else {
      sentence = '你认为 ' + nickname + ' 是 ' + yourChoice + '，' +
        nickname + ' 认为自己是 ' + selfMbti + '，大多数人认为是 ' + majorityMbti + '。';
    }
    if (summary.total_votes < 3) {
      sentence += '（目前只有 ' + summary.total_votes + ' 人评价，结果仅供参考）';
    }

    // 完整票型条：直接用 UI.axisVoteBars，不自己画。
    // selfLabel 必须传「他/她」—— 这里的自我认知指的是**被评价人**，
    // 用默认的「你」会被读成"评价人自己"，文案就错了。
    var barsBody;
    if (summary.total_votes === 0) {
      barsBody = UI.empty('📊', '还没有票型数据', '等更多人评价后再来看看');
    } else {
      barsBody = UI.axisVoteBars(summary.axes, { selfLabel: ta });
    }
    var barsCard = UI.el('div', { class: 'card card--pad-lg' }, [
      UI.el('h3', { text: '大家怎么看' + ta, style: { marginTop: '0' } }),
      barsBody
    ]);

    var voterName = currentVoterName(ctx);
    // 结果页末尾的 CTA：做成整行大字按钮 + 上方一句引子，
    // 并加一条分隔线把它和上面的票型条切开 —— 原来只是一个内联小按钮，
    // 夹在长页面末尾很不显眼。
    var ctaBtn = UI.el('button', { class: 'btn btn--lg btn--block', text: '我也要测试', type: 'button' });
    ctaBtn.addEventListener('click', function () {
      if (ctx.store && ctx.store.isLoggedIn && ctx.store.isLoggedIn()) {
        ctx.navigate('/me');
      } else {
        ctx.navigate('/?prefill=' + encodeURIComponent(voterName));
      }
    });

    var ctaBlock = UI.el('div', { class: 'visitor-cta' }, [
      UI.el('p', { class: 'visitor-cta__lead', text: '想让朋友也来评评你？' }),
      ctaBtn,
      UI.el('p', {
        class: 'muted',
        text: '你已经填过称呼了，注册时不用再填一次。',
        style: { fontSize: 'var(--fs-sm,14px)', color: 'var(--fg-muted,#888)', marginTop: 'var(--sp-2,8px)' }
      })
    ]);

    return UI.el('div', { class: 'visitor-step visitor-result' }, [
      triple,
      UI.el('p', { class: 'result-sentence', text: sentence }),
      barsCard,
      ctaBlock
    ]);
  }

  function visitor(ctx) {
    var container = UI.el('div', { class: 'view visitor-view' });

    // 第 0 步：加载被评价者的公开信息
    var loading = UI.el('div', { class: 'visitor-loading' }, [
      UI.el('p', { text: '加载中…', style: { color: 'var(--fg-muted,#888)' } })
    ]);
    container.appendChild(loading);

    return API.publicUser(ctx.params.token).then(function (res) {
      var user = (res && res.user) || {};
      UI.clear(container);

      // 先查一次汇总：用于「第一个评价的人」提示（失败不影响主流程）
      return API.summary(ctx.params.token).then(function (sumRes) {
        var totalVotes = (sumRes && sumRes.summary && typeof sumRes.summary.total_votes === 'number')
          ? sumRes.summary.total_votes : 0;
        startFlow(user, totalVotes);
        return container;
      }).catch(function () {
        startFlow(user, 0);
        return container;
      });
    }).catch(function () {
      // 链接无效 / 失效：直接给空态，不弹错误 toast
      UI.clear(container);
      container.appendChild(UI.empty('🔗', '这个链接无效或已失效', '找发给你的人要一个新的链接吧'));
      return container;
    });

    function startFlow(user, totalVotes) {
      // 已登录时先问一句：之前是不是已经评价过这个人了？
      // 重复提交既浪费用户时间，也会把他的评分权重刷高。
      if (isLoggedIn(ctx)) {
        API.myVote(ctx.params.token).then(function (res) {
          if (res && res.voted && res.vote) {
            confirmAlreadyVoted(user, res);
          } else {
            enterScale(user, totalVotes);
          }
        }).catch(function () {
          // 查询失败不拦路，按"没投过"处理
          enterScale(user, totalVotes);
        });
        return;
      }

      // 第 1 步：问称呼
      askVoterName(ctx, function () {
        // 第 2 步：四轴量表
        enterScale(user, totalVotes);
      });
    }

    function enterScale(user, totalVotes) {
      UI.clear(container);
      container.appendChild(buildScaleStep(ctx, user, totalVotes, function (voteRes) {
        // 第 3 步：结果对比
        UI.clear(container);
        container.appendChild(buildResultStep(ctx, user, voteRes.your_choice, voteRes.summary));
      }));
    }

    function confirmAlreadyVoted(user, res) {
      // 先把结果页渲染好放在下层，用户点确认直接切过去，不再等一次请求
      var goResult = function () {
        UI.clear(container);
        container.appendChild(buildResultStep(ctx, user, res.vote.your_choice, res.summary));
      };

      var totalVotes = (res.summary && typeof res.summary.total_votes === 'number')
        ? res.summary.total_votes
        : 0;

      // 刻意不告诉评价人"你这条被对方标为失效了"：
      // 那是被评价人与系统之间的事，透给评价人只会制造矛盾。
      // 后端 getMyVote 也不再返回 invalid 字段（不只是不显示）。
      UI.modal({
        title: '你之前已经评价过他了',
        sub: '一个人只算一次。你可以看看结果，也可以改掉之前的判断。',
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
  }

  global.Views = global.Views || {};
  global.Views.visitor = visitor;
})(typeof window !== 'undefined' ? window : this);
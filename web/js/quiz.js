'use strict';
/**
 * 场景问卷 —— 题库 + 推题引擎（纯数据 / 纯逻辑，不碰 DOM、不发请求）
 *
 * 用途：访客在"四轴量表"上拿不准时，点「不知道怎么选？」，
 * 用几道关于被评价人的日常小问题反推出四个维度。
 *
 * 推题规则：默认每个维度问到 2 道（共 8 题）就能定；
 * 有"我不知道"时继续补题，题库用尽仍定不下来的维度，
 * 用一道**强制二选一**收尾，保证一定能收敛。
 *
 * 生成：由 Kimi K3 按 _dev/spec-quiz-engine.md 与 _dev/spec-quiz-bank.md 产出，
 *       经 _dev/assemble-quiz.js 拼装并做静态校验。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.Quiz = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {

  var AXES = [
    { key: 'IE', left: 'I', right: 'E', leftCn: '更爱独处', rightCn: '更爱热闹' },
    { key: 'NS', left: 'N', right: 'S', leftCn: '更看可能性', rightCn: '更看事实' },
    { key: 'TF', left: 'T', right: 'F', leftCn: '先讲道理', rightCn: '先照顾感受' },
    { key: 'PJ', left: 'P', right: 'J', leftCn: '留余地', rightCn: '早定下来' }
  ];
  var MIN_VALID = 2;
  
  function createSession() {
    return {
      answers: [],
      askedIds: {},
      cursor: {},
      forced: [],
      done: false
    };
  }
  
  function axisOf(session, axisKey) {
    var left = null;
    var right = null;
    var i;
    for (i = 0; i < AXES.length; i++) {
      if (AXES[i].key === axisKey) {
        left = AXES[i].left;
        right = AXES[i].right;
        break;
      }
    }
    var valid = 0;
    var unknown = 0;
    var l = 0;
    var r = 0;
    for (i = 0; i < session.answers.length; i++) {
      var a = session.answers[i];
      if (a.axis !== axisKey) { continue; }
      if (a.pick === null) {
        unknown++;
      } else {
        valid++;
        if (a.pick === left) { l++; }
        else if (a.pick === right) { r++; }
      }
    }
    return { valid: valid, unknown: unknown, left: l, right: r, tie: l === r };
  }
  
  function isAxisResolved(session, axisKey) {
    var s = axisOf(session, axisKey);
    if (s.valid >= MIN_VALID && s.left !== s.right) { return true; }
    var forcedId = 'forced-' + axisKey;
    for (var i = 0; i < session.answers.length; i++) {
      if (session.answers[i].id === forcedId && session.answers[i].pick !== null) {
        return true;
      }
    }
    return false;
  }
  
  function resolvedLetter(session, axisKey) {
    if (!isAxisResolved(session, axisKey)) { return null; }
    var s = axisOf(session, axisKey);
    var left = null;
    var right = null;
    for (var i = 0; i < AXES.length; i++) {
      if (AXES[i].key === axisKey) {
        left = AXES[i].left;
        right = AXES[i].right;
        break;
      }
    }
    if (s.left > s.right) { return left; }
    if (s.right > s.left) { return right; }
    return null;
  }
  
  function nextQuestion(session, bank) {
    if (session.done) { return null; }
    var i;
    var j;
    var k;
  
    // ---- 1. 强制阶段优先 ----
    if (session.forced.length > 0) {
      k = session.forced[0];
      var fid = 'forced-' + k;
      if (!session.askedIds[fid]) {
        for (i = 0; i < AXES.length; i++) {
          if (AXES[i].key === k) {
            return {
              id: fid,
              axis: k,
              scene: '最后一题，必须选一个',
              ask: '实在拿不准的话，你觉得他更像哪一边？',
              options: [
                { text: AXES[i].leftCn, picks: AXES[i].left },
                { text: AXES[i].rightCn, picks: AXES[i].right }
              ],
              forced: true,
              noUnknown: true
            };
          }
        }
      }
      // 这道强制题已经问过了却仍未判定（调用方违规给了空作答）——
      // 再问一遍只会死循环，直接放弃这个轴。
      session.forced.shift();
      return nextQuestion(session, bank);
    }
  
    // ---- 2. 轮转出题 ----
    // 在所有"未判定"的轴里挑**已出题数最少**的那个（并列时按 AXES 顺序）。
    // 不能简单地"取第一个未判定的轴"：那会把一个轴连问 3 道才换下一个，
    // 用户感觉像在反复问同一件事，总题数也会涨到 12 道以上，
    // 与"通常不超过 10 道"的目标冲突。
    var bestAxis = null;
    var bestCount = Infinity;
    for (i = 0; i < AXES.length; i++) {
      k = AXES[i].key;
      if (isAxisResolved(session, k)) { continue; }
      // 强制题问过仍定不下来 → 这个轴放弃，不再参与出题
      if (session.askedIds['forced-' + k]) { continue; }
      var askedCount = 0;
      for (j = 0; j < session.answers.length; j++) {
        if (session.answers[j].axis === k) { askedCount++; }
      }
      if (askedCount < bestCount) { bestCount = askedCount; bestAxis = k; }
    }
  
    if (bestAxis) {
      var qs = [];
      for (j = 0; j < bank.length; j++) {
        if (bank[j].axis === bestAxis) { qs.push(bank[j]); }
      }
      for (j = 0; j < qs.length; j++) {
        if (!session.askedIds[qs[j].id]) { return qs[j]; }
      }
      // 该轴题库用尽仍未判定 → 进强制阶段
      var inForced = false;
      for (j = 0; j < session.forced.length; j++) {
        if (session.forced[j] === bestAxis) { inForced = true; break; }
      }
      if (!inForced) { session.forced.push(bestAxis); }
      return nextQuestion(session, bank);
    }
  
    return null;
  }
  
  function answer(session, question, pick) {
    // 参数守卫：传错成 q.id（字符串）之类会让题目永远标记不成"已问过"，
    // 表现是问卷无限重复同一题 —— 宁可当场报错，也不要静默死循环。
    if (!question || typeof question !== 'object' || !question.id || !question.axis) {
      throw new Error('Quiz.answer 需要题目对象（含 id 与 axis），收到了: ' + typeof question);
    }
    session.answers.push({ id: question.id, axis: question.axis, pick: pick });
    session.askedIds[question.id] = true;
    var i;
    if (question.forced) {
      var nf = [];
      for (i = 0; i < session.forced.length; i++) {
        if (session.forced[i] !== question.axis) { nf.push(session.forced[i]); }
      }
      session.forced = nf;
    } else {
      session.cursor[question.axis] = (session.cursor[question.axis] || 0) + 1;
    }
    var all = true;
    for (i = 0; i < AXES.length; i++) {
      if (!isAxisResolved(session, AXES[i].key)) { all = false; break; }
    }
    session.done = all;
    return session;
  }
  
  function isDone(session) {
    return session.done;
  }
  
  function result(session) {
    var out = {};
    var i;
    for (i = 0; i < AXES.length; i++) {
      if (!isAxisResolved(session, AXES[i].key)) { return null; }
    }
    for (i = 0; i < AXES.length; i++) {
      var letter = resolvedLetter(session, AXES[i].key);
      // 判定完成却取不到字母（理论上不该发生）→ 当作没判定。
      // 宁可不给结果，也不能吐出一个缺字母的"类型"。
      if (!letter) { return null; }
      out[AXES[i].key] = letter;
    }
    return out;
  }
  
  function progress(session) {
    var resolved = 0;
    var perAxis = {};
    for (var i = 0; i < AXES.length; i++) {
      var k = AXES[i].key;
      var s = axisOf(session, k);
      if (isAxisResolved(session, k)) { resolved++; }
      perAxis[k] = {
        valid: s.valid,
        unknown: s.unknown,
        pick: resolvedLetter(session, k)
      };
    }
    return {
      asked: session.answers.length,
      resolved: resolved,
      total: AXES.length,
      perAxis: perAxis
    };
  }

  // ---- 题库 ----
  var QUESTIONS = [
    { id: 'ie-1', axis: 'IE', scene: '周六下午他在家待了一整天，晚上朋友发消息问要不要出来吃夜宵',
      ask: '你觉得他会怎么回？',
      options: [
        { text: '正好在家闷得慌，马上换衣服出门', picks: 'E' },
        { text: '今天一个人待着挺舒服，改天再约吧', picks: 'I' }
      ] },
    { id: 'ie-2', axis: 'IE', scene: '开会时领导突然点名，让他说说对新方案的看法',
      ask: '你觉得他会怎么应对？',
      options: [
        { text: '先说自己还没想透，会后整理好再发给大家', picks: 'I' },
        { text: '当场就讲，想到哪说到哪，边说边理清思路', picks: 'E' }
      ] },
    { id: 'ie-3', axis: 'IE', scene: '部门组织团建，十几个人要去郊区玩两天一夜',
      ask: '你觉得他回来之后什么状态？',
      options: [
        { text: '玩得很尽兴，回来还意犹未尽地翻照片', picks: 'E' },
        { text: '人是开心的，但回来只想关上门安静一晚', picks: 'I' }
      ] },
    { id: 'ns-1', axis: 'NS', scene: '他打算买一台新电脑，预算八千块',
      ask: '你觉得他会怎么挑？',
      options: [
        { text: '先想好这台电脑能陪他干多少事，越想越兴奋', picks: 'N' },
        { text: '列出配置表一项项比，问清楚售后和散热再下单', picks: 'S' }
      ] },
    { id: 'ns-2', axis: 'NS', scene: '饭桌上朋友聊起最近看的一部电影，问他觉得怎么样',
      ask: '你觉得他会怎么聊？',
      options: [
        { text: '讲哪个镜头印象深刻，哪个演员演得好，剧情怎么走的', picks: 'S' },
        { text: '聊这电影让他想到的事，说着说着就扯到别的话题上了', picks: 'N' }
      ] },
    { id: 'ns-3', axis: 'NS', scene: '同事拉他一起讨论一个刚起步的小项目',
      ask: '你觉得他更关心什么？',
      options: [
        { text: '这事以后能做成什么样，有没有可能玩出大花样', picks: 'N' },
        { text: '第一步先干什么，谁来做，下周能不能看到东西', picks: 'S' }
      ] },
    { id: 'tf-1', axis: 'TF', scene: '晚上十点，好朋友打电话来，说被领导当众骂了一顿，声音都在抖',
      ask: '你觉得他会怎么接话？',
      options: [
        { text: '先陪朋友骂几句领导，等他缓过来再说别的', picks: 'F' },
        { text: '问清来龙去脉，帮朋友分析这事到底谁占理', picks: 'T' }
      ] },
    { id: 'tf-2', axis: 'TF', scene: '群里两个熟人因为拼单退款的事吵了起来，越吵越凶',
      ask: '你觉得他会怎么处理？',
      options: [
        { text: '出来打圆场，各给台阶下，别把关系闹僵了', picks: 'F' },
        { text: '把规则翻出来说清楚，该退多少就退多少', picks: 'T' }
      ] },
    { id: 'tf-3', axis: 'TF', scene: '他做的方案在评审会上被前辈当场指出一个漏洞',
      ask: '你觉得他心里怎么想？',
      options: [
        { text: '漏洞确实在，当场认了，回去赶紧改', picks: 'T' },
        { text: '话可以私下说，当众让人下不来台有点难受', picks: 'F' }
      ] },
    { id: 'pj-1', axis: 'PJ', scene: '公司临时通知周五多放一天假，连上周末有三天',
      ask: '你觉得他会怎么安排？',
      options: [
        { text: '太好了，先睡到自然醒，起来再看想去哪', picks: 'P' },
        { text: '当晚就排好三天怎么过，哪天去哪都定下来', picks: 'J' }
      ] },
    { id: 'pj-2', axis: 'PJ', scene: '他和朋友约了下个月去云南玩六天',
      ask: '你觉得出发前他会准备成什么样？',
      options: [
        { text: '订好机票和第一晚住宿就行，剩下的到了再说', picks: 'P' },
        { text: '行程表精确到上午下午，餐厅都提前收藏好了', picks: 'J' }
      ] },
    { id: 'pj-3', axis: 'PJ', scene: '项目进行到一半，领导突然把他调去负责另一摊事',
      ask: '你觉得他会是什么反应？',
      options: [
        { text: '原计划全打乱了，心里别扭好一阵才缓过来', picks: 'J' },
        { text: '新摊子还有点意思，收拾收拾就上手了', picks: 'P' }
      ] }
  ];

  return {
    AXES: AXES,
    MIN_VALID: MIN_VALID,
    QUESTIONS: QUESTIONS,
    createSession: createSession,
    axisOf: axisOf,
    isAxisResolved: isAxisResolved,
    resolvedLetter: resolvedLetter,
    nextQuestion: nextQuestion,
    answer: answer,
    isDone: isDone,
    result: result,
    progress: progress
  };
});

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
    out[AXES[i].key] = resolvedLetter(session, AXES[i].key);
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
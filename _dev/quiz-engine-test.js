'use strict';
/**
 * 场景问卷引擎单测 —— 推题规则、判定规则、收敛性。
 *
 * 为什么单独测：引擎是纯逻辑，一旦出问题表现是"问卷卡住不动"或"结果错一个字母"，
 * 后者在界面上几乎看不出来。而且要保证**任何作答路径都能收敛**，
 * 特别是全部答"我不知道"这种最坏情况。
 *
 * 用法: node _dev/quiz-engine-test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.resolve(__dirname, '..', 'web', 'js', 'quiz.js');
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/** 在「没有 module」的沙箱里跑 UMD，模拟浏览器 */
function loadQuiz() {
  const sandbox = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  return sandbox.Quiz;
}

const Quiz = loadQuiz();

/**
 * 全自动跑完一次问卷。
 * @param makePick (question, index) => 字母 | null
 * @returns { steps, picks, result, session }
 */
function run(makePick) {
  const session = Quiz.createSession();
  const steps = [];
  let guard = 0;
  for (;;) {
    if (++guard > 500) throw new Error('推题不收敛，超过 500 步');
    const q = Quiz.nextQuestion(session, Quiz.QUESTIONS);
    if (!q) break;
    steps.push(q);
    const pick = makePick(q, steps.length - 1);
    Quiz.answer(session, q, pick);
  }
  return { steps, result: Quiz.result(session), session };
}

/* ------------------------------------------------------------------ */
console.log('\n场景问卷引擎单测\n');

console.log('▸ 题库结构');
ok('导出项齐全',
  ['AXES', 'QUESTIONS', 'createSession', 'nextQuestion', 'answer', 'result', 'progress']
    .every((k) => Quiz[k] !== undefined));
ok('12 道题', Quiz.QUESTIONS.length === 12, '实际 ' + Quiz.QUESTIONS.length);
ok('四个轴各 3 道',
  Quiz.AXES.every((a) => Quiz.QUESTIONS.filter((q) => q.axis === a.key).length === 3));
const badPicks = Quiz.QUESTIONS.filter((q) => {
  const ax = Quiz.AXES.find((a) => a.key === q.axis);
  return q.options.length !== 2 || q.options.some((o) => o.picks !== ax.left && o.picks !== ax.right);
});
ok('每题 2 个选项且 picks 都落在本轴的左右两端', badPicks.length === 0,
  badPicks.map((q) => q.id).join(','));
const sameBoth = Quiz.QUESTIONS.filter((q) => q.options[0].picks === q.options[1].picks);
ok('没有"两个选项指向同一端"的废题', sameBoth.length === 0, sameBoth.map((q) => q.id).join(','));
const idSet = {};
let dup = 0;
Quiz.QUESTIONS.forEach((q) => { if (idSet[q.id]) dup++; idSet[q.id] = true; });
ok('题 id 不重复', dup === 0);

console.log('\n▸ 一致作答：应当尽快收敛');
{
  // "评价人心里有数"：每个轴都按同一个方向答（不是"每题都点第一个选项"——
  // 题库里选项顺序是打散的，那样答出来会自相矛盾）
  const WANT = { IE: 'I', NS: 'N', TF: 'T', PJ: 'P' };
  const pickTarget = (q) => q.options.find((o) => o.picks === WANT[q.axis]).picks;
  const r = run(pickTarget);
  ok('不会重复出题', new Set(r.steps.map((s) => s.id)).size === r.steps.length);
  ok('8 题就结束（每轴 2 题即可判定）', r.steps.length === 8, '实际 ' + r.steps.length + ' 题');
  ok('结果就是每轴 2 票那一侧',
    r.result && JSON.stringify(r.result) === JSON.stringify(WANT), JSON.stringify(r.result));
  ok('结果键名固定为 IE/NS/TF/PJ',
    JSON.stringify(Object.keys(r.result).sort()) === JSON.stringify(['IE', 'NS', 'PJ', 'TF']),
    JSON.stringify(Object.keys(r.result)));
  ok('没有出现强制题（题库够用）', r.steps.every((s) => !s.forced));
}

console.log('\n▸ 出题顺序：按 IE → NS → TF → PJ 轮转');
{
  const WANT = { IE: 'I', NS: 'N', TF: 'T', PJ: 'P' };
  const r = run((q) => q.options.find((o) => o.picks === WANT[q.axis]).picks);
  const order = r.steps.map((s) => s.axis).join(',');
  ok('顺序是 IE,NS,TF,PJ,IE,NS,TF,PJ',
    order === 'IE,NS,TF,PJ,IE,NS,TF,PJ', order);
  ok('同一个轴不会连着问两次',
    r.steps.every((s, i) => i === 0 || s.axis !== r.steps[i - 1].axis));
}

console.log('\n▸ "我不知道"不推进判定');
{
  const session = Quiz.createSession();
  // 连答 3 道 IE 的"我不知道"
  let asked = 0;
  for (;;) {
    const q = Quiz.nextQuestion(session, Quiz.QUESTIONS);
    if (!q) break;
    if (q.axis === 'IE' && !q.forced) {
      Quiz.answer(session, q, null);
      asked++;
      if (asked === 3) break;
    } else {
      Quiz.answer(session, q, q.options[0].picks);
    }
  }
  const st = Quiz.axisOf(session, 'IE');
  ok('IE 轴记到 3 条"我不知道"', st.unknown === 3 && st.valid === 0,
    JSON.stringify(st));
  ok('IE 轴仍未判定', Quiz.isAxisResolved(session, 'IE') === false);
  ok('progress.perAxis.IE.pick 为 null', Quiz.progress(session).perAxis.IE.pick === null);
}

console.log('\n▸ 平票不算判定');
{
  const session = Quiz.createSession();
  // IE 轴第一题选 I、第二题选 E → 1:1
  let ieCount = 0;
  for (;;) {
    const q = Quiz.nextQuestion(session, Quiz.QUESTIONS);
    if (!q) break;
    if (q.axis === 'IE' && !q.forced) {
      ieCount++;
      Quiz.answer(session, q, ieCount === 1 ? 'I' : 'E');
      if (ieCount === 2) break;
    } else {
      Quiz.answer(session, q, null);
    }
  }
  const st = Quiz.axisOf(session, 'IE');
  ok('IE 轴 1:1', st.left === 1 && st.right === 1, JSON.stringify(st));
  ok('平票时不算判定完成', Quiz.isAxisResolved(session, 'IE') === false);
}

console.log('\n▸ 最坏情况 A：题库全答"我不知道"，强制题正常作答（必须收敛且给结果）');
{
  let r;
  try {
    r = run((q) => (q.forced ? q.options[0].picks : null));
  } catch (e) {
    ok('不会死循环', false, e.message);
  }
  if (r) {
    ok('走完 12 道题库题', r.steps.filter((s) => !s.forced).length === 12,
      '实际 ' + r.steps.filter((s) => !s.forced).length);
    ok('随后依次给出 4 道强制题', r.steps.filter((s) => s.forced).length === 4,
      '实际 ' + r.steps.filter((s) => s.forced).length);
    ok('强制题顺序为 IE,NS,TF,PJ',
      r.steps.filter((s) => s.forced).map((s) => s.axis).join(',') === 'IE,NS,TF,PJ',
      r.steps.filter((s) => s.forced).map((s) => s.axis).join(','));
    ok('总题数 16', r.steps.length === 16, '实际 ' + r.steps.length);
    ok('最终仍能给出完整四字母结果', !!r.result && Object.keys(r.result).length === 4,
      JSON.stringify(r.result));
    ok('答案里没有 null 字母',
      r.result && Object.values(r.result).every((v) => typeof v === 'string' && v.length === 1),
      JSON.stringify(r.result));
  }
}

console.log('\n▸ 最坏情况 B：连强制题也不作答（调用方违规）—— 必须终止而不是死循环');
{
  let r;
  try {
    r = run(() => null);
  } catch (e) {
    ok('不会死循环', false, e.message);
  }
  if (r) {
    ok('步数有限（≤ 20 题）', r.steps.length <= 20, '实际 ' + r.steps.length);
    ok('不会重复出同一道强制题',
      new Set(r.steps.filter((s) => s.forced).map((s) => s.id)).size ===
      r.steps.filter((s) => s.forced).length);
    ok('拿不到完整类型时 result() 返回 null（交给界面优雅提示）', r.result === null,
      JSON.stringify(r.result));
  }
}

console.log('\n▸ 强制题的特性');
{
  const r = run((q) => (q.forced ? q.options[0].picks : null));
  const forced = r.steps.filter((s) => s.forced);
  ok('强制题带 forced 标记', forced.every((s) => s.forced === true));
  ok('强制题带 noUnknown 标记（界面据此不渲染"我不知道"）',
    forced.every((s) => s.noUnknown === true));
  ok('强制题只有 2 个选项', forced.every((s) => s.options.length === 2));
  ok('强制题的两个选项分别指向本轴左右两端', forced.every((s) => {
    const ax = Quiz.AXES.find((a) => a.key === s.axis);
    return s.options[0].picks === ax.left && s.options[1].picks === ax.right;
  }));
  ok('强制题不会重复出现', new Set(forced.map((s) => s.id)).size === forced.length);
}

console.log('\n▸ 部分"我不知道"时按需补题');
{
  // 前两轮（4 题）都答"我不知道"，之后正常答
  const WANT = { IE: 'I', NS: 'N', TF: 'T', PJ: 'P' };
  const r = run((q, i) => (i < 4 ? null : q.options.find((o) => o.picks === WANT[q.axis]).picks));
  ok('会超过 8 题（补题）', r.steps.length > 8, '实际 ' + r.steps.length);
  ok('不需要走到强制题', r.steps.every((s) => !s.forced),
    '实际 ' + r.steps.filter((s) => s.forced).length + ' 道强制题');
  ok('仍有完整结果',
    r.result && JSON.stringify(r.result) === JSON.stringify(WANT), JSON.stringify(r.result));
}

console.log('\n▸ result() 在未判定时必须返回 null');
{
  const session = Quiz.createSession();
  ok('空会话 result() 为 null', Quiz.result(session) === null);
  const q = Quiz.nextQuestion(session, Quiz.QUESTIONS);
  Quiz.answer(session, q, q.options[0].picks);
  ok('只答 1 题时 result() 仍为 null', Quiz.result(session) === null);
}

console.log('\n▸ progress()');
{
  const session = Quiz.createSession();
  const p0 = Quiz.progress(session);
  ok('初始 asked=0', p0.asked === 0);
  ok('初始 resolved=0', p0.resolved === 0);
  ok('total=4', p0.total === 4);
  const q = Quiz.nextQuestion(session, Quiz.QUESTIONS);
  Quiz.answer(session, q, q.options[0].picks);
  const p1 = Quiz.progress(session);
  ok('答 1 题后 asked=1', p1.asked === 1);
  ok('perAxis 有四个轴', Object.keys(p1.perAxis).length === 4);
}

console.log('\n▸ isDone()');
{
  const r = run((q) => q.options[0].picks);
  ok('结束后 isDone 为 true', Quiz.isDone(r.session) === true);
  ok('结束后 nextQuestion 返回 null',
    Quiz.nextQuestion(r.session, Quiz.QUESTIONS) === null);
}

console.log('\n' + '='.repeat(52));
console.log('  通过 ' + pass + ' / 失败 ' + fail);
if (fail) console.log('  失败项:\n' + failures.map((f) => '    - ' + f).join('\n'));
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);

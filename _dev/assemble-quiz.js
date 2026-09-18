'use strict';
// 把 Kimi 产出的「引擎」与「题库」拼成一个 UMD 文件 web/js/quiz.js，
// 并做几项静态校验（数量、id 唯一、picks 合法、四轴齐全）。
const fs = require('node:fs');

const engine = fs.readFileSync('_dev/out/quiz-engine.js', 'utf8').trimEnd();
const bank = fs.readFileSync('_dev/out/quiz-bank.js', 'utf8').trimEnd();

// ---- 防御性补丁：result() 必须保证四轴字母都非 null ----------
// 用「起止标记 + 花括号配平」定位，避免逐字符匹配踩空白差异
function replaceFunction(src, sig) {
  const start = src.indexOf(sig);
  if (start < 0) return null;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return { from: start, to: k + 1 };
    }
  }
  return null;
}

const NEW_RESULT = `function result(session) {
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
}`;

const span = replaceFunction(engine, 'function result(session)');
if (!span) {
  console.error('❌ 找不到 result()，无法打防御补丁');
  process.exit(1);
}
const patchedEngine = engine.slice(0, span.from) + NEW_RESULT + engine.slice(span.to);
console.log('  ✅ 已给 result() 打上「字母非空」防御补丁');

// ---- 静态校验题库 ----
const QUESTIONS = eval(bank + ';QUESTIONS');   // 本地可控输入，仅用于校验
const problems = [];
const ids = {};
const AXES = [
  { key: 'IE', left: 'I', right: 'E' },
  { key: 'NS', left: 'N', right: 'S' },
  { key: 'TF', left: 'T', right: 'F' },
  { key: 'PJ', left: 'P', right: 'J' }
];
const perAxis = {};
QUESTIONS.forEach((q) => {
  if (ids[q.id]) problems.push('重复 id: ' + q.id);
  ids[q.id] = true;
  const ax = AXES.find((a) => a.key === q.axis);
  if (!ax) { problems.push(q.id + ' 的 axis 非法: ' + q.axis); return; }
  perAxis[q.axis] = (perAxis[q.axis] || 0) + 1;
  if (!q.scene || !q.ask) problems.push(q.id + ' 缺少 scene/ask');
  if (!Array.isArray(q.options) || q.options.length !== 2) {
    problems.push(q.id + ' 的 options 不是恰好 2 个');
    return;
  }
  const picks = q.options.map((o) => o.picks);
  picks.forEach((p) => {
    if (p !== ax.left && p !== ax.right) problems.push(q.id + ' 的 picks 非法: ' + p);
  });
  if (picks[0] === picks[1]) problems.push(q.id + ' 两个选项指向同一端: ' + picks.join('/'));
  q.options.forEach((o) => { if (!o.text) problems.push(q.id + ' 有选项缺 text'); });
});
AXES.forEach((a) => {
  const n = perAxis[a.key] || 0;
  if (n < 2) problems.push(a.key + ' 只有 ' + n + ' 道题（要求 ≥2）');
});

console.log('  题库：共 ' + QUESTIONS.length + ' 道');
AXES.forEach((a) => console.log('    ' + a.key + ' → ' + (perAxis[a.key] || 0) + ' 道'));
if (problems.length) {
  console.error('❌ 题库校验未通过：');
  problems.forEach((p) => console.error('   - ' + p));
  process.exit(1);
}
console.log('  ✅ 题库校验通过（id 唯一 / picks 合法 / 两端不重合 / 每轴 ≥2 道）');

// ---- 拼装 UMD ----
const out = `'use strict';
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

${patchedEngine.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')}

  // ---- 题库 ----
${bank.replace(/^var QUESTIONS = \[/, 'var QUESTIONS = [').split('\n').map((l) => (l ? '  ' + l : l)).join('\n')}

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
`;

fs.writeFileSync('web/js/quiz.js', out);
console.log('  ✅ 已生成 web/js/quiz.js（' + out.length + ' 字节）');

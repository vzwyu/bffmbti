# 任务：MBTI 场景问卷的「推题引擎」（纯逻辑，ES5）

## 运行环境（硬约束）

- 纯浏览器，**只能用 ES5**（`var` / `function`；禁止 `let` `const` 箭头函数
  模板字符串 `?.` `??` 解构 展开 `class`）
- 不操作 DOM、不发网络请求、不读写 `window`、不 `console.log`
- **不要**输出 UMD 包装，只输出下面这几个函数与常量（我自己拼装文件）

## 交付物（只输出这些，不要解释、不要 markdown 围栏）

按顺序输出：

```js
var AXES = [ ... ];
var MIN_VALID = 2;
function createSession() { ... }
function axisOf(session, axisKey) { ... }
function isAxisResolved(session, axisKey) { ... }
function resolvedLetter(session, axisKey) { ... }
function nextQuestion(session, bank) { ... }
function answer(session, question, pick) { ... }
function isDone(session) { ... }
function result(session) { ... }
function progress(session) { ... }
```

## 常量

```js
// 顺序固定；拼 MBTI 码时按这个顺序取字母
var AXES = [
  { key: 'IE', left: 'I', right: 'E', leftCn: '更爱独处', rightCn: '更爱热闹' },
  { key: 'NS', left: 'N', right: 'S', leftCn: '更看可能性', rightCn: '更看事实' },
  { key: 'TF', left: 'T', right: 'F', leftCn: '先讲道理', rightCn: '先照顾感受' },
  { key: 'PJ', left: 'P', right: 'J', leftCn: '留余地', rightCn: '早定下来' }
];

// 一个轴判定完成所需的最少「有效回答」条数
var MIN_VALID = 2;
```

`bank` 是题库数组，由调用方传入。每条形如：

```js
{ id: 'ie-1', axis: 'IE', scene: '……', ask: '……',
  options: [ { text: '……', picks: 'I' }, { text: '……', picks: 'E' } ] }
```

## `createSession()` → 普通对象（**不要用 class**）

```js
{
  answers: [],      // [{ id, axis, pick }]，pick 为 null 表示"我不知道"
  askedIds: {},     // 已出过的题 id → true（去重）
  cursor: {},       // 每个轴下一次从该轴题库取第几条
  forced: [],       // 待强制二选一的轴 key，按加入顺序
  done: false
}
```

## `axisOf(session, axisKey)` → 该轴的答题统计（内部用，也要导出）

```js
{ valid: 2, unknown: 1, left: 1, right: 1, tie: true }
```

- `valid` = pick 不为 null 的条数
- `unknown` = pick 为 null 的条数
- `left` / `right` = 分别投给该轴 left / right 的票数
- `tie` = `left === right`

## `isAxisResolved(session, axisKey)` → 布尔

**当且仅当**：`valid >= MIN_VALID` **且** `left !== right`。

（即 2:0、2:1、3:1 判定完成；1:1、2:2、1:0 不算。）

## `resolvedLetter(session, axisKey)` → 判定的字母，未判定返回 `null`

票数多的一侧；`left > right` 返回该轴 `left`，`right > left` 返回 `right`。

## `nextQuestion(session, bank)` → 下一题对象，或 `null`

**严格按此顺序：**

1. `session.done` 为真 → `null`
2. **强制阶段**：若 `session.forced` 非空，取第一个轴 `k`，返回该轴的强制题：
   ```js
   {
     id: 'forced-' + k,          // 注意 k 是轴 key，例如 'forced-IE'
     axis: k,
     scene: '最后一题，必须选一个',
     ask: '实在拿不准的话，你觉得他更像哪一边？',
     options: [
       { text: <该轴 leftCn>,  picks: <该轴 left> },
       { text: <该轴 rightCn>, picks: <该轴 right> }
     ],
     forced: true,
     noUnknown: true              // 调用方据此**不渲染**"我不知道"
   }
   ```
   注意：`leftCn` / `rightCn` 从 `AXES` 里取。
3. **轮转出题**：按 `AXES` 顺序 IE → NS → TF → PJ → IE → … 找第一个"还能出题且未判定"的轴。
   对某个轴 `k`：
   - 若 `isAxisResolved(session, k)` → 跳过
   - 否则从 `bank` 里筛出 `axis === k` 的题（保持题库原顺序），
     用 `session.cursor[k]`（初始 0）逐条推进，跳过 `askedIds` 里已有的；
     找到第一条没出过的 → 返回它（**不要**在这里改 cursor，改 cursor 放在 `answer` 里）
   - 该轴题库已用尽且仍未判定 → 把 `k` 推入 `session.forced`（去重），继续找下一个轴
4. 若四个轴都轮不到（都判定了，或都进了 forced）→ 回到第 2 步
5. 若 `forced` 为空且所有轴都判定完成 → 返回 `null`

## `answer(session, question, pick)` → 返回 `session`

- 把 `{ id: question.id, axis: question.axis, pick: pick }` 推入 `session.answers`
- `session.askedIds[question.id] = true`
- **推进 cursor**：把 `session.cursor[question.axis]` 设成
  「该轴题库里这道题的序号 + 1」（这样下次换下一题）。
  简单做法：`session.cursor[question.axis] = (session.cursor[question.axis] || 0) + 1`
  —— 前提是**出题顺序与题库顺序一致**（本引擎就是这么出的）。
  若该题是**强制题**（`question.forced` 为真），从 `session.forced` 里移除该轴，**不要**推进 cursor。
- 每次回答后重新判断：**四个轴全部 `isAxisResolved` → `session.done = true`**
- 返回 `session`

## `isDone(session)` → 布尔（直接返回 `session.done`）

## `result(session)` → `{ IE:'I', NS:'N', TF:'T', PJ:'J' }` 或 `null`

- 四个轴全部 `isAxisResolved` 才返回对象；任一未判定返回 `null`
- 键名固定用 `AXES[].key`，值用 `resolvedLetter` 的结果

## `progress(session)` → `{ asked, resolved, total, perAxis }`

- `asked` = `session.answers.length`
- `resolved` = 已判定轴数
- `total` = `AXES.length`
- `perAxis[axisKey]` = `{ valid, unknown, pick }`，`pick` 为 `resolvedLetter`（未判定为 null）

## 必须满足的行为（我会写单测逐条验）

1. 同一题 id 在一次会话里只出现一次
2. **能提前结束**：若每轴前 2 题答案一致，之后 `nextQuestion` 返回 `null`，`result()` 有完整四字母
3. **"我不知道"不推进判定**
4. **兜底必然收敛**：即使**全部回答"我不知道"**，
   走完题库后也必须依次给出 4 道强制题并结束，`result()` 必须返回完整四字母，
   **不允许死循环、不允许返回 null**
5. 花括号配平；无禁用语法

## 自检

在脑子里跑一遍：题库每轴 3 题、共 12 题，全部答"我不知道" →
应当出完 12 题后依次出 `forced-IE / forced-NS / forced-TF / forced-PJ`，然后 `nextQuestion` 返回 `null`。

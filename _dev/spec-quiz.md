# 任务：MBTI 场景问卷 —— 题库 + 推题引擎

## 运行环境（硬约束）

- 纯浏览器，**零第三方依赖**，**只能用 ES5 语法**
  （`var` / `function`；禁止 `let` `const` 箭头函数 模板字符串 `?.` `??` 解构 展开 `class`）
- 产出会被当普通 script 拼进 bundle 执行：**禁止** `import` / `export` / `require`
- 不操作 DOM、不发网络请求 —— 只做纯数据与纯逻辑

## 交付物：一个完整的 UMD 文件 `web/js/quiz.js`

结构照抄（这是一个真实可用的 UMD 骨架，**请原样保留这段包装**）：

```js
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Quiz = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ... 你的实现 ...

  return {
    QUESTIONS: QUESTIONS,
    AXES: AXES,
    createSession: createSession,
    nextQuestion: nextQuestion,
    answer: answer,
    isDone: isDone,
    result: result,
    progress: progress
  };
});
```

**只输出这一个文件的完整内容，不要解释、不要 markdown 围栏、不要输出其它东西。**

---

## 一、常量

```js
// 四个维度，顺序固定（拼 MBTI 码时就按这个顺序取字母）
var AXES = [
  { key: 'IE', left: 'I', right: 'E' },
  { key: 'NS', left: 'N', right: 'S' },
  { key: 'TF', left: 'T', right: 'F' },
  { key: 'PJ', left: 'P', right: 'J' }
];
```

## 二、题库 `QUESTIONS`

### 题目格式（**每个字段都要有，命名不能改**）

```js
{
  id: 'ie-1',                       // 全局唯一
  axis: 'IE',                       // 必须是 AXES 里某个 key
  scene: '周五下班前十分钟，同事临时喊他去唱歌',
  ask: '你觉得他会怎么回应？',        // 问句
  options: [
    { text: '先答应下来，人多热闹', picks: 'E' },   // picks 必须是该轴的 left 或 right
    { text: '找理由推掉，想自己待着', picks: 'I' }
  ]
}
```

### 内容要求（这是重点，请认真写）

1. **每个维度不少于 3 道题**，四个维度共 **12 道**（IE / NS / TF / PJ 各 3 道）
2. 场景必须是**日常生活里真的会发生的事**，不要抽象、不要心理学黑话。
   好的场景像：被临时叫去聚会、点外卖、队里出了岔子、朋友来诉苦、
   收到一个坏消息、要买个大件、和陌生人拼车、临出门发现下雨、
   有人当众否定他的方案、给朋友挑生日礼物、群里有人吵架、周末临时多出一天假。
   **不要**用"你认为他是内向还是外向"这种直接问类型的写法。
3. 两个选项都必须**具体、有画面**，不要一边写满一边写空，
   也不要明显一个"好"一个"坏"（会诱导作答）。
4. 每题只有 **2 个选项**。"我不知道"由引擎统一加，题库里**不要**出现。
5. 文案风格：短句，像朋友间聊天。不要用"倾向于""通常来说""一般来说"这类堆砌词。

### 选项与维度的对应（**必须正确，这是最容易错的地方**）

| 轴 | left 端 | right 端 |
|---|---|---|
| IE | `I` 独处充电、先想再说、小圈子 | `E` 与人互动充电、边说边想、大圈子 |
| NS | `N` 看可能性与寓意、爱抽象、跳跃 | `S` 看事实与细节、务实、按部就班 |
| TF | `T` 先讲道理与标准、就事论事 | `F` 先照顾感受与关系、讲人情 |
| PJ | `P` 留余地、随时改、先做后定 | `J` 早定计划、按步骤、先定后做 |

**违反这一栏的题目等于废题，我会逐题核对。**

## 三、引擎（纯逻辑，必须可独立单测）

### 会话状态

`createSession()` 返回一个**普通对象**（不要用 class），至少含：
```js
{
  answers: [],        // [{ questionId, axis, pick }]  pick 为 null 表示"我不知道"
  askedIds: {},       // 已出过的题 id（去重，避免重复出题）
  cursor: {},         // 每个轴下一次该从题库第几条取
  forced: {},         // 需要"强制二选一"的轴
  done: false
}
```

### `nextQuestion(session)` → 下一题对象，或 `null`（表示问卷结束）

**推题规则（严格按此实现，顺序不能变）：**

1. 若 `done` 为真 → 返回 `null`
2. 若有**待强制二选一**的轴（见下面的兜底）→ 返回该轴的强制题：
   ```js
   {
     id: 'forced-IE',
     axis: 'IE',
     scene: '最后一题，必须选一个',
     ask: '实在拿不准的话，你觉得他更像哪一边？',
     options: [ { text: <leftCn>, picks: 'I' }, { text: <rightCn>, picks: 'E' } ],
     forced: true,        // 标记：这一题不提供"我不知道"
     noUnknown: true
   }
   ```
   `<leftCn>` / `<rightCn>` 用中文短描述（自己写，例如 `'更爱独处'` / `'更爱热闹'`），**不要**只写单个字母。
3. 否则按 **AXES 的顺序轮转**出题：IE → NS → TF → PJ → IE → NS → …
   - 对每个轴，取该轴题库里第一条**还没出过**的题（用 `cursor[axis]` 推进）
   - 如果轮到的轴**题库已用尽**且仍未判定 → 记录为待强制轴，跳到下一个轴
   - 如果四个轴都出不了题 → 把仍未判定的轴加入待强制列表，回到第 2 步
4. **已经判定的轴不再出题**（判定规则见下），直接跳到下一个轴
5. 返回 `null` 当且仅当：所有轴都已判定，或所有轴都已进入强制阶段并答完

### `answer(session, questionId, pick)` → 更新 `session` 并返回它

- `pick` 为 `'I' / 'E' / 'N' / 'S' / 'T' / 'F' / 'P' / 'J'` 之一，或 `null`（我不知道）
- 把 `{ questionId, axis, pick }` 推入 `answers`
- 每次回答后重新评估：**所有轴都判定完成 → `done = true`**
- 若某轴题库已用尽且仍未判定 → 把它加入 `forced`（待强制）

### 判定规则（**这是核心，请看准**）

一个轴"判定完成"当且仅当：
- 该轴**有效回答**（pick 不为 null）**≥ 2 条**，**且**
- 其中一侧的票数**严格多于**另一侧

（即 2:0、2:1、3:1 算判定；1:1、2:2、1:0 不算。"我不知道"不计入票数。）

判定出的字母：票数多的一侧。

### `isDone(session)` → 布尔

### `result(session)` → `{ IE:'I', NS:'N', TF:'T', PJ:'J' }` 或 `null`

- 四个轴全部判定完成才返回对象，否则返回 `null`
- 键名就是 `AXES[].key`，值是判定出的字母

### `progress(session)` → `{ asked, resolved, total, perAxis }`

- `asked` = 已回答题数
- `resolved` = 已判定完成的轴数
- `total` = 4
- `perAxis` = `{ IE: {valid:2, unknown:0, pick:'I'}, ... }`

---

## 四、必须满足的行为约束（我会写单测逐条验）

1. **不会重复出题**：同一题 id 在一次会话里只出现一次
2. **能提前结束**：若前 8 题（每轴 2 题）答案一致，第 9 题时 `nextQuestion` 返回 `null`
3. **"我不知道"不会推进判定**：连答 3 个"我不知道"后该轴仍未判定
4. **兜底必然收敛**：即使**全部回答"我不知道"**，最终也必须进入强制二选一，
   并且强制题答完后 `result()` 返回一个完整的四字母结果（**不允许死循环、不允许返回 null**）
5. **结果的轴顺序**：键名固定为 IE/NS/TF/PJ，不要用别的命名
6. 纯函数风格：不改全局变量，不读写 `window`，不 `console.log`
7. 花括号配平；不要 `Math.random`

## 五、自检

写完后请在脑子里跑一遍这两个场景，确认不会死循环：
- 场景 A：12 题全部按同一个方向答（例如每题都选 IE 的 I 侧）→ 应当在第 9 题前结束
- 场景 B：全部答"我不知道" → 应当走完 12 题后依次出 4 道强制题，结束后返回完整结果

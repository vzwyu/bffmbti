# 任务：支持「修改已提交的评价」+ 访客页重复评价弹窗加按钮

## 运行环境（硬约束）

- 后端：Node.js，**零第三方依赖**，只用内置模块；`'use strict'`；CommonJS
- 前端：浏览器，**只能用 ES5**（`var` / `function`）。禁止 `let` `const` 箭头函数
  模板字符串 `?.` `??` 解构 展开 `class`。前端代码会被拼进 bundle 当普通 script 执行，
  **禁止** `import` / `export` / `require`

## 交付物（只产出这两段，不要解释、不要 markdown 围栏、不要输出其它内容）

1. 改写后的完整函数 **`submitVote(ctx)`**（替换 `server/src/routes/vote.js` 里的同名函数）
2. 改写后的完整函数 **`confirmAlreadyVoted(user, res)`**
   （替换 `web/js/views/visitor.js` 里的同名函数）

---

# 第一部分：后端 `submitVote(ctx)`

## 现状（**这是要替换掉的完整代码**，请基于它改）

```js
// 路由 2：提交评价（无需登录，匿名访客也可）
async function submitVote(ctx) {
  const { db, config } = ctx.deps;

  checkLimit(ctx.deps.limiters.voteByIp, ctx.ip, '提交太频繁，请稍后再试');

  const target = requireActiveUser(db, ctx.params.token);

  const body = await ctx.json();
  const voterNickname = validateNickname(body && body.voter_nickname);

  // 四个轴必须严格等于该轴的 left 或 right
  const axisPicks = {};
  for (const axis of MBTI.AXES) {
    const v = body ? body[axis.key] : undefined;
    if (v !== axis.left && v !== axis.right) {
      throw makeError(400, 'invalid_axes', '请完成全部四个选择');
    }
    axisPicks[axis.key] = v;
  }

  const resultMbti = MBTI.buildCode(axisPicks);
  if (!resultMbti) {
    throw makeError(400, 'invalid_axes', '请完成全部四个选择');
  }

  // 防灌库：单个目标收到的**有效**评价总量有上限。
  // 失效的不占额度 —— 否则用户把刷屏的评价标为失效后，反倒占着名额。
  const countRow = db.prepare(
    'SELECT COUNT(*) AS n FROM votes WHERE target_user_id = ? AND invalid = 0'
  ).get(target.id);
  if ((Number(countRow && countRow.n) || 0) >= config.maxVotesPerTarget) {
    throw makeError(429, 'vote_limit_reached', '该用户收到的评价已达上限');
  }

  // 同一人重复刷票抑制：同 IP 对同目标 30 秒内只能投一次
  const lastRow = db.prepare(
    'SELECT created_at FROM votes WHERE target_user_id = ? AND voter_ip = ? ORDER BY id DESC LIMIT 1'
  ).get(target.id, ctx.ip);
  if (lastRow && lastRow.created_at) {
    const elapsed = Date.now() - new Date(lastRow.created_at).getTime();
    if (Number.isFinite(elapsed) && elapsed < DUPLICATE_WINDOW_MS) {
      throw makeError(429, 'too_soon', '刚刚已经提交过了，请稍后再试');
    }
  }

  // 未登录不报错，voter_user_id 记为 null，按匿名访客处理
  const sessionUser = getSessionUser(ctx.deps.db, ctx);
  const voterUserId = sessionUser ? sessionUser.id : null;

  db.prepare(`
    INSERT INTO votes
      (target_user_id, voter_nickname, voter_user_id, axis_ie, axis_ns, axis_tf, axis_pj,
       result_mbti, created_at, voter_ip, voter_ua)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    target.id,
    voterNickname,
    voterUserId,
    axisPicks.IE,
    axisPicks.NS,
    axisPicks.TF,
    axisPicks.PJ,
    resultMbti,
    nowIso(),
    ctx.ip,
    ctx.ua
  );

  const summary = computeSummary(db, target);

  sendJson(ctx.res, 201, {
    ok: true,
    your_choice: resultMbti,
    your_choice_detail: typeDetail(resultMbti),
    summary
  });
}
```

## 要改成什么

**核心变化：登录用户对同一个目标只能有一条评价。再次提交 = 修改原记录，而不是新增一条。**

理由：`GET /u/:token/my-vote` 会告诉前端"你已经评价过了"，前端给用户「去修改」入口。
如果修改走 INSERT，同一个人的评分权重就被刷成 2 票，统计会失真。

### 行为（严格按顺序）

1. `const { db, config } = ctx.deps;`
2. `checkLimit(ctx.deps.limiters.voteByIp, ctx.ip, '提交太频繁，请稍后再试');`
3. `const target = requireActiveUser(db, ctx.params.token);`
4. 解析请求体与四个轴（**逻辑与现状完全一致，不要改动**，含 `voterNickname` 与 `resultMbti` 的校验）
5. **把 `getSessionUser(db, ctx)` 提前到这里**（现状是在后面才取）：
   ```js
   const sessionUser = getSessionUser(db, ctx);
   const voterUserId = sessionUser ? sessionUser.id : null;
   ```
6. 查这位登录用户对这个目标是否已有一条：
   ```js
   let existing = null;
   if (voterUserId) {
     existing = db.prepare(
       'SELECT id FROM votes WHERE target_user_id = ? AND voter_user_id = ? ORDER BY id DESC LIMIT 1'
     ).get(target.id, voterUserId);
   }
   ```
7. **分两条路：**

   **(a) 已有记录 → 修改（不新增）**
   ```js
   db.prepare(`
     UPDATE votes
     SET voter_nickname = ?, axis_ie = ?, axis_ns = ?, axis_tf = ?, axis_pj = ?,
         result_mbti = ?, invalid = 0, invalid_at = NULL, voter_ip = ?, voter_ua = ?
     WHERE id = ?
   `).run(voterNickname, axisPicks.IE, axisPicks.NS, axisPicks.TF, axisPicks.PJ,
          resultMbti, ctx.ip, ctx.ua, existing.id);
   ```
   **`invalid = 0` 是刻意的**：目标之前把这条标为失效，是针对**旧内容**的；
   投票人现在提交了**新的判断**，应当重新计入统计（他仍然只有一票，不会放大权重）。
   代码里请写一行注释说明这个决定。
   - **跳过**「30 秒内重复提交」限制和「总量上限」检查 —— 这只是改一条已有记录，
     既不新增行、也不占用新额度。
   - 返回 `200`，响应里带 `updated: true`。

   **(b) 没有记录 → 新增（与现状一致）**
   - 先做「总量上限」检查（`invalid = 0` 计数）与「同 IP 30 秒内只能投一次」检查
     —— **这两段逻辑原样保留，不要删**
   - `INSERT ...`（原样保留）
   - 返回 `201`，响应里带 `updated: false`

8. 两条路最后都走同一段收尾：
   ```js
   const summary = computeSummary(db, target);
   sendJson(ctx.res, updated ? 200 : 201, {
     ok: true,
     updated,
     your_choice: resultMbti,
     your_choice_detail: typeDetail(resultMbti),
     summary
   });
   ```

### 该文件内已存在、可直接调用（不要重新实现）

```js
function makeError(status, code, message) { /* throw 用 */ }
function requireActiveUser(db, token) { /* 不存在/封禁 → 404 */ }
function computeSummary(db, userRow) { /* 参数是用户行对象 */ }
function typeDetail(code) { /* { code, cn, en, group, color } 或 null */ }
function checkLimit(limiter, ip, message) { /* 超限则 throw 429 */ }
const MBTI = require('../../../shared/mbti-types.js');
const { getSessionUser, validateNickname } = require('./auth.js');
const { tx, audit, nowIso } = require('../db.js');
const DUPLICATE_WINDOW_MS = 30 * 1000;   // 已在文件顶部定义
```

### 红线（逐条会审）
1. 禁止 `DELETE` / `DROP` / `TRUNCATE`；`ALTER` 只允许 `ADD COLUMN`
2. SQL 全参数化（`?`），禁止拼接变量
3. `getSessionUser(db, ctx)` 参数顺序不能错
4. `computeSummary(db, userRow)` 第一参数必须是**行对象**
5. 禁止 `Math.random`、禁止 `console.log`、花括号配平

---

# 第二部分：前端 `confirmAlreadyVoted(user, res)`

## 现状（**这是要替换掉的完整代码**）

```js
    /**
     * 已经评价过这个人 → 弹提示并引导去看结果。
     * 结果页复用与"刚投完票"完全相同的那个对比页，不另做一套。
     */
    function confirmAlreadyVoted(user, res) {
      // 先把结果页渲染好放在下层，用户点确认直接切过去，不再等一次请求
      var goResult = function () {
        UI.clear(container);
        container.appendChild(buildResultStep(ctx, user, res.vote.your_choice, res.summary));
      };

      var note = res.vote.invalid
        ? '（注意：这条评价已被对方标为失效，不再计入他的统计。）'
        : '';
      UI.modal({
        title: '你之前已经评价过他了',
        sub: '一个人只算一次，重复提交没有意义。去看看结果吧。' + note,
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
          }
        ]
      });
    }
```

## 要改成什么

`actions` 改成 **3 个按钮**（按此顺序）：

1. `去查看结果` —— `kind: 'primary'`，行为与现状完全一样（关弹窗 → `goResult()`）
2. `去修改` —— `kind: 'ghost'`，关弹窗后调 **`enterScale(user, totalVotes)`** 让用户重做量表
   - `totalVotes` 用 `(res.summary && typeof res.summary.total_votes === 'number') ? res.summary.total_votes : 0`
   - `enterScale` 是同级的函数，签名 `enterScale(user, totalVotes)`，可直接调用
3. `回到主页` —— `kind: 'ghost'`，关弹窗后 `ctx.navigate('/me')`

其余（`title`、`sub`、`body`、`dismissible`、`note` 文案、`goResult` 的实现）**全部保持不变**。
把 `sub` 里的措辞从「一个人只算一次，重复提交没有意义。去看看结果吧。」
改成 **「一个人只算一次。你可以看看结果，也可以改掉之前的判断。」**

## 可用工具（签名逐字照抄，不要臆造）

```js
UI.el(tag, props, children)
// props: class / type / text / style(对象) / onclick(函数) / 任意 HTML 属性
UI.modal({ title, sub, body, actions, dismissible })
// actions: 节点数组，或 [{ label, kind, onClick }]；kind: 'primary' | 'ghost' | 'quiet' | 'danger'
UI.closeModal()
UI.fmtTime(isoString)
```

## 红线
1. 只用 ES5 语法；禁止 `innerHTML`；禁止写死颜色值
2. 禁止 `fetch` / `XMLHttpRequest`
3. 三个 `onClick` 里都必须先 `UI.closeModal()` 再做别的
4. 不得动 `container` / `ctx` / `buildResultStep` / `enterScale` 之外的任何东西

---

## 输出格式

```js
// ========== 后端：server/src/routes/vote.js ==========
async function submitVote(ctx) { ... }

// ========== 前端：web/js/views/visitor.js ==========
    function confirmAlreadyVoted(user, res) { ... }
```
前端那段保持 4 空格缩进（它在 `visitor()` 函数体内部）。

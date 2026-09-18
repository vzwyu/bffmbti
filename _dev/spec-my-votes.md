# 任务：两个新查询接口 —— 「我发出的评价」与「我对某人的评价」

## 运行环境（硬约束）

- Node.js，**零第三方依赖**，只用内置模块；`'use strict'`
- 该文件是 `server/src/routes/vote.js`，CommonJS

## 交付物（只产出这两个 async 函数）

1. `listMyVotes(ctx)` —— 我发给别人的评价列表
2. `getMyVote(ctx)` —— 我对某个分享链接的主人是否已经评价过

**只输出这两个函数，不要解释、不要 markdown 围栏、不要输出其它内容。**

## 该文件内已存在、可直接调用（逐字照抄，不要重新实现）

```js
function makeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function findUserByToken(db, token) {
  return db.prepare('SELECT * FROM users WHERE token = ?').get(token);
}

function requireActiveUser(db, token) {
  const user = findUserByToken(db, token);
  if (!user || user.banned === 1) {
    throw makeError(404, 'not_found', '这个链接无效或已失效');
  }
  return user;
}

// 返回统计对象，形状见下；target 参数是**用户行**（不是 id）
function computeSummary(db, userRow) {
  // 返回 { total_votes, low_sample, axes, majority_mbti, self_mbti, divergence_axes, has_votes }
}

// { code, cn, en, group, color } 或 null
function typeDetail(code) { ... }

// 返回值形态不固定，见 checkLimit 内部判断（内部已处理，直接调）
function checkLimit(limiter, ip, message) { ... }

const { getSessionUser } = require('./auth.js');   // 已导入
const { sendJson } = require('../http.js');        // 已导入
```

### votes 表结构（只读参考，**禁止** DELETE / DROP / 除 ADD COLUMN 外的 ALTER）

```
id, target_user_id, voter_nickname, voter_user_id, axis_ie, axis_ns, axis_tf, axis_pj,
result_mbti, created_at, voter_ip, voter_ua, invalid, invalid_at
```

- `voter_user_id` 只有**登录用户**提交时才有值；匿名访客为 NULL
- `invalid = 1` 表示被目标本人标为失效（**只影响目标的统计，不删除记录**）

### users 表关键列

`id, token, nickname, gender, login_account, mbti_self, banned`

---

## 一、`listMyVotes(ctx)` —— 路由 `GET /me/votes-given`

### 行为（按顺序）

1. `const { db } = ctx.deps;`
2. `const sessionUser = getSessionUser(db, ctx);` —— **参数顺序必须是 `(db, ctx)`**
   - 无会话 → `throw makeError(401, 'unauthorized', '请先登录')`
3. `checkLimit(ctx.deps.limiters.readByIp, ctx.ip, '请求太频繁，请稍后再试');`
4. 分页参数：`limit` / `offset` 从 `ctx.query` 取，规则与同文件的 `listVotes` 完全一致
   （非法值回落默认 50，上限 200，offset 最小 0）
5. 查总数：
   ```sql
   SELECT COUNT(*) AS n FROM votes WHERE voter_user_id = ?
   ```
6. 查列表（同一条 SQL 里 JOIN 出目标用户信息）：
   ```sql
   SELECT v.id, v.result_mbti, v.created_at, v.invalid,
          u.token AS target_token, u.nickname AS target_nickname, u.mbti_self AS target_self
   FROM votes v JOIN users u ON u.id = v.target_user_id
   WHERE v.voter_user_id = ?
   ORDER BY v.id DESC
   LIMIT ? OFFSET ?
   ```
   **注意**：目标用户可能已被封禁（`u.banned = 1`）。封禁用户的评价**不要**出现在列表里 ——
   请在 WHERE 里加 `AND u.banned = 0`，并且**总数查询也要加同样的 JOIN 条件**，
   否则分页条数与实际返回不一致。
7. 对每条记录算出「大多数人认为目标是什么」：
   - 用 `computeSummary(db, { id: ..., mbti_self: ... })`
     —— 注意它读的是 `userRow.id` 与 `userRow.mbti_self`，
     第一个参数必须传**行对象**，不要只传 id
   - **同一个目标只算一次**：用 `Map` 按 `target_user_id` 缓存（SQL 里要把 `u.id` 也 SELECT 出来）
8. 返回：

```js
sendJson(ctx.res, 200, {
  ok: true,
  total,
  votes: rows.map(r => ({
    id: r.id,
    target_token: r.target_token,
    target_nickname: r.target_nickname,
    my_choice: r.result_mbti,
    my_choice_detail: typeDetail(r.result_mbti),
    target_majority: summary.majority_mbti || null,        // 可能是 null
    target_self: (r.target_self && MBTI.get(r.target_self)) ? r.target_self : null,
    created_at: r.created_at
  }))
});
```

`MBTI` 已在本文件顶部 require，可直接用（`MBTI.get(code)` 取不到时返回 null）。

---

## 二、`getMyVote(ctx)` —— 路由 `GET /u/:token/my-vote`

### 用途

访客打开别人的分享链接时，如果已经登录、且之前评价过这个人，
前端要弹「你之前已经评价过他了，去查看」并直接展示结果页。

### 行为（按顺序）

1. `const { db } = ctx.deps;`
2. `checkLimit(ctx.deps.limiters.readByIp, ctx.ip, '请求太频繁，请稍后再试');`
3. `const target = requireActiveUser(db, ctx.params.token);`
   —— 目标不存在或已封禁 → 404（**即使未登录也要先做这一步**，保持与其它接口一致的对外口径）
4. `const sessionUser = getSessionUser(db, ctx);`
   - **未登录不报错**，返回 `{ ok: true, voted: false, vote: null, summary: <统计> }`
     —— 访客页要能继续走匿名流程，这里抛 401 会打断它
5. 已登录时查：
   ```sql
   SELECT id, result_mbti, created_at, invalid
   FROM votes WHERE target_user_id = ? AND voter_user_id = ?
   ORDER BY id DESC LIMIT 1
   ```
6. 返回：
```js
sendJson(ctx.res, 200, {
  ok: true,
  voted: !!row,
  vote: row ? {
    id: row.id,
    your_choice: row.result_mbti,
    your_choice_detail: typeDetail(row.result_mbti),
    created_at: row.created_at,
    invalid: row.invalid === 1        // 被目标标为失效时为 true，前端要如实展示
  } : null,
  summary: computeSummary(db, target)
});
```
**`summary` 无论 voted 与否都要返回** —— 前端要直接拿它渲染结果对比页。

---

## 质量红线（逐条会审，违反即打回）

1. 禁止 `DELETE` / `DROP` / `TRUNCATE`；`ALTER` 只允许 `ADD COLUMN`
2. SQL 必须参数化（`?`），禁止把变量拼进 SQL 字符串
3. `getSessionUser(db, ctx)` 参数顺序不能错
4. `computeSummary(db, userRow)` 第一参数必须是**行对象**
5. 禁止 `Math.random`
6. 花括号必须配平
7. 两个函数都不要 `try/catch` 吞错 —— 让路由层统一转 HTTP 响应
8. 全程不要出现 `console.log`

## 输出格式

```js
// ========== 路由 6：我发出的评价 ==========
async function listMyVotes(ctx) { ... }

// ========== 路由 7：我对某人的评价 ==========
async function getMyVote(ctx) { ... }
```
函数体缩进 2 空格。

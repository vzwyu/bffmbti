# 任务：实现「访客评价」与「统计」路由模块

输出**一个完整 JS 文件**（`server/src/routes/vote.js`），不解释、不加 markdown 围栏。第一行 `'use strict';`

## 零第三方依赖 + 复用已有模块

```js
const { audit, nowIso } = require('../db.js');
const { sendJson } = require('../http.js');
const { getSessionUser, validateNickname } = require('./auth.js');
const MBTI = require('../../../shared/mbti-types.js');
```

`MBTI.AXES` = `[{key, left, right, leftCn, rightCn, leftDesc, rightDesc}, ...]`，共 4 项，顺序为 `IE, NS, TF, PJ`。
`MBTI.buildCode({IE,NS,TF,PJ})` 合法时返回 `'INTJ'`，任一轴缺失或非法返回 `null`。
`MBTI.get(code)` 返回 `{code, cn, en, slug, group, color, tagline}` 或 `null`。

## handler 签名与错误约定

`async (ctx) => {}`，ctx 含 `{ req, res, params, query, cookies, ip, ua, deps, json() }`。
`deps.db`、`deps.config`、`deps.limiters.voteByIp`、`deps.limiters.readByIp`。
错误抛 `Object.assign(new Error(msg), {status, code})`。

## 数据库（禁止 DELETE / DROP / ALTER）

```sql
users(id, token, nickname, gender DEFAULT 'unset', mbti_self, mbti_edit_count, ...)
votes(id, target_user_id, voter_nickname, voter_user_id, axis_ie, axis_ns, axis_tf, axis_pj,
      result_mbti, created_at, voter_ip, voter_ua)
```

---

## 核心算法：按轴取众数（必须严格实现）

**这是本模块最关键的部分。绝对不要按 `result_mbti` 整体取众数** —— 样本少时 16 种组合会分散，永远凑不出"大多数"。必须逐轴统计。

实现 `computeSummary(db, userRow)`，返回：

```js
{
  total_votes: n,
  low_sample: n < 3,                 // 样本过少，前端加"仅供参考"提示
  axes: [
    {
      key: 'IE',
      left: 'I', right: 'E',
      leftCn: '内向', rightCn: '外向',
      leftCount: 7, rightCount: 3,
      majority: 'I',                 // 多数侧；平票时见下
      tie: false,
      selfChoice: 'I',               // 用户自我认知在该轴的值，无则 null
      agreeWithMajority: true        // selfChoice 与 majority 是否一致；任一为 null 则为 null
    },
    // NS / TF / PJ 同构
  ],
  majority_mbti: 'INTJ',             // 四轴都有 majority 时才拼得出，否则 null
  self_mbti: 'INTJ',                 // 用户自选的，可能为 null
  divergence_axes: ['TF'],           // 自我认知与多数不一致的轴，用于偏差图
  has_votes: n > 0
}
```

### 平票处理规则

对每一轴（`leftCount` vs `rightCount`）：
1. `leftCount > rightCount` → `majority = left`
2. `rightCount > leftCount` → `majority = right`
3. **完全相等**（含 `0 : 0` 的情形）→ `tie = true`：
   - 若用户有 `mbti_self`，取 `mbti_self` 在该轴上的字符作为 `majority`
     （例如 code 是 `'INTJ'`，IE 轴取第 0 位 `'I'`，NS 轴取第 1 位 `'N'`，TF 取第 2 位，PJ 取第 3 位）
   - 若用户没有 `mbti_self`，`majority = null`
4. **没有任何投票时**（`total_votes === 0`）：所有轴的 `majority` 都按规则 3 处理（即回落到自我认知或 null），
   且 `leftCount = rightCount = 0`

> 轴的索引：`IE→0, NS→1, TF→2, PJ→3`，可直接从 `mbti_self` 字符串按位取。

统计 SQL 建议一次查完：
```sql
SELECT
  SUM(axis_ie='I') AS ie_i, SUM(axis_ie='E') AS ie_e,
  SUM(axis_ns='N') AS ns_n, SUM(axis_ns='S') AS ns_s,
  SUM(axis_tf='T') AS tf_t, SUM(axis_tf='F') AS tf_f,
  SUM(axis_pj='P') AS pj_p, SUM(axis_pj='J') AS pj_j,
  COUNT(*) AS total
FROM votes WHERE target_user_id = ?
```
注意 `SUM()` 在无行时返回 `NULL`，必须用 `Number(x) || 0` 兜底。
**表名/列名是写死的常量，不是用户输入，可安全地写在 SQL 字符串里。**

---

## 路由 1：`GET /u/:token` —— 公开用户信息（无需登录）

给访客评价页用。调用 `deps.limiters.readByIp.check(ctx.ip)`，超限则 429。

- 按 `token` 查用户；不存在或 `banned=1` → **404 / `not_found` / `这个链接无效或已失效`**
- 返回 200：
```js
{ ok:true, user: { token, nickname, gender, mbti_self } }
```
**绝不能返回 `login_account`、`password_hash`、`recovery_code_hash`、`id` 等任何敏感字段。**

## 路由 2：`POST /u/:token/vote` —— 提交评价（无需登录）

请求体 `{ voter_nickname, IE, NS, TF, PJ }`

流程：
1. `deps.limiters.voteByIp.check(ctx.ip)`，超限 → 429 / `too_many_requests` / `提交太频繁，请稍后再试`
2. 查目标用户，不存在 → 404 / `not_found`
3. `validateNickname(voter_nickname)` 校验评价者称呼（会自动抛 400）
4. 校验四个轴：每一项必须**严格等于**该轴的 `left` 或 `right`，否则 400 / `invalid_axes` / `请完成全部四个选择`
5. `MBTI.buildCode({IE,NS,TF,PJ})`，得到 `result_mbti`；为 `null` → 400 / `invalid_axes`
6. 防灌库：`SELECT COUNT(*) AS n FROM votes WHERE target_user_id = ?`，
   若 `n >= deps.config.maxVotesPerTarget` → 429 / `vote_limit_reached` / `该用户收到的评价已达上限`
7. **同一人重复刷票抑制**：按 `(target_user_id, voter_ip)` 查最近一条记录，
   若 `created_at` 在 **30 秒内** → 429 / `too_soon` / `刚刚已经提交过了，请稍后再试`
8. 插入 votes 行（`voter_user_id` 填当前登录用户 id，未登录填 `null` —— 用 `getSessionUser` 判断，
   **未登录不报错，正常当匿名访客处理**）
9. 写入后重新 `computeSummary`，返回 **201**：
```js
{ ok:true,
  your_choice: 'INTJ',              // 这位访客认为的
  your_choice_detail: { code, cn, en, group, color },   // 来自 MBTI.get()
  summary: <computeSummary 的返回> }
```

## 路由 3：`GET /u/:token/summary` —— 统计汇总（无需登录）

- `readByIp` 限流
- 查用户，不存在 → 404
- 返回 200 `{ ok:true, summary: <computeSummary 结果> }`

## 路由 4：`GET /u/:token/votes` —— 评价明细（**必须登录且必须是本人**）

- `getSessionUser`，未登录 → 401 / `unauthorized` / `请先登录`
- 查目标用户，不存在 → 404
- **若当前登录用户 id !== 目标用户 id → 403 / `forbidden` / `无权查看他人的评价明细`**
- 分页：`?limit`（默认 50，最大 200）与 `?offset`（默认 0），都要做**数字校验**，
  非法值回落到默认值（不要抛错）
- 按 `id DESC`（最新在前）返回
- 返回 200：
```js
{ ok:true, total: <总条数>,
  votes: [ { voter_nickname, result_mbti, detail: {code,cn,en,group,color}, created_at } ] }
```
**注意：明细里不得出现 `voter_ip`、`voter_ua`，那是内部数据，会泄漏评价者隐私。**

---

## 质量红线（逐条审查，违反即打回）

1. SQL 全部参数化，**唯一允许的例外是写死的表名/列名/聚合表达式**（不是用户输入）
2. 不出现 `DELETE` / `DROP` / `ALTER`
3. 不出现 `Math.random()`
4. 公开接口（路由 1/2/3）**绝不能**返回 `login_account` / `password_hash` / `id` 等敏感字段
5. 路由 4 必须做**归属校验**，不能只看登录状态
6. `SUM()` 的 `NULL` 必须兜底为 `0`
7. 分页参数必须做数字与范围校验
8. `catch` 不得吞错
9. 注释用中文，只写关键决策
10. 必须能 require 加载不报错

**导出**：`module.exports = { publicUser, submitVote, getSummary, listVotes, computeSummary }`

直接输出完整代码。

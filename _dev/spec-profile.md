# 任务：实现对「资料管理」路由模块

输出**一个完整的 JS 文件**（`server/src/routes/profile.js`），不解释、不加 markdown 围栏。第一行 `'use strict';`

## 零第三方依赖（Node 22 内置模块）+ 复用已有模块

```js
const { tx, audit, nowIso } = require('../db.js');
const { verifyPassword, hashPassword } = require('../security.js');
const { sendJson } = require('../http.js');
const { getSessionUser, validateNickname, maskAccount } = require('./auth.js');
const MBTI = require('../../../shared/mbti-types.js');   // 注意路径是三层的 ../../
```

`getSessionUser(db, ctx)` 返回**用户行**（含 id、password_hash 等全部字段）或 `null`。
`MBTI.isValidCode(code)` 返回布尔；`MBTI.get(code)` 返回类型对象（含 cn / en / group / color）。
`MBTI.AXES` 是 `[{key:'IE',left:'I',right:'E',...}, ...]` 四维定义。

## handler 签名

`async (ctx) => {}`，ctx 有 `{ req, res, params, query, cookies, ip, ua, deps, json() }`。
`deps.db`、`deps.config`。
错误抛 `Object.assign(new Error(msg), {status, code})`；成功 `sendJson(res, status, {...})`。

## 数据库（只读参考，禁止 DELETE / DROP / ALTER）

```sql
users(id, token, nickname, gender DEFAULT 'unset', login_account UNIQUE, password_hash,
      recovery_code_hash, mbti_self, mbti_edit_count DEFAULT 0, created_at, updated_at,
      last_login_at, reg_ip, reg_ua, wx_openid, banned)
audit_log(id, user_id, action, field, old_value, new_value, ip, ua, created_at)
```

---

## 路由 1：`PATCH /me` —— 修改称呼 / 性别

请求体 `{ nickname?, gender? }`，两者都可选，但至少要给一个（否则 400 / `nothing_to_update`）。

- 需要登录，未登录 → 401 / `unauthorized` / `请先登录`
- `nickname`：复用 `validateNickname()` 校验（它已处理 emoji、控制字符、宽度）
- `gender`：只接受 `'male' | 'female' | 'other' | 'unset'`，其它值 → 400 / `invalid_gender`
- **性别是选填的**：用户可以不填，`'unset'` 是合法值，代表"未填写"，不得强制
- 在 **事务** 内逐字段 `UPDATE`，**每个发生变化的字段单独写一条 audit**：
  `audit(db, {userId, action:'update_profile', field:'nickname', oldValue, newValue, ip, ua})`
- 同时更新 `updated_at`
- 返回 200：`{ ok:true, user: <selfUser> }`

`selfUser` 形状（本模块内实现一份）：
```js
{ token, nickname, gender, login_account, mbti_self, mbti_edit_count, created_at }
```

## 路由 2：`POST /me/mbti` —— 设置或修改自己的 MBTI

请求体 `{ mbti, password }`

规则（**必须严格实现**）：

1. 需要登录，否则 401
2. `MBTI.isValidCode(mbti)` 为假 → 400 / `invalid_mbti` / `人格类型不正确`
3. **首次设置**（`row.mbti_self == null`）：
   - **不需要密码**，直接写入
   - `UPDATE users SET mbti_self = ?, mbti_edit_count = 0, updated_at = ?`
   - 写 audit：`action:'set_mbti'`, field:`mbti_self`, oldValue:`null`, newValue: 新值
   - 返回 200 `{ ok:true, user, changed:true, remaining_edits:1 }`
4. **修改**（`row.mbti_self != null`）：
   - 若 `mbti` 与当前值相同 → 400 / `same_mbti` / `新类型与当前类型相同`
   - `mbti_edit_count >= 1` → 403 / `edit_limit_reached` / `MBTI 只能修改一次，你已经用掉了这次机会`
   - **必须校验密码**：`password` 缺失或非 4 位数字 → 400 / `password_required` / `修改人格类型需要输入密码`
   - `verifyPassword(password, row.password_hash)` 为假 → 401 / `bad_password` / `密码错误`
     （**限流**：用 `deps.limiters.loginByAccount`，key 用 `'mbti:' + userId`，失败要 `fail()`，成功 `succeed()`）
   - 通过后在事务内：
     - `UPDATE users SET mbti_self=?, mbti_edit_count = mbti_edit_count + 1, updated_at=?`
     - 写 audit：`action:'change_mbti'`, field:`mbti_self`, oldValue: 旧值, newValue: 新值
   - 返回 200 `{ ok:true, user, changed:true, remaining_edits:0 }`

> 注意：`remaining_edits` 是给前端提示用的，`1` 表示还有一次修改机会，`0` 表示已用完。

## 路由 3：`GET /me/mbti-permission` —— 查询能否修改 MBTI（前端展示用）

- 需要登录，否则 401
- 返回 200：
```js
{ ok:true,
  can_edit: boolean,          // mbti_self 为空 或 mbti_edit_count === 0
  reason: 'not_set' | 'available' | 'used' | 'unchanged_pending',
  remaining_edits: number,
  label: string               // 给前端直接显示的中文说明
}
```
`label` 规则：
- `not_set` → `'还没有选择你的人格类型'`
- `available` → `'你还可以修改 1 次（仅此一次）'`
- `used` → `'修改机会已用完，类型不可再改'`

---

## 质量红线（逐条审查，违反即打回）

1. SQL 全部参数化，禁止拼接用户输入
2. 不出现 `DELETE` / `DROP` / `ALTER`
3. 不出现 `Math.random()`
4. audit 的 old_value / new_value **绝不能**出现密码明文或哈希，一律 `[redacted]`
5. 每个字段变更必须**独立**写一条 audit（不要合并成一条）
6. `catch` 不得吞错
7. 注释用中文，只写关键决策
8. 必须能 require 加载不报错

**导出**：`module.exports = { updateProfile, setMbti, mbtiPermission }`

直接输出完整代码。

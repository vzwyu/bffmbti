# 任务：实现 MBTI 小游戏的账号认证路由模块

输出**一个完整的 JS 文件**（`server/src/routes/auth.js`），不要解释、不要 markdown 围栏，直接输出代码。
第一行是 `'use strict';`。

---

## 运行环境与依赖

Node.js 22，CommonJS。**零第三方依赖**，只用 Node 内置模块。
以下同项目模块已存在，直接 require，**不要重新实现**：

```js
// server/src/db.js
const { tx, audit, nowIso } = require('../db.js');
//   tx(db, fn)            把 fn 包进 BEGIN IMMEDIATE 事务，抛错自动 ROLLBACK
//   audit(db, {userId, action, field, oldValue, newValue, ip, ua})
//   nowIso()              返回 ISO8601 UTC 字符串

// server/src/security.js
const {
  hashPassword,       // (password) -> 'scrypt$N$r$p$salt$hash'
  verifyPassword,     // (password, stored) -> boolean，损坏串返回 false 不抛
  createRateLimiter,  // ({maxFailures, windowMs, lockMs, maxEntries}) -> {check,fail,succeed,sweep}
  makeToken,          // (bytes=32) -> base64url 随机串
  makeRecoveryCode,   // () -> 'XXXX-XXXX-XXXX'（已排除易混淆字符）
  constantTimeEqual   // (a,b) -> boolean
} = require('../security.js');

// server/src/http.js
const { sendJson, buildCookie } = require('../http.js');
//   sendJson(res, status, obj)
//   buildCookie(name, value, {maxAge, httpOnly, secure, sameSite}) -> Set-Cookie 字符串
```

---

## 路由处理器签名

每个 handler 是 `async (ctx) => {}`，ctx 结构：

```js
{
  req, res,
  params,            // 路径参数对象
  query,             // 查询参数对象
  cookies,           // 已解析的 cookie 对象
  ip,                // 客户端 IP 字符串
  ua,                // User-Agent 字符串
  deps,              // { db, limiters, config }
  json()             // async，返回解析后的请求体对象（非法时自动抛 400/413/415）
}
```

**错误处理约定**：抛出一个带 `status` 和 `code` 的 Error，外层会统一转成响应：

```js
function fail(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
throw fail(409, 'account_taken', '已经有人注册过了，请换一个');
```

成功一律 `sendJson(res, status, { ok: true, ... })`。

---

## deps 契约（由外部注入，直接使用）

- `deps.db` —— node:sqlite 的 DatabaseSync 实例
- `deps.config.sessionTtlMs` —— 会话有效期毫秒数（默认 30 天）
- `deps.config.secureCookie` —— 布尔，决定 cookie 是否加 Secure
- `deps.limiters.loginByAccount` / `deps.limiters.loginByIp` —— 限流器实例
- `deps.limiters.registerByIp` —— 限流器实例

---

## 数据库表结构（已存在，只读参考）

```sql
users(
  id INTEGER PK, token TEXT UNIQUE,           -- token 是公开标识（分享链接用）
  nickname TEXT, gender TEXT DEFAULT 'unset',
  login_account TEXT UNIQUE,                  -- 已存规范化后的值
  password_hash TEXT, recovery_code_hash TEXT,
  mbti_self TEXT NULL, mbti_edit_count INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT, last_login_at TEXT,
  reg_ip TEXT, reg_ua TEXT, wx_openid TEXT, banned INTEGER DEFAULT 0
)
sessions(
  token_hash TEXT PK,                          -- sha256(session token) 的 hex
  user_id INTEGER, created_at TEXT, expires_at TEXT,
  revoked INTEGER DEFAULT 0, ip TEXT, ua TEXT
)
audit_log(id, user_id, action, field, old_value, new_value, ip, ua, created_at)
```

**绝不允许出现 DELETE / DROP / ALTER 语句。** 登出用 `UPDATE sessions SET revoked=1`。

---

## 输入规范化与校验（必须严格遵守）

### `normalizeAccount(raw)`
- 去首尾空白；若含 `@` 则整体转小写（邮箱不区分大小写）
- 纯数字保持原样
- **校验**：必须是邮箱 / 11 位手机号 / 5–12 位纯数字，三者之一，否则 400
  - 邮箱：`/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/` 且长度 ≤ 120
  - 手机号：`/^1[3-9]\d{9}$/`
  - 纯数字（历史遗留的 QQ 号账号）：`/^[1-9]\d{4,11}$/`

> **2026-09-18 修订：不再接受 QQ 号注册。**
> 依据微信《外部链接内容管理规范》2.11.3，条款把「QQ号码」列入禁止"要求用户提供"
> 的敏感数据。处理方式：
> 1. 前端表单不再出现「QQ 号」字样（注册页 label 改「邮箱 / 手机号」，登录页改「登录账号」）
> 2. `register()` 增加硬拦截 `looksLikeQQ(account)` → 400 `invalid_account`「请填写邮箱或手机号」
> 3. **`normalizeAccount` 保持放行纯数字** —— 登录与找回必须让历史 QQ 号账号能进来，
>    否则这些用户会被永久锁在门外
>
> 即：**注册收窄，登录与找回保持兼容。**

### `validatePassword(raw)`
- **必须恰好 4 位数字**：`/^\d{4}$/`，否则 400
- 拒绝连续重复（`0000`/`1111`）和递增递减（`1234`/`4321`/`0123`）
  —— 4 位密码本就弱，这类弱口令直接拒掉

### `validateNickname(raw)`
- 去首尾空白后**不能为空**，否则 400
- 允许 emoji 和特殊符号，但**长度按"字符宽度"算**：
  - 中文字符 / 全角字符 / emoji 记 **2**，ASCII 记 **1**
  - 总宽度上限 **64**（即约 32 个中文字符）
  - 用 `Array.from(raw)` 遍历以正确处理代理对（emoji 不会把字数算错）
- 剔除控制字符（`\u0000-\u001F\u007F`）和零宽字符（`\u200B-\u200D\uFEFF`）
- 长度按处理后计算

### 脱敏
- `maskAccount(acc)`：邮箱保留首字符 + `***` + `@域名`；手机号 `138****8888`；
  纯数字（历史 QQ 号账号）保留前 2 后 2，中间 `***`。用于任何对外展示场景。

---

## 需要实现的路由

### 1. `POST /auth/register`
请求体 `{ nickname, account, password }`

流程：
1. `deps.limiters.registerByIp.check(ctx.ip)`，不允许则抛 429（code `too_many_requests`）
2. 校验三个字段（上面那套规则）
3. 查 `SELECT id FROM users WHERE login_account = ?`（参数化）
   - 命中 → `deps.limiters.registerByIp.fail(ctx.ip)`，抛 **409 / `account_taken` / `已经有人注册过了，请换一个`**
4. 生成 `token = makeToken(12)`、`recoveryCode = makeRecoveryCode()`
   - `token` 需保证唯一：循环最多 5 次，若 `SELECT 1 FROM users WHERE token=?` 命中则重生成
5. `hashPassword(password)`、`hashPassword(recoveryCode)`
6. 在 **tx 事务**内插入 users 行，并写 `audit(db, {userId, action:'register', ip, ua})`
7. 创建会话（见下方「会话」节）
8. 返回 **201**：

```js
{ ok: true,
  user: <selfUser>,
  recovery_code: 'ABCD-EFGH-JKLM',   // 明文仅此一次返回
  share_token: user.token }
```

### 2. `POST /auth/login`
请求体 `{ account, password }`

流程：
1. `loginByIp.check(ctx.ip)` → 不允许则 429
2. 规范化 account（**注意：此处规范化失败应统一抛 401 而不是 400**，避免暴露账号格式信息）
3. `loginByAccount.check(account)` → 不允许则 429，message 里带上 `retryAfterSec` 换算的分钟数
4. 查用户
   - 不存在 → `loginByAccount.fail(account)`、`loginByIp.fail(ctx.ip)`，抛 **401 / `bad_credentials` / `账号或密码错误`**
     （**不要**提示"账号不存在"，避免账号枚举）
   - `banned = 1` → 抛 403 / `banned`
5. `verifyPassword(password, row.password_hash)`
   - 失败 → 两个限流器都 `fail()`，抛 **401 / `bad_credentials` / `账号或密码错误`**
   - 成功 → 两个限流器都 `succeed()`
6. `UPDATE users SET last_login_at = ? WHERE id = ?`，写 audit（action `login`）
7. 创建会话，返回 **200** `{ ok:true, user: <selfUser> }`

> 限流 key 用**规范化后的 account 字符串**，不要用 user_id，因为账号不存在时也需要计数。

### 3. `POST /auth/logout`
- 从 cookie 取 session token，`UPDATE sessions SET revoked = 1 WHERE token_hash = ?`
- 用 `buildCookie('mbti_session', '', { maxAge: 0, secure: deps.config.secureCookie })` 清 cookie
- 返回 **200** `{ ok:true }`
- **幂等**：无会话也返回 200

### 4. `GET /auth/me`
- 无有效会话 → **401 / `unauthorized` / `请先登录`**
- 有效 → **200** `{ ok:true, user: <selfUser> }`

### 5. `POST /auth/recover`
请求体 `{ account, recovery_code, new_password }`

流程：
1. `loginByIp.check(ctx.ip)` → 不允许则 429
2. 规范化 account、校验 new_password（同样拒绝弱口令）
3. 查用户；不存在 → 抛 401 / `bad_credentials` / `账号或找回码错误`
4. 用户若处于锁定态（用 `loginByAccount.check`）→ 429
5. `verifyPassword(recovery_code.toUpperCase(), row.recovery_code_hash)`
   - 失败 → `loginByIp.fail`、`loginByAccount.fail`，抛 401 / `bad_credentials` / `账号或找回码错误`
   - 成功 → `succeed`，`UPDATE users SET password_hash=?, updated_at=?`，写 audit（action `recover`，field `password_hash`，**old_value/new_value 都必须写 `[redacted]`，绝不能落明文或哈希**）
6. **吊销该用户全部会话**：`UPDATE sessions SET revoked = 1 WHERE user_id = ?`
7. 写入新的 recovery_code 并返回（**旧码一次性作废**）：
   `{ ok:true, recovery_code: <新码> }`

### 6. `POST /auth/password`
请求体 `{ old_password, new_password }` —— **需要登录**

1. 取当前用户（无会话 → 401）
2. `loginByAccount.check('pw:' + userId)` → 不允许则 429
3. `verifyPassword(old_password, row.password_hash)`
   - 失败 → `fail()`，抛 401 / `bad_old_password` / `原密码错误`
4. 校验 new_password；且**新密码不得与原密码相同**，否则 400 / `same_password` / `新密码不能与原密码相同`
5. `UPDATE users SET password_hash=?, updated_at=?`，写 audit（action `change_password`，field `password_hash`，值写 `[redacted]`）
6. **吊销除当前会话外的其它会话**
7. 返回 200 `{ ok:true }`

---

## 会话机制（各路由共用，请实现为内部函数）

```js
function createSession(db, config, userId, ip, ua) {
  const raw = makeToken(32);                       // 回给浏览器的明文
  const tokenHash = sha256hex(raw);
  const now = Date.now();
  db.prepare(`INSERT INTO sessions
      (token_hash, user_id, created_at, expires_at, revoked, ip, ua)
    VALUES (?,?,?,?,0,?,?)`)
    .run(tokenHash, userId, new Date(now).toISOString(),
         new Date(now + config.sessionTtlMs).toISOString(), ip, ua);
  return raw;
}
```

- `sha256hex` 用 `node:crypto` 的 `createHash('sha256').update(s).digest('hex')`
- 会话 cookie 名固定 **`mbti_session`**，通过 `res.setHeader('Set-Cookie', buildCookie(...))` 写入
  - `maxAge` 取 `config.sessionTtlMs / 1000`，`secure` 取 `config.secureCookie`
- 校验会话：按 `token_hash` 查 sessions，要求 `revoked = 0` 且 `expires_at > nowIso()`，
  再 `JOIN users` 取用户行；同时顺手 `UPDATE sessions SET revoked=1 WHERE token_hash=? AND expires_at <= ?`
  （过期即标记作废，**不是删除**）

**必须导出**：`module.exports = { register, login, logout, me, recover, changePassword, getSessionUser, maskAccount, normalizeAccount, validatePassword, validateNickname }`
其中 `getSessionUser(db, ctx)` 供其它路由复用。

---

## 两个用户对象形状

```js
// 本人可见（含完整账号，用于个人主页展示）
selfUser = {
  token, nickname, gender, login_account, mbti_self, mbti_edit_count, created_at
}
// 对外公开（分享链接场景，不含任何账号信息）
publicUser = { token, nickname, gender, mbti_self }
```

---

## 质量红线（我会逐条审查，违反即打回重写）

1. **任何 SQL 都不得字符串拼接用户输入**，一律 `prepare()` + 参数绑定
2. 不出现 `DELETE` / `DROP` / `ALTER`
3. 不出现 `Math.random()`，随机一律走 `security.js`
4. **审计日志里绝不允许出现密码明文或哈希**，一律写 `[redacted]`
5. 登录失败不得区分"账号不存在"和"密码错误"（防账号枚举）
6. 所有 `catch` 不得吞掉错误，必须有明确分支或继续抛出
7. 注释用中文，只在关键安全决策处写，不要逐行注释
8. 代码必须能 `require` 加载不报错

直接输出完整代码。

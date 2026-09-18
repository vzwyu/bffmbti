# 任务：编写一个 Node.js 安全模块（CommonJS）

请输出**一个完整的 JS 文件**，不要解释、不要 markdown 代码围栏，直接输出代码。

## 文件路径与用途
`src/security.js` —— 为一个「MBTI 社交小游戏」后端提供账号安全基础设施。

## 运行环境
- Node.js 22，CommonJS (`require` / `module.exports`)
- **只允许使用 Node 内置模块**（`node:crypto`、`node:fs` 等），不得引入任何第三方依赖
- 无 TypeScript，纯 JS，但用 JSDoc 标注参数类型

## 必须导出的 API

### 1. `hashPassword(password, opts?)`
- 使用 `crypto.scrypt` 派生密钥
- 输出格式：`scrypt$N$r$p$salt_b64$hash_b64`（自描述字符串，便于日后调参）
- 默认参数 N=16384, r=8, p=1, keylen=64, salt 16 字节随机
- 必须使用 `crypto.timingSafeEqual` 做校验（在 `verifyPassword` 里）

### 2. `verifyPassword(password, stored)`
- 解析自描述字符串，用相同参数重新派生并**定时安全**比较
- 任何解析失败/格式非法一律返回 `false`，不得抛异常

### 3. `createRateLimiter(options)`  —— 内存版限流器
返回一个对象，含以下方法：
- `check(key)` → `{ allowed: boolean, retryAfterSec: number, remaining: number }`
- `fail(key)` → 记录一次失败
- `succeed(key)` → 成功则清零计数

要求：
- 支持两个独立维度：**按账号** 和 **按 IP**，配置形如
  `createRateLimiter({ maxFailures: 5, windowMs: 15*60*1000, lockMs: 15*60*1000 })`
- 超过 `maxFailures` 后进入锁定态，锁定期间 `check` 返回 `allowed:false` 且给出 `retryAfterSec`
- **必须防止内存无限增长**：用惰性清扫 + 容量上限（超出时淘汰最旧的条目），并提供一个 `sweep()` 方法手动清理
- 时间戳用 `Date.now()`

### 4. `makeToken(bytes = 32)`
- 返回 URL-safe 的随机字符串（base64url，去掉 `=`）
- 用于 session token 和分享链接标识

### 5. `makeRecoveryCode()`
- 生成人类易抄写的找回码：形如 `XXXX-XXXX-XXXX`
- 字符集排除易混淆字符（不要 `0O1lI`），使用 `crypto.randomBytes` 保证密码学随机

### 6. `constantTimeEqual(a, b)`
- 字符串定时安全比较，长度不等返回 false

## 质量红线（我会逐条审查）
1. **不得有 SQL 拼接**（本文件不涉及 SQL，但不得出现任何字符串拼接成查询的痕迹）
2. `Math.random()` **一次都不能出现**，所有随机必须来自 `crypto`
3. 所有用户输入都当作不可信，解析失败必须优雅降级而非抛异常
4. 不得吞掉错误却不返回安全默认值
5. 注释用中文，简洁，只在关键决策处写

## 输出要求
- 直接输出 JS 源码，第一行是 `'use strict';`
- 不要输出 markdown 围栏
- 代码必须能直接 `node -e "require('./src/security.js')"` 加载而不报错

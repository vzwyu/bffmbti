# 任务：评价「标记失效 / 恢复有效」——后端处理器 + 前端列表项

## 运行环境（硬约束）

- 后端：Node.js，**零第三方依赖**，只用内置模块；`'use strict'`
- 前端：浏览器，**只能用 ES5 语法**（`var` / `function`），
  **禁止** `let` `const` 箭头函数 模板字符串 `?.` `??` 解构 展开 `class`
- 前端代码会被拼进一个大 bundle 当普通 script 执行，**禁止** `import` / `export` / `require`

## 交付物（只产出这两段，不要产出整个文件）

1. 一个后端 async 函数 `setVoteInvalid(ctx)`，可直接插入 `server/src/routes/vote.js`
2. 一个前端函数 `voteItem(v, ctx)`，可直接替换 `web/js/views/profile.js` 里的同名函数

**只输出这两段代码，不要解释、不要 markdown 围栏、不要输出其它函数。**

---

## 一、后端 `setVoteInvalid(ctx)`

### 该文件内已存在、可直接调用（逐字照抄，不要重新实现）

```js
// 抛错式：失败必须 throw，路由层统一转成 HTTP 响应
function makeError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function findUserByToken(db, token) {
  return db.prepare('SELECT * FROM users WHERE token = ?').get(token);
}

const { audit, nowIso } = require('../db.js');
const { sendJson } = require('../http.js');
const { getSessionUser } = require('./auth.js');
```

### 调用上下文

`ctx.deps.db` = 数据库句柄；`ctx.params.token` = 分享标识；
`ctx.params.id` = 评价 id（**字符串**）；`ctx.json()` 返回请求体；
`ctx.ip` / `ctx.ua` 用于审计。

### 行为规格（严格按顺序）

1. `const { db } = ctx.deps;`
2. 取会话：`const sessionUser = getSessionUser(db, ctx);`
   —— **注意参数顺序是 `(db, ctx)`，漏传 db 会静默失效**
   - 没有会话 → `throw makeError(401, 'unauthorized', '请先登录')`
3. 取目标用户：`findUserByToken(db, ctx.params.token)`
   - 不存在或 `banned === 1` → `throw makeError(404, 'not_found', '这个链接无效或已失效')`
4. **归属校验**：`sessionUser.id !== target.id`
   → `throw makeError(403, 'forbidden', '无权操作他人的评价')`
5. 解析 id：`const voteId = parseInt(ctx.params.id, 10);`
   - `!Number.isFinite(voteId) || voteId <= 0`
     → `throw makeError(400, 'invalid_id', '评价编号不正确')`
6. 取请求体：`const body = await ctx.json();`
   - `typeof body.invalid !== 'boolean'`
     → `throw makeError(400, 'invalid_payload', 'invalid 必须是布尔值')`
   - `const want = body.invalid ? 1 : 0;`
7. **归属再校验**：该条评价必须属于这个目标用户
   ```js
   const row = db.prepare('SELECT id, target_user_id, invalid FROM votes WHERE id = ?').get(voteId);
   ```
   - 不存在 → `throw makeError(404, 'not_found', '评价不存在')`
   - `row.target_user_id !== target.id` → `throw makeError(403, 'forbidden', '无权操作他人的评价')`
8. **幂等**：如果 `row.invalid === want`（已经是目标状态），
   不要报错，直接返回当前状态（见第 10 步），**并且不写审计日志**。
9. 更新（用事务包裹 UPDATE + audit）：
   ```js
   db.prepare('UPDATE votes SET invalid = ?, invalid_at = ? WHERE id = ?')
     .run(want, want ? nowIso() : null, voteId);
   audit(db, {
     userId: target.id,
     action: want ? 'vote_invalidate' : 'vote_restore',
     field: 'votes.invalid',
     oldValue: String(row.invalid),
     newValue: String(want),
     ip: ctx.ip,
     ua: ctx.ua
   });
   ```
   `audit` 是**已导入**的普通函数，直接调用即可。
10. 返回：
    ```js
    sendJson(ctx.res, 200, {
      ok: true,
      vote_id: voteId,
      invalid: want === 1
    });
    ```

### 质量红线（逐条会审，违反即打回）
1. **禁止** `DELETE` / `DROP` / `ALTER` —— 这是标记位，不是物理删除
2. **禁止**字符串拼接 SQL；参数一律走 `?` 占位符
3. `getSessionUser` 的参数顺序必须是 `(db, ctx)`
4. 必须同时校验「会话 + 目标是本人 + 评价属于该目标」三层，缺一层就是越权
5. 必须幂等：重复提交同一状态不报错

---

## 二、前端 `voteItem(v, ctx)`

### 现有实现（要替换掉的就是这个）

```js
function voteItem(v) {
  var d = v.detail || {};
  var item = UI.el('div', { class: 'vote-item' });
  if (d.group) item.setAttribute('data-group', d.group);
  var avatar = UI.el('div', { class: 'vote-item__avatar' });
  var abbr = UI.el('span', { text: (v.result_mbti || '').slice(0, 2) });
  abbr.style.color = 'var(--g)';
  avatar.appendChild(abbr);
  var bodyEl = UI.el('div', { class: 'vote-item__body' });
  bodyEl.appendChild(UI.el('div', { class: 'vote-item__name', text: v.voter_nickname || '匿名' }));
  var meta = '认为你是 ' + (d.cn || v.result_mbti || '') +
    (d.en ? '（' + d.en + '）' : '') + ' · ' + UI.fmtTime(v.created_at);
  bodyEl.appendChild(UI.el('div', { class: 'vote-item__meta', text: meta }));
  item.appendChild(avatar);
  item.appendChild(bodyEl);
  item.appendChild(UI.el('div', { class: 'vote-item__code', text: v.result_mbti || '' }));
  return item;
}
```

### 服务端返回的每条记录形状（`GET /u/:token/votes` 的 `votes[i]`）

```js
{
  id: 12,                       // 评价编号（新增）
  voter_nickname: '小明',
  result_mbti: 'ENFP',
  detail: { code:'ENFP', cn:'活动家', en:'Campaigner', group:'NF', color:'#33A474' },
  created_at: '2026-09-18T05:00:00.000Z',
  invalid: false                // 是否已标记失效（新增）
}
```

### 可用工具（逐字照抄签名，不要臆造参数名）

```js
UI.el(tag, props, children)
// props: class / type / text / style(对象) / dataset(对象) / onclick(函数) / 任意 HTML 属性
// children 可为节点或节点数组，可省略

UI.fmtTime(isoString)                       // 返回可读时间
UI.toast(message, kind)                     // kind: 'success' | 'error' | 'info'
UI.confirmDialog({ title, message, confirmText, danger }).then(function(ok){...})
// ok 为布尔；确认框由本组件内部实现，不要自己拼弹窗

API.setVoteInvalid(token, voteId, invalid)  // 返回 Promise，由我（调用方）负责实现
```

### 行为规格

`voteItem(v, ctx)` 返回一个 DOM 节点，行为：

1. **结构与原来完全一致**（头像块 / 名字 / meta 行 / 右侧代码），
   `data-group` 仍按 `d.group` 设置 —— 不要改动版式，只增不减
2. 当 `v.invalid === true` 时：
   - 给 `item` 追加 class `is-invalid`（CSS 我会补，你只管加类名）
   - 名字那一行后面追加一个徽标节点：`UI.el('span', { class: 'vote-item__badge', text: '已失效' })`
   - meta 行的文案前缀改为 `'已失效 · '`，后面接原有的「认为你是 …」
3. **整条可点击**（`item` 上挂 click）：
   - `v.invalid` 为真 → 点开确认框，标题 `恢复这条评价`，
     正文 `恢复后它会重新计入统计。`，确认按钮文案 `恢复`
   - 否则 → 确认框标题 `标记为失效`，
     正文 `标记后这条评价不再计入统计，你随时可以恢复。`，确认按钮文案 `标记失效`，
     `danger: true`
   - 用户取消 → 什么都不做
   - 用户确认 → 调 `API.setVoteInvalid(ctx.store.user.token, v.id, !v.invalid)`：
     - 成功 → `UI.toast(v.invalid ? '已恢复' : '已标记失效', 'success')`，
       然后调用 `ctx.reloadVotes()`（**由调用方提供，可能不存在，必须先判断
       `typeof ctx.reloadVotes === 'function'` 再调**）
     - 失败 → `UI.toast((err && err.message) || '操作失败', 'error')`
   - **点击期间要防重复提交**：用一个局部 `var busy = false;` 开关，
     busy 为真时直接 return
4. 整个函数体包 try/catch，catch 里 `UI.toast('操作失败，请刷新重试', 'error')`，
   **绝不允许抛异常导致整页白屏**
5. `v.id` 缺失时（老数据）不要挂点击、不要报错，照常渲染

### 质量红线
1. 只用 ES5 语法；禁止 `innerHTML`（用 `text` 或 `textContent`）
2. 禁止写死颜色值（hex / rgb）
3. 禁止 `fetch` / `XMLHttpRequest`，网络只能走 `API.setVoteInvalid`
4. 必须 try/catch，且 catch 有用户可见提示
5. 不得引用本文件里不存在的东西；`UI` / `API` 是全局对象
6. `ctx.reloadVotes` 可能不存在 —— 必须先判断类型

---

## 输出格式

按顺序输出两段，各带一行注释头：

```js
// ========== 后端：server/src/routes/vote.js ==========
async function setVoteInvalid(ctx) { ... }

// ========== 前端：web/js/views/profile.js ==========
function voteItem(v, ctx) { ... }
```
函数体缩进 2 空格；前端那段外层缩进 2 空格（它在 IIFE 里）。

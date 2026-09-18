# 任务：实现登录/找回视图 `web/js/views/login.js`

输出**一个完整 JS 文件**，不解释、不加 markdown 围栏。第一行 `'use strict';`

## 运行环境

浏览器原生脚本，**无 require / 无 import / 无构建**。文件壳子固定：

```js
'use strict';
(function (global) {
  var UI = global.UI;
  var API = global.API;

  function login(ctx) { /* ... */ }

  global.Views = global.Views || {};
  global.Views.login = login;
})(typeof window !== 'undefined' ? window : this);
```

### 可用全局
- `UI.el / clear / withLoading(btn,fn) / toast(msg,kind) / modal({…}) / closeModal() /
  confirmDialog({…}) / field({…}) / empty(icon,title,desc) / alertBox(kind,text)`
  - `UI.field({id,label,type,placeholder,hint,required,pin,inputmode,maxlength,autocomplete,value,readonly,error})`
    → `{wrap, input, setError(msg), clearError(), isInvalid()}`
- `ctx.store` —— `{user, isLoggedIn(), set(u), clear(), refresh()}`
- `ctx.navigate(path)`
- `ctx.query` —— 查询参数对象

### API
```js
API.login(account, password)                        // → {ok, user}
API.recover(account, recoveryCode, newPassword)     // → {ok, recovery_code}
```

**失败时抛 `ApiError`，带 `.code` 与 `.message`（后端中文文案，直接展示即可）。**
后端常见的错误码：`bad_credentials`（账号或密码错误）、`too_many_requests`（锁定）、
`invalid_account`、`invalid_password`、`weak_password`。

---

## 视图契约
`function login(ctx)` 返回一个 DOM 节点。整体挂进 `#app`。

## 已登录时的处理
若 `ctx.store.isLoggedIn()` 为真 → 返回 `UI.empty('✓','你已经登录了','')` +
一个 `去我的主页` 按钮 → `ctx.navigate('/me')`。**不要**自动跳转。

---

## 页面结构

外层：`UI.el('div', {class:'page page--narrow section'})`，内容包在一张
`card card--pad-lg` 里，最大宽度 460px 居中。

### 模式切换
两个模式共用一个卡片，通过顶部的分段切换：
- `登录` / `忘记密码`，用 `UI.segmented([{label:'登录',value:'login'},{label:'忘记密码',value:'recover'}], mode, fn)`
- 切换时**只替换表单区**，不清空已经填过的账号

### 模式 A · 登录
- 标题：`欢迎回来`，副标题：`用注册时填的账号和密码登录。`
- `UI.field` × 2：
  1. `id:'lg-acc'`，`label:'登录账号'`，`placeholder:'邮箱 / 手机号'`，必填，`autocomplete:'username'`
     - 2026-09-18 起不再写「QQ 号」（不主动索要）；
       但后端仍放行纯数字账号，历史用 QQ 号注册的用户照常能登
  2. `id:'lg-pw'`，`label:'4 位数字密码'`，必填，`pin:true`，`inputmode:'numeric'`，`maxlength:4`，`autocomplete:'current-password'`
     - `input` 事件里只收数字：`value.replace(/\D/g,'').slice(0,4)`
- 主按钮：`登录`（`btn btn--block btn--lg`）
  - 账号为空或密码不足 4 位时 `disabled`
  - 点击：`UI.withLoading` → `API.login(account, password)`
    - 成功 → `ctx.store.set(res.user)` → `UI.toast('登录成功','success')` →
      **若有 `ctx.query.next` 则 `ctx.navigate(ctx.query.next)`，否则 `ctx.navigate('/me')`**
    - 失败 →
      - `err.code === 'too_many_requests'` → 在表单上方显示 `UI.alertBox('error', err.message)`
        （因为这是账号级锁定，不是字段问题），并把按钮禁用 30 秒倒计时，按钮文案显示
        `请稍等 Ns`
      - `err.code === 'bad_credentials'` → 定位到密码字段 `setError('账号或密码错误')`，
        并在表单上方显示 error 提示条，文案：
        `账号或密码错误。连续输错 5 次会锁定账号 15 分钟。`
      - 其它 → `UI.toast(err.message, 'error')`
- 表单下方一条 warn 告知（固定文案）：
  `我们买不起短信验证／邮箱验证服务，如果你忘了密码，请用注册时拿到的找回码重置。`

### 模式 B · 忘记密码
- 标题：`用找回码重置密码`，副标题：`找回码是注册时给你的那串 XXXX-XXXX-XXXX。`
- `UI.field` × 3：
  1. `id:'rc-acc'`，`label:'登录账号'`，`placeholder:'邮箱 / 手机号'`，必填
  2. `id:'rc-code'`，`label:'找回码'`，必填，
     `placeholder:'XXXX-XXXX-XXXX'`，
     `autocomplete:'one-time-code'`
     - `input` 事件里：只保留 `A-Z0-9-`，转大写，并**自动补连字符**——
       每输入 4 个字符插一个 `-`，总长不超过 14。实现要正确处理粘贴整串的情况。
  3. `id:'rc-pw'`，`label:'新密码'`，必填，`pin:true`，`inputmode:'numeric'`，`maxlength:4`
- 主按钮：`重置密码`
  - 三项中任一为空/不合法则 `disabled`
  - 点击：`API.recover(account, code, newPassword)`
    - 成功 → 用 `UI.modal({dismissible:false})` 显示新的找回码：
      标题 `密码已重置`，副标题 `旧密码和旧找回码都已作废。这是你的新找回码，只显示这一次，请立刻抄下来。`，
      用大号等宽字体展示 `res.recovery_code`，提供 `复制` 按钮
      （`navigator.clipboard.writeText`，失败提示手动复制），
      确认按钮 `我已保存，去登录` → 关闭弹窗、切回模式 A、账号预填、清空密码
    - 失败 →
      - `code === 'bad_credentials'` → 定位到找回码字段 `setError('账号或找回码错误')`
      - 其它 → `UI.toast(err.message, 'error')`
- 表单下方一条 info 提示：
  `重置成功后，其它设备上的登录都会失效，需要用新密码重新登录。`

---

## 质量红线（逐条审查，违反即打回）

1. **绝不用 `innerHTML` 承载任何用户数据**。账号、找回码等只能用 `UI.el` 的 `text`。
2. 不得直接 `fetch`，一律走 `API`。
3. **不要用可选链 `?.` 和空值合并 `??`**。
4. 不得在客户端保存或缓存密码（不得写 `localStorage` / `sessionStorage`），
   提交后立即从内存变量释放的概念不强制，但**绝不能持久化**。
5. 所有异步分支必须有 `catch` 并给出可理解提示。
6. 按钮的异步动作必须用 `UI.withLoading` 包裹，防重复提交。
7. 输入框实时校验，用户重新输入时 `clearError()` 清掉旧错误态。
8. 模式切换不得丢失已填内容。
9. 注释用中文，只写关键决策。
10. 代码必须能在浏览器直接执行。

直接输出完整代码。

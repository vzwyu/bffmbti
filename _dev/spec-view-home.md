# 任务：实现首页视图 `web/js/views/home.js`

输出**一个完整的 JS 文件**，不解释、不加 markdown 围栏。第一行 `'use strict';`

---

## 运行环境

纯浏览器 CommonJS **不是** —— 这是浏览器脚本，用 IIFE 挂到全局，**没有 require、没有 import、没有构建**。
文件结构固定如下（不要改）：

```js
'use strict';
(function (global) {
  var UI = global.UI;
  var API = global.API;
  var MBTI = global.MBTI;

  function home(ctx) { /* ... */ }

  global.Views = global.Views || {};
  global.Views.home = home;
})(typeof window !== 'undefined' ? window : this);
```

**可直接使用的全局对象（已存在，不要重新实现）：**

### `MBTI`
```js
MBTI.TYPES   // 16 个类型，顺序即 4×4 网格顺序
             // {code:'INTJ', cn:'架构师', en:'Architect', slug:'architect',
             //  group:'NT', color:'#88619A', tagline:'...'}
MBTI.GROUPS  // {NT:{cn:'分析家',en:'Analysts',color:'#88619A'}, NF:…, SJ:…, SP:…}
MBTI.AXES    // [{key:'IE',left:'I',right:'E',leftCn:'内向',rightCn:'外向',…}, …] 共 4 项
MBTI.get(code)        // → 类型对象，非法返回 null
MBTI.isValidCode(c)   // → boolean
MBTI.buildCode({IE,NS,TF,PJ})  // → 'INTJ' 或 null
```

### `UI`（DOM 工具，**所有节点都用它建**）
```js
UI.el(tag, props, children)
//   props 特殊键：text（安全文本）/ class / dataset / style（对象）/ onXxx（函数）
//   其它键作为属性；值为 true 时输出无值属性；null/false 跳过
UI.clear(node)
UI.withLoading(btn, fn)   // 包住异步动作，期间禁用并显示转圈，返回 Promise
UI.toast(msg, kind)       // kind: 'success' | 'error' | 省略
UI.modal({title, sub, body, actions, dismissible})  // body/actions 是 DOM 节点或节点数组
UI.closeModal()
UI.confirmDialog({title, message, note, confirmText, danger})  // → Promise<boolean>
UI.field({id, label, type, placeholder, hint, required, pin, inputmode, maxlength, autocomplete, value, readonly, error})
//   → {wrap, input, setError(msg), clearError(), isInvalid()}
UI.segmented(options, value, onChange)   // options: [{label, value}]
UI.persona(type, size)   // type 是 MBTI.get() 结果；返回带头像的元素，图缺失时自动退回主题色圆形
UI.empty(icon, title, desc)
UI.alertBox(kind, text)  // kind: 'info'|'warn'|'error'|'success'
UI.axisVoteBars(axes)    // 见 visitor/profile 的说明，本视图用不到
UI.fmtTime(iso)
```

### `API`（网络层，**视图不得直接 fetch**）
```js
API.register(nickname, account, password)  // → {ok, user, recovery_code, share_token}
API.login(account, password)               // → {ok, user}
API.logout()                               // → {ok}
API.me()                                   // → {ok, user}
API.updateProfile(patch)                   // patch: {nickname?, gender?}
API.setMbti(mbti, password?)               // 首次无需密码 → {ok, user, changed, remaining_edits}
API.mbtiPermission()                       // → {ok, can_edit, reason, remaining_edits, label}
API.publicUser(token)                      // → {ok, user}
API.submitVote(token, {voter_nickname, IE, NS, TF, PJ})
API.summary(token)                         // → {ok, summary}
API.listVotes(token, limit, offset)        // → {ok, total, votes}
```
**所有 API 方法返回 Promise，失败时抛 `ApiError`，带 `.code` 和 `.message`（后端给的中文文案，可直接展示）。**
网络层失败统一是 `code === 'SUBMIT_FAILED'`，`message === '提交失败，请稍后重试'`。

### `ctx`
```js
ctx.params           // 路径参数对象
ctx.query            // 查询参数对象
ctx.store            // { user, ready, isLoggedIn(), shareToken(), set(u), clear(), refresh() }
                     //   ctx.store.user 是 selfUser 或 null
                     //   selfUser = {token, nickname, gender, login_account, mbti_self, mbti_edit_count, created_at}
ctx.navigate(path)   // 站内跳转，path 以 / 开头且不含挂载前缀，如 '/me'、'/s/abc'
```

---

## 视图契约

```js
function home(ctx) { ... }
```
**返回一个 DOM 节点**（同步或 Promise 均可）。这个节点会被整个挂进 `#app`。
视图必须自己把异常处理掉（显示错误态），不要往外抛。

---

## 本视图要实现的界面

### 状态判定（进入时）
1. **未登录** → 弹出注册弹窗（见下），背景显示 16 型网格但**不可交互**（卡片加 `aria-disabled="true"` 并降低透明度）
2. **已登录、`mbti_self` 为空** → 直接展示可交互的 16 型网格
3. **已登录、已有 `mbti_self`** → 直接展示「分享页」（见下），不再显示网格

### 注册弹窗（仅状态 1）
用 `UI.modal()` 实现，`dismissible: false`（必须填完才能进）。

- 标题：`先认识一下`
- 副标题：`填写后即可创建你自己的测试页，并把它分享给朋友。`
- 三个 `UI.field`：
  1. `我该如何称呼您？` — **必填**，提示"最长 32 个汉字或 64 个英文字符"
  2. `邮箱 / 手机号` — **必填**，提示"换设备登录时用它"（2026-09-18 起不再出现「QQ 号」，见 spec-auth.md 修订说明）
  3. `4 位数字密码` — **必填**，`pin: true`，`inputmode:'numeric'`，`maxlength:4`，`autocomplete:'new-password'`，提示"请勿与银行卡密码一致"
     - **只收数字**：`input` 事件里 `value.replace(/\D/g,'').slice(0,4)`
- 弹窗底部放一条 **warn 样式**的告知（用 `UI.alertBox('warn', …)`）：
  `我们买不起短信验证／邮箱验证服务，因此请务必妥善保存登录账号和密码，否则将无法找回。`
- 隐私说明（小字灰色）：
  `收集这些信息仅用于让你日后登录和找回自己的测试结果，我们不会使用、也不会主动泄露你的任何个人信息。`
- 主按钮：`创建并开始选择`

**提交行为**：
- 前端先做基本校验（称呼非空、账号非空、密码 4 位数字），不通过则用 `field.setError()` 定位到具体字段，不发请求
- 调 `API.register(nickname, account, password)`
- 成功：
  - `ctx.store.set(res.user)`
  - **必须显著告知用户找回码**：再弹一个不可关闭的弹窗，标题 `请记下你的找回码`，
    正文说明"忘记密码时用它重置。这个码只显示这一次，请立刻抄下来。"，
    用大号等宽字体展示 `res.recovery_code`，并提供「复制」按钮（`navigator.clipboard.writeText`，
    失败则提示用户手动选中复制），确认按钮 `我已保存，开始选择`
  - 关闭后切到状态 2（渲染可交互的 16 型网格）
- 失败：`err.message` 直接 `toast(err.message, 'error')`；若是 `ACCOUNT_TAKEN` 之类，
  把错误定位到账号字段上（`field.setError(err.message)`）

### 16 型选择网格（状态 2）
- 外层 `<div class="types-grid">`，**4×4**，直接遍历 `MBTI.TYPES`（顺序已按 4×4 排好）
- 每个卡片 `<button type="button" class="type-card" data-group="{group}" aria-pressed="false">`，内部从上到下：
  1. `UI.persona(type)` 生成的形象
  2. `type-card__code` → 代码，如 `INTJ`
  3. `type-card__cn` → 中文名，如 `架构师`
  4. `type-card__en` → 英文名，如 `Architect`
  5. 选中勾：`<span class="type-card__check">✓</span>`
- 点击：单选（先全部置 `aria-pressed="false"`，再把自己置 `true`），并记住选择
- 再点已选中的卡片 → 取消选中
- 网格上方放一句提示：`选一个最像你的类型。不用纠结，之后还能改一次。`
- 网格下方：
  - 一个 `提交并分享` 按钮（`class="btn btn--lg btn--block"`），**未选任何类型时 `disabled`**
  - 一行隐私小字：`我们会把你的选择存下来，生成一个只有拿到链接的人才能看到你称呼的页面。`

**提交行为**：
- 调 `API.setMbti(选中的 code)`（首次设置不需要密码）
- 成功：`ctx.store.refresh()` 后切到状态 3，`toast('已生成你的专属链接', 'success')`
- 失败：`toast(err.message || '提交失败，请稍后重试', 'error')`

### 分享页（状态 3）
- 大字标题：`你的专属链接已生成`
- 一行说明：`把它发给朋友，看看他们眼中的你是什么样。`
- 链接框（结构固定）：
  ```
  <div class="share-box">
    <input class="share-box__url" readonly value="{完整链接}">
    <button class="btn">复制</button>
  </div>
  ```
  **完整链接 = `location.origin + 挂载前缀 + '/s/' + token`**，
  挂载前缀取 `global.App.BASE_PATH`（已存在，值为 `/games/mbti`）。
  注意：如果当前路径已经是 `/s/xxx` 就不用管，本视图只在家目录出现。
- 复制按钮用 `navigator.clipboard.writeText`，成功 `toast('链接已复制','success')`，
  失败则提示"复制失败，请长按选中链接手动复制"
- 下方两个按钮：
  - `查看我的主页` → `ctx.navigate('/me')`
  - `看起来不错，再改一次类型` → 切回状态 2（注意：后端只允许改一次且**需要密码**，
    所以点击后应 `toast('修改类型需要输入密码，请到个人主页操作')` 并 `ctx.navigate('/me')`，**不要**在首页直接改）
- 再下方显示自己的类型卡片（用 `UI.persona` + 代码 + 中英文名），整体加 `data-group` 让主题色生效
- 显示当前收到的评价数：调 `API.summary(token)` 拿 `total_votes`，
  文案 `已有 N 位朋友评价了你`，`N === 0` 时显示 `还没有朋友评价，把链接发出去吧`。
  **这个调用失败不要弹错**，静默降级为不显示该行。

---

## 质量红线（逐条审查，违反即打回）

1. **绝不用 `innerHTML` 承载任何用户数据**。昵称允许 emoji 和特殊符号，只能用 `UI.el` 的 `text` 或 `textContent`。
   `unsafeHTML` 只允许传代码里写死的模板字符串。
2. 不得直接调用 `fetch`，一律走 `API`。
3. 不得出现 `var` 之外的新语法糖？——**允许 ES5+ 的常规写法，但不要用可选链 `?.` 和空值合并 `??`**，
   本项目其余文件均为兼容写法，保持一致。
4. 所有异步分支都要有 `catch`，且给出用户可理解的提示，不得出现"只有骨架屏没有结果"的状态。
5. 按钮的异步动作必须用 `UI.withLoading` 包裹，防止重复提交。
6. 每个 `UI.field` 的错误状态在用户重新输入时要 `clearError()`。
7. 注释用中文，只写关键决策，不要逐行注释。
8. 代码必须能在浏览器直接执行，`node --check` 通过。

直接输出完整代码。

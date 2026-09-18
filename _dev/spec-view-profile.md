# 任务：实现个人主页视图 `web/js/views/profile.js`

输出**一个完整 JS 文件**，不解释、不加 markdown 围栏。第一行 `'use strict';`

## 运行环境

浏览器原生脚本，**无 require / 无 import / 无构建**。文件壳子固定：

```js
'use strict';
(function (global) {
  var UI = global.UI;
  var API = global.API;
  var MBTI = global.MBTI;

  function profile(ctx) { /* ... */ }

  global.Views = global.Views || {};
  global.Views.profile = profile;
})(typeof window !== 'undefined' ? window : this);
```

### 可用全局
- `MBTI.*` 同其它视图：`TYPES / GROUPS / AXES / get(code) / isValidCode(c) / buildCode(o)`
- `UI.*`：`el / clear / withLoading(btn,fn) / toast(msg,kind) / modal({…}) / closeModal() /
  confirmDialog({title,message,note,confirmText,danger}) / field({…}) / segmented(options,value,onChange) /
  persona(type,size) / empty(icon,title,desc) / alertBox(kind,text) / axisVoteBars(axes) / fmtTime(iso)`
- `ctx.store.user` —— `selfUser = {token, nickname, gender, login_account, mbti_self, mbti_edit_count, created_at}`
  - `gender` 取值：`'male' | 'female' | 'other' | 'unset'`；**界面上只提供 男 / 女 / 暂不填写 三项**，
    不要出现"其他"
- `ctx.navigate(path)`
- `global.App.BASE_PATH` = `/games/mbti`

### API
```js
API.me()                        // → {ok, user}
API.updateProfile({nickname?, gender?})   // → {ok, user}
API.setMbti(mbti, password)     // 修改时必须带密码 → {ok, user, changed, remaining_edits}
API.mbtiPermission()            // → {ok, can_edit, reason:'not_set'|'available'|'used', remaining_edits, label}
API.changePassword(oldPw, newPw)          // → {ok}
API.summary(token)              // → {ok, summary}
API.listVotes(token, limit, offset)       // → {ok, total, votes}
API.logout()                    // → {ok}
```
`votes` 每项形如：`{voter_nickname, result_mbti, detail:{code,cn,en,group,color}, created_at}`
（**不含**评价者 IP，后端已过滤）

`summary` 结构（后端算好，**本地不得重算**）：
```js
{ total_votes, low_sample, axes:[{key,left,right,leftCn,rightCn,leftCount,rightCount,
  majority,tie,selfChoice,agreeWithMajority}], majority_mbti, self_mbti,
  divergence_axes:[], has_votes }
```

**API 失败抛 `ApiError`，带 `.code` 与 `.message`（后端中文文案，直接展示即可）。**

---

## 页面结构（自上而下，全部包在 `<div class="page page--narrow section stack">` 里）

### 未登录处理
`ctx.store.isLoggedIn()` 为假 → 返回 `UI.empty('🔒','请先登录','登录后才能查看你的主页')`
加一个 `去登录` 按钮 → `ctx.navigate('/login')`。**不要**自动跳转。

### 区块 1 · 头部
- 大字：`{nickname} 的主页`
- 小字：`加入于 {created_at 格式化为 YYYY年M月D日}`
- 右上角一个 `退出登录` 文字按钮（`btn btn--quiet btn--sm`），点击先 `UI.confirmDialog` 确认，
  确认后 `API.logout()` → `ctx.store.clear()` → `ctx.navigate('/')`

### 区块 2 · 我的 MBTI
- 若 `mbti_self` 有值：用 `UI.persona(type)` 生成形象 + 代码（大字主题色）+ 中文名 + 英文名，
  整体加 `data-group="{group}"`；再显示一条类型描述 `type.tagline`（灰色小字）
- 若为空：显示 `还没选择你的类型` + 一个 `去选择` 按钮 → `ctx.navigate('/')`
- 修改按钮：进入时调 `API.mbtiPermission()` 拿到 `can_edit` 与 `label`
  - 按钮文案直接用后端给的 `label`
  - `can_edit === false` 时按钮 `disabled`，并在下方显示灰色小字：
    `修改机会已用完，类型不可再改。如果确实选错了，请联系管理员。`
  - `can_edit === true` 时按钮可点，文案含"仅此一次"提醒
- **修改流程**（点按钮后弹 `UI.modal`，`dismissible:false`）：
  1. 标题 `修改人格类型`
  2. warn 提示：`人格类型原则上只能修改一次，且需要输入密码。修改后，所有分享链接展示的都会是新类型。`
  3. **16 型选择网格**（4×4，`class="types-grid"`，结构同首页：`UI.persona` + 代码 + 中文名 + 英文名 + `.type-card__check`），
     默认选中当前类型；再点已选中的项则取消选中
  4. 一个 `UI.field`，`id:'mbti-pw'`，`label:'输入密码确认'`，`pin:true`，`inputmode:'numeric'`，
     `maxlength:4`，必填，提示 `4 位数字密码`
  5. 按钮 `确认修改`（未选新类型或密码不足 4 位时 `disabled`）
  6. 提交：`UI.withLoading` 包裹 → `API.setMbti(新code, 密码)`
     - 成功 → 关闭弹窗、`ctx.store.refresh()`、`UI.toast('已更新，分享链接里的类型同步变了','success')`、
       **重新渲染整个视图**（简单做法：`ctx.navigate('/me')` 或调用 `global.App.render()`）
     - 失败 → `UI.toast(err.message, 'error')`；若 `code === 'bad_password'` 则定位到密码字段 `setError('密码错误')`

### 区块 3 · 基本资料（一张 `card card--pad-lg`）
- **称呼** —— `UI.field({id:'pf-nick', label:'称呼', hint:'最长 32 个汉字或 64 个英文字符'})`，可编辑，允许 emoji
- **性别（选填）** —— 用 `UI.segmented`，**只给三项**：
  `[{label:'男', value:'male'}, {label:'女', value:'female'}, {label:'暂不填写', value:'unset'}]`
  - 当前值来自 `ctx.store.user.gender`；若为 `'other'`（历史数据）则显示为未选中状态
  - 下方灰色小字：`不填不影响任何功能`
- **登录账号** —— `UI.field({readonly:true, value: 脱敏后的账号, hint:'登录账号不可修改'})`
  - 脱敏规则：邮箱 → 首字符 + `***` + `@域名`；11 位手机号 → 前 3 + `****` + 后 4；
    纯数字（历史 QQ 号账号）→ 前 2 + `***` + 后 2。**本地实现这个函数，不要指望后端给**
- 一个 `保存修改` 按钮（`btn btn--block`）
  - **仅当称呼或性别相对初始值发生变化时才启用**，否则 `disabled`
  - 点击：`UI.withLoading` → `API.updateProfile(只传变化的字段)` → 成功后 `ctx.store.refresh()` +
    `UI.toast('已保存','success')` 并刷新视图
  - 失败：`err.message` → `UI.toast(err.message,'error')`；`code === 'invalid_nickname'` 时
    定位到称呼字段

### 区块 4 · 修改密码
- 三个 `UI.field`（都是 `pin:true`, `inputmode:'numeric'`, `maxlength:4`）：
  `pw-old`（原密码）、`pw-new`（新密码）、`pw-confirm`（确认新密码）
- **实时校验**（`input` 事件）：
  - 只允许数字，`value.replace(/\D/g,'').slice(0,4)`
  - 当新密码与确认密码都是 4 位且不相等时，给确认密码字段 `setError('两次输入的新密码不一致')`
  - 否则 `clearError()`
- `保存` 按钮：**三格都是 4 位数字且两次新密码一致**才启用，否则 `disabled`
- 提交：`API.changePassword(oldPw, newPw)`
  - 成功 → 清空三格、`UI.toast('密码已更新，请用新密码登录','success')`
  - 失败 → `err.message` → `UI.toast(err.message,'error')`；
    `code === 'bad_old_password'` 时定位到原密码字段；`'same_password'` 时定位到新密码字段

### 区块 5 · 大多数人认为你是
- 调 `API.summary(ctx.store.user.token)`
- `total_votes === 0` → `UI.empty('👀','还没有人评价你','把主页链接发给朋友，看看他们眼中的你')`
  并在下面放一个 `生成分享链接` 按钮（调用 `shareEntryBtn('生成分享链接', ctx)` → `openShareModal(ctx)`）

> **2026-09-18 修订：分享入口改为常驻，且统一走弹窗。**
> 原设计只在「还没有评价」空态里放了 `复制分享链接`，一旦有人评价过按钮就消失，
> 用户反馈"之前有这个按钮，现在没了"就是这个原因。现在：
> 1. 个人主页的「我的 MBTI」区块里，**修改按钮右侧**并排放 `生成分享链接`
>    （`shareEntryRow(ctx, editBtn)`，flex + flexWrap → 窄屏自动换行到下一行）
> 2. 空态那个按钮也改为同一个入口、同一文案，**删掉了原来的 `copyShare`**
> 3. 链接**不需要"生成"**：`user.token` 是注册时生成、永不改变的公开标识，
>    链接天然固定、跨次复用（链接 = `location.origin + App.BASE_PATH + '/s/' + token`），
>    函数只负责展示与复制，弹窗里明确写明"这个链接是固定的，之前发过的不用重发"
> 4. 弹窗实现 `openShareModal` 由 Kimi K3 按 `_dev/spec-share-modal.md` 生成，
>    插入位置在原 `copyShare` 处，标注 `区块 8`
> 5. 复制走 `navigator.clipboard.writeText`，失败或不可用时回落到「全选聚焦 + 手动复制」提示
- 否则：
  - 一行汇总：`共 {total_votes} 位朋友评价`，
    若 `majority_mbti` 有值则追加 `，大多数人认为你是 {majority_mbti} · {中文名}`
  - `low_sample === true` 时加一条 info 提示：`评价人数还少，结果仅供参考。`
  - **偏差摘要**（这是本页的重点，必须有）：
    - `divergence_axes.length === 0` → 一条 success 提示：
      `朋友们的印象和你自己的认知完全一致。`
    - 否则 → 一条 warn 提示，逐个轴说明，格式：
      `{N} 个维度上，朋友的印象和你自己的认知不同：思考 T ／ 情感 F（多数人认为 F，你认为 T）；感知 P ／ 判断 J（多数人认为 J，你认为 P）`
      —— 轴的中文名从 `summary.axes` 里取 `leftCn/rightCn`，**不要在本文件里硬编码轴名称**
  - **票型条**：`UI.axisVoteBars(summary.axes)` 包在 `card card--pad-lg` 里，上方小标题 `朋友们的具体选择`
  - `查看评价明细` 按钮 → 打开评价明细（见区块 6）

### 区块 6 · 评价明细（弹窗或内联展开，二选一，推荐弹窗）
- 点 `查看评价明细` → 调 `API.listVotes(token, 50, 0)` → 用 `UI.modal` 展示
- 弹窗标题：`评价明细`，副标题：`共 {total} 条，最新在前`
- 每条渲染成一个标签卡：
  ```
  <div class="vote-item" data-group="{detail.group}">
    <div class="vote-item__avatar">…persona 占位…</div>
    <div class="vote-item__body">
      <div class="vote-item__name">{voter_nickname}</div>
      <div class="vote-item__meta">认为你是 {detail.cn}（{detail.en}） · {格式化时间}</div>
    </div>
    <div class="vote-item__code">{result_mbti}</div>
  </div>
  ```
  - 外层容器 `<div class="vote-list">`
  - **`voter_nickname` 必须用 `text` 赋值**，允许 emoji 与超长名字，
    样式上已经做了 `text-overflow: ellipsis`，不用自己截断
  - 时间用 `UI.fmtTime(created_at)`
  - 头像用一个 `UI.el('div',{class:'vote-item__avatar'})`，里面放该类型代码前两位的
    `<span>`（颜色取 `var(--g)`），**不要调 `UI.persona`**（明细里图太小，形式不统一）
- 若 `total > 50`，底部加 `加载更多` 按钮，点一次 `offset += 50` 追加渲染；
  加载中按钮显示 `is-loading`；已全部加载完则按钮消失
- 空态：`total === 0` → `UI.empty('📭','还没有评价','把链接发给朋友吧')`

---

## 质量红线（逐条审查，违反即打回）

1. **绝不用 `innerHTML` 承载任何用户数据**。称呼、评价者昵称允许 emoji 与特殊符号，
   只能用 `UI.el` 的 `text` 或 `textContent`。
2. 不得直接 `fetch`，一律走 `API`。
3. **不要用可选链 `?.` 和空值合并 `??`**。
4. `summary` 一律用后端算好的，本地**不得重算**票数或众数。
5. `majority_mbti` / `self_mbti` / `MBTI.get()` 的返回值都**可能为 null**，取用前必须判空。
6. 所有异步分支必须有 `catch` 并给出可理解提示，不得停留在加载态或骨架屏。
7. 按钮的异步动作必须用 `UI.withLoading` 包裹，防重复提交。
8. 输入框实时校验，用户重新输入时要调用 `clearError()` 清掉旧的错误态。
9. 性别选项**只能有 男 / 女 / 暂不填写**三项，不得出现"其他"。
10. 注释用中文，只写关键决策。
11. 代码必须能在浏览器直接执行。

直接输出完整代码。

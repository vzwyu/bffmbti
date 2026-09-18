# 任务：实现访客评价视图 `web/js/views/visitor.js`

输出**一个完整 JS 文件**，不解释、不加 markdown 围栏。第一行 `'use strict';`

---

## 运行环境（与其它视图完全一致）

浏览器原生脚本，**无 require / 无 import / 无构建**。文件壳子固定：

```js
'use strict';
(function (global) {
  var UI = global.UI;
  var API = global.API;
  var MBTI = global.MBTI;

  function visitor(ctx) { /* ... */ }

  global.Views = global.Views || {};
  global.Views.visitor = visitor;
})(typeof window !== 'undefined' ? window : this);
```

### 可用全局
- `MBTI.TYPES` / `MBTI.GROUPS` / `MBTI.AXES` / `MBTI.get(code)` / `MBTI.isValidCode(c)` / `MBTI.buildCode({IE,NS,TF,PJ})`
  - `MBTI.AXES` 共 4 项，顺序为 IE / NS / TF / PJ，每项形如
    `{key:'IE', left:'I', right:'E', leftCn:'内向', rightCn:'外向', leftDesc:'…', rightDesc:'…'}`
- `UI.el` / `UI.clear` / `UI.withLoading(btn,fn)` / `UI.toast(msg,kind)` / `UI.modal({…})` / `UI.closeModal()` /
  `UI.confirmDialog({…})` / `UI.field({…})` / `UI.segmented(...)` / `UI.persona(type,size)` /
  `UI.empty(icon,title,desc)` / `UI.alertBox(kind,text)` / `UI.axisVoteBars(axes)` / `UI.fmtTime(iso)`
- `API.publicUser(token)` → `{ok, user:{token,nickname,gender,mbti_self}}`（**不含任何账号信息**）
- `API.submitVote(token, {voter_nickname, IE, NS, TF, PJ})` → `{ok, your_choice, your_choice_detail, summary}`
- `API.summary(token)` → `{ok, summary}`
- `UI.axisVoteBars(summary.axes)` 直接返回画好的票型条节点，**明细页直接用，不要自己再画**
- `ctx.params.token` —— 分享链接里的标识
- `ctx.store` —— `{user, isLoggedIn(), ...}`，`ctx.store.user` 为当前登录用户或 null
- `ctx.navigate(path)` —— 站内跳转，如 `'/me'`、`'/'`
- `global.App.BASE_PATH` —— 挂载前缀 `/games/mbti`

`summary` 结构（后端已算好，**不要在本地重算**）：
```js
{
  total_votes: 12,
  low_sample: false,            // total_votes < 3 时为 true
  axes: [{
    key:'IE', left:'I', right:'E', leftCn:'内向', rightCn:'外向',
    leftCount:7, rightCount:5,
    majority:'I',               // 多数侧；平票时回落到本人自我认知；仍无法判定则为 null
    tie:false,                  // 是否平票
    selfChoice:'I',             // 本人自我认知在该轴的值，未知为 null
    agreeWithMajority:true      // 任一为 null 时也是 null
  }, /* NS, TF, PJ */],
  majority_mbti:'INFJ',         // 四轴都能判定时才给，否则 null
  self_mbti:'INTP',             // 可能为 null
  divergence_axes:['TF','PJ'],  // 自我认知与多数不一致的轴
  has_votes:true
}
```

**所有 API 失败时抛 `ApiError`，带 `.code` 与 `.message`（后端中文文案，可直接展示）。**
网络层失败统一 `code === 'SUBMIT_FAILED'`、`message === '提交失败，请稍后重试'`。

---

## 视图契约
`function visitor(ctx)` 返回一个 DOM 节点（同步或 Promise）。节点整体挂进 `#app`。异常自行兜底。

---

## 交互流程（严格按顺序实现）

### 第 0 步：加载
- 调 `API.publicUser(ctx.params.token)`
- 失败（404）→ 返回 `UI.empty('🔗', '这个链接无效或已失效', '找发给你的人要一个新的链接吧')`，
  不要弹错误 toast
- 成功 → 拿到 `user.nickname`，进入第 1 步

### 第 1 步：问称呼（弹窗）
- 用 `UI.modal({dismissible:false})`
- 标题：`我该怎么称呼您？`
- 副标题：`填个名字，让你的评价有署名。`
- 一个 `UI.field`，`id:'voter-name'`，**必填**，最大 4 位？——不，**按后端的昵称规则：最长 32 个汉字或 64 个英文字符**，
  提示文案写这个。允许 emoji。
- 主按钮 `开始评价`
- **先读 `localStorage.getItem('mbti_voter_name')`**，有值则预填，并允许直接点按钮进入；
  留空则必须填。
- 提交：校验非空 → 写入 `localStorage.setItem('mbti_voter_name', name)` → 关闭弹窗 → 进入第 2 步
- **注意：这一步不调后端**，纯本地

### 第 2 步：四轴量表
页面结构：
- 大标题：`你认为 {nickname} 的 MBTI 更倾向以下哪种？`
  （`nickname` 用 `UI.el` 的 `text` 传入，**不得拼 HTML**）
- 若 `summary.total_votes === 0`，标题下方加一句灰色小字：`你是第一个来评价的人。`
- 四个量表，**每个用这个结构**（`UI.el` 构造）：
  ```
  <div class="axis">
    <div class="axis__head">内向 还是 外向 ？</div>     ← 未选时文案；选中后改为「已选：外向（E）」
    <div class="axis__picks">
      <button class="axis__opt" aria-pressed="false">
        <span class="axis__letter">I</span>
        <span class="axis__label">内向</span>
        <span class="axis__desc">更愿意独处，从内部世界获得能量</span>
      </button>
      <button class="axis__opt" aria-pressed="false"> …… E / 外向 …… </button>
    </div>
  </div>
  ```
  - 左右两个按钮结构一致，点左半侧选 `left`，点右半侧选 `right`
  - 同一轴内单选：选中前先把该轴所有按钮置 `aria-pressed="false"`
- 进度行：`已选 N / 4`，以及一个 `提交` 按钮
  - **四轴未全选时按钮 `disabled`**
- 点提交：调 `API.submitVote(token, {voter_nickname, IE, NS, TF, PJ})`，用 `UI.withLoading` 包裹
  - 成功 → 进入第 3 步，用响应里的 `summary` 与 `your_choice`
  - 失败 → `UI.toast(err.message || '提交失败，请稍后重试', 'error')`，按钮恢复可点
  - **注意 `code === 'too_soon'` / `'too_many_requests'` 时**，提示后保持按钮可点但禁用 10 秒并倒计时

### 第 3 步：结果对比
- 三张卡片横排（外层 `<div class="result-triple">`，该样式在预览页里定义，本视图**用行内 style 实现响应式**：
  用 `UI.el('div', {style:{display:'grid', gap:'var(--sp-3)'}})`，
  并在宽度 ≥860px 时三列——用 `global.matchMedia('(min-width:860px)')` 判断后设 `gridTemplateColumns`）
  - 卡片 1：`你认为` + 你的选择（`MBTI.get(your_choice)`）
  - 卡片 2：`{nickname} 认为自己是` + `summary.self_mbti`；若 `self_mbti` 为 null 则显示 `还没选择`
  - 卡片 3：`大多数人认为` + `summary.majority_mbti`；若为 null 则显示 `还看不出来`
  - 卡片结构：`who` 小字 → `UI.persona(type)` 形象 → 代码（大号主题色）→ 中文名 → 英文名
  - 用 `data-group`（或直接设 `--g`）让卡片主题色跟随类型分组
- 卡片下方一句话总结，**必须包含三个结果**：
  - 三张都有值时：`你认为 {nickname} 是 {your_choice}，{nickname} 认为自己是 {self_mbti}，大多数人认为是 {majority_mbti}。`
  - 对方未选类型时：`你认为 {nickname} 是 {your_choice}，ta 还没选择自己的类型。`
  - 样本不足（`total_votes < 3`）时追加：`（目前只有 {total_votes} 人评价，结果仅供参考）`
- **完整票型条**：直接 `UI.axisVoteBars(summary.axes)`，放在一个 `class="card card--pad-lg"` 里，
  上方加小标题 `大家怎么看你`。若 `summary.total_votes === 0`
  （理论上刚提交完至少 1 票，但防御性处理）则用 `UI.empty` 代替。
- 底部按钮：`我也要测试`
  - 用 `UI.el('button', {class:'btn btn--lg'})`
  - 点击逻辑：
    - 若 `ctx.store.isLoggedIn()` → `ctx.navigate('/me')`
    - 否则 → `ctx.navigate('/?prefill=' + encodeURIComponent(已填写的评价者称呼))`
  - 下方小字：`你已经填过称呼了，注册时不用再填一次。`

---

## 质量红线（逐条审查，违反即打回）

1. **绝不用 `innerHTML` 承载任何用户数据**。昵称与评价者称呼都允许 emoji / 特殊符号，
   只能用 `UI.el` 的 `text` 属性或 `textContent`。`unsafeHTML` 仅限代码内写死的模板。
2. 不得直接 `fetch`，一律走 `API`。
3. **不要用可选链 `?.` 和空值合并 `??`**，与项目其余文件保持一致的兼容写法。
4. `summary` 一律用后端算好的，**本地不得重新统计票数或重算众数**。
5. 所有异步分支必须有 `catch` 且给出可理解提示，不得停留在加载态。
6. 提交按钮必须用 `UI.withLoading` 包裹，防重复提交。
7. `majority_mbti` / `self_mbti` 可能为 `null`，取 `MBTI.get()` 前必须判空，否则会崩。
8. 注释用中文，只写关键决策。
9. 代码必须能在浏览器直接执行。

直接输出完整代码。

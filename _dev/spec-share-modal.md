# 任务：为个人主页新增「分享链接」弹窗函数

## 运行环境（硬约束）

- 纯浏览器前端，**零第三方依赖**，不使用任何构建工具
- **只能用 ES5 语法**：`var` / `function`，**禁止** `let` `const` 箭头函数 模板字符串
  可选链 `?.` 空值合并 `??` `class` 解构赋值 默认参数 展开运算符
- 代码会被拼进一个大 bundle 里当普通 script 执行，**不要**使用 `import` / `export` / `require`
- 不要引用 `window.` 上未列出的对象

## 交付物（只产出这一段，不要产出整个文件）

**一个完整的函数 `openShareModal(ctx)`**，可直接插入 `web/js/views/profile.js`。

不要输出任何其它函数、不要输出 `module.exports`、不要输出 markdown 代码围栏、
不要写解释文字。**只输出这一个函数的源码。**

## 该文件内已存在、可直接调用的东西（逐字照抄，不要重新实现）

```js
// 已定义：拼完整分享链接。token 来自 ctx.store.user.token
function shareLink(token) {
  return location.origin + global.App.BASE_PATH + '/s/' + token;
}

// 已定义：取错误文案
function errMsg(err, fallback) {
  return (err && err.message) ? err.message : fallback;
}
```

`UI` 是全局对象（`global.UI`），可用方法签名如下**（严格按此调用，不要臆造参数名）**：

```js
UI.el(tag, props, children)
// props 支持的键：class / type / text / value / id / placeholder / readonly(布尔) / style(对象)
//                 dataset(对象) / onclick(函数) / 以及任意 HTML 属性
// children 可以是一个节点，也可以是节点数组，也可以省略

UI.modal({ title, sub, subtitle, body, actions, dismissible })
// body：DOM 节点 / 字符串 / 节点数组 / UI.field() 的返回值，都可以
// actions：节点数组，或 [{ label, kind, onClick }]
// dismissible：布尔，true 表示点遮罩/关闭按钮可关

UI.closeModal()                 // 关闭当前弹窗
UI.toast(message, kind)         // kind: 'success' | 'error' | 'info'
UI.alertBox(kind, text)         // kind: 'info' | 'warn' | 'error' | 'success'，返回一个 DOM 节点
UI.empty(icon, title, desc)     // 返回空态节点（本任务不需要）
```

## 现有 CSS 类（已在设计系统里定义好，直接用，不要写内联颜色）

- `.share-box` —— 横向容器（移动端自动变纵向），内部放输入框 + 复制按钮
- `.share-box__url` —— 只读链接输入框，已带 `min-width:0; flex:1`
- `.btn` —— 主按钮（蓝底白字）
- `.btn--ghost` —— 描边按钮
- `.btn--block` —— 整行宽
- `.muted` —— 灰色小字
- `.stack` —— 纵向排列且带间距

## 函数行为规格

`openShareModal(ctx)` 打开一个弹窗，让用户看到并复制自己的分享链接。

1. 取 token：`ctx.store.user.token`。
   **注意：这个 token 是注册时就生成且永不改变的，所以链接天然是固定的。
   本函数只负责展示与复制，绝不能重新生成 token，也不得发起任何网络请求。**
2. 计算链接：`var link = shareLink(token);`
3. 弹窗 title 固定为：`你的专属链接`
4. body 由三部分组成，按顺序：
   - 一个 `UI.alertBox('info', '...')`，文案必须是这句：
     `这个链接是固定的，改过人格类型后还是同一个链接，之前发过的不用重发。`
   - 一个 `.share-box` 容器，里面**按顺序**放：
     - 只读输入框：`UI.el('input', { class: 'share-box__url', type: 'text', readonly: true, value: link })`
       - 给它绑 `click` 事件，点击时调用 `this.select()` 全选内容（方便用户长按复制）
     - 复制按钮：`UI.el('button', { class: 'btn', type: 'button', text: '复制' })`
   - 一句灰色说明：`UI.el('p', { class: 'muted', text: '拿不到链接时，长按上面的输入框选中再复制。' })`
5. 复制按钮点击行为：
   - 若 `navigator.clipboard` 与 `navigator.clipboard.writeText` 都存在 →
     调用 `navigator.clipboard.writeText(link)`：
     - 成功 → `UI.toast('链接已复制，发给朋友吧', 'success')`
     - 失败 → 让输入框全选聚焦（`.focus()` + `.select()`），
       并 `UI.toast('复制失败，长按输入框手动复制', 'error')`
   - 否则（老浏览器 / 非安全上下文）同样走「全选聚焦 + 失败提示」这条兜底
6. 弹窗 `dismissible: true`，不传 `actions`（只靠右上角关闭）
7. **全程不要抛异常**：任何一步失败都要优雅降级（提示而不是白屏）。
   整个函数体外层包 try/catch，catch 里 `UI.toast('打开分享链接失败，请刷新重试', 'error')`。

## 质量红线（我会逐条审查，违反即打回重写）

1. 不得出现 ES6+ 语法（见开头硬约束）
2. 不得出现 `fetch` / `XMLHttpRequest` / `API.` 开头的任何调用
3. 不得重新生成或写入 token（不得出现对 `user.token` 的赋值）
4. 不得使用 `innerHTML`（必须是 `text` 属性或 `textContent`，防 XSS）
5. 不得写死颜色值（hex / rgb）
6. 必须包 try/catch，且 catch 里有用户可见提示（不是只 console）
7. 变量名不得与文件内已有的 `shareLink` / `errMsg` / `copyShare` 冲突

## 输出格式

只输出：

```js
  // ---------- 区块 8 · 分享链接（弹窗） ----------
  function openShareModal(ctx) {
    ...
  }
```

函数体内部缩进 2 空格；外层缩进 4 空格（与文件内其它函数一致）。

## 目标

在 Git Workbench 面板中，文件列表下方（状态栏之上）新增一个可折叠的「提交历史」区域：

- 折叠列表：`短哈希 + 提交说明 + 作者 · 相对时间`
- 点击某条提交，在该条**下方就地展开属性表**：完整哈希、作者、作者时间、提交时间、父提交、说明正文
- 属性表内列出该提交改动的文件（`M/A/D/R`），点文件在整页 sheet 里看该提交中这个文件的 diff（复用现有 `patchHtml` / `openSheet`）
- 列表支持「加载更多」（30 → 最多 200 条），空仓库（无提交）显示占位提示

只新增只读能力，不改动暂存/提交/推送的现有语义。

## 数据层：`git-workbench/git.js`

新增/扩展（全部沿用 `runGit(root, args)` 参数数组，不拼 shell）：

1. `isSafeSha(value)`：`/^[0-9a-f]{7,40}$/i`，用于校验面板传来的 sha。
2. `parseLogRecords` 扩展 `format === "history"` 分支，字段按 `\x1f` 切分、记录按 `\x1e` 切分：
   `%H %h %s %an %aI %cn %cI %p %b` → `{ sha, shortSha, subject, author, authorDate, committer, commitDate, parents[], body }`（`body` 由调用方截断到 2000 字符）。
3. `log(root, limit = 30)`：先 `hasCommits(root)`，无提交返回 `[]`；否则
   `git log -n <limit> --no-color --format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%cn%x1f%cI%x1f%p%x1f%b%x1e`
4. `commitFiles(root, sha)`：`git show --name-status --find-renames --format= <sha>`，
   解析为 `[{ letter, path, origPath|null }]`（`R100\told\tnew` 归并为 rename；`A/D/M/T` 取首字母）。
5. `commitDiff(root, sha, filePath)`：`git show --no-color --format= --find-renames <sha> -- <filePath>`，返回 patch 文本（路径用现有 `isSafeRelativePath` 校验）。
6. 更新 `module.exports`。

## 通道层：`git-workbench/main.js`

在 `onPanelInvoke` 增加三个只读通道，并把它们写进文件头注释：

| 通道 | 入参 | 行为 |
| --- | --- | --- |
| `git.log` | `{ limit? }` | `limit` 限制在 1–200（默认 30），返回 `{ ok, commits, truncated }` |
| `git.commitFiles` | `{ sha }` | 校验 sha → 返回 `{ ok, sha, files }` |
| `git.commitDiff` | `{ sha, path }` | 校验 sha + `requirePaths` → 返回 `{ ok, sha, path, patch }` |

sha 非法时抛 `INVALID_ARGUMENT`（沿用现有 `fail()`）。`git.state` 保持不动，避免 6 秒轮询里多打一次 `git log`。

## 界面：`renderer/index.html`

在 `<main class="lists">` 与 `<footer class="statusbar">` 之间插入：

```html
<section class="history" id="history">
  <header class="history-head">
    <button class="collapse" id="historyToggle" aria-expanded="true">…chevron…</button>
    <h2>提交历史</h2>
    <span class="count" id="historyCount" hidden></span>
    <div class="group-actions"><button class="mini" id="historyMore" title="加载更多">…</button></div>
  </header>
  <div class="history-body" id="historyBody">
    <ol class="commits" id="commits"></ol>
    <div class="history-empty" id="historyEmpty" hidden></div>
  </div>
</section>
```

## 界面：`renderer/panel.js`

- `state.history = { commits: [], limit: 30, expanded: null, files: new Map(), loading: false, collapsed: false }`
- `relativeTime(iso)`：`Intl.RelativeTimeFormat("zh-CN")`（分钟/小时/天/月），超过一年回退 `YYYY-MM-DD`。
- `loadHistory({ limit } = {})`：`invoke("git.log")` → `renderHistory()`；失败只 `toast`，不清空已显示内容。
- `renderHistory()`：按 `state.history.commits` 生成 `<li class="commit">`：
  - 行：`<span class="csha">短哈希</span><span class="csub">说明</span><span class="cmeta">作者 · 相对时间</span>`，`role="button" tabindex="0"`，`aria-expanded`
  - `expanded === sha` 时在行下方渲染 `<div class="commit-detail">`：
    - `<dl class="props">` 属性表：`提交 / 作者 / 作者时间 / 提交时间 / 父提交 / 说明`（完整 sha 与父提交用 `.mono`，长文本 `word-break`）
    - 文件区：`加载中…` → 调 `git.commitFiles` 后渲染 `.commit-file` 行（状态字母 + 文件名 + 目录），点击调 `openCommitDiff(sha, path)`
- `openCommitDiff(sha, path)`：复用 `openSheet({ mode: "diff" })`，标题 `path`，副标题 `cookie: 7 位 sha · 提交差异`，调 `git.commitDiff` 后用 `patchHtml`，错误走现有 `errorText`。
- 交互绑定：`#commits` 上事件委托（点击/Enter/Space 切换展开；同一时间只展开一条）；`#historyToggle` 折叠；`#historyMore` 把 `limit` +30 重新拉取。
- 刷新时机：`init()`、`refreshBtn`、`workspace:changed`、`view:open`、`commit` / `pull` / `push` 成功后调用 `loadHistory()`；6 秒 `pollState` **不** 触发历史刷新。
- 渲染隔离：历史渲染不进入 `applyState` 的 `signature` 逻辑，避免暂存操作重绘历史。

## 样式：`renderer/panel.css`

新增 `.history` 区块：`flex: none; border-top: 1px solid var(--border-soft); max-height: 45%; display:flex; flex-direction:column;`，`.history-body { overflow-y:auto; min-height:0 }`。

- `.history-head` 复用 `.group-head` 的视觉（sticky、30px 高、折叠箭头旋转用现有 `.collapse[data-collapsed]`）
- `.commit` 行高 26px，hover `var(--surface-hover)`；`.csha` 用 `var(--mono)` + `var(--muted)`；`.csub` 省略号；`.cmeta` 右对齐、`var(--muted-dim)`、`font-size:11px`
- `.commit-detail` 背景 `var(--surface)`，`border-left: 2px solid var(--accent)`
- `.props` 两列 grid（`grid-template-columns: 64px 1fr`，`dt` 为 `var(--muted-dim)`），长值 `word-break: break-all`
- `.commit-file` 复用 `.file` 的间距与 `.fstat stat-X` 状态配色
- 深/浅色都由现有变量驱动，不新增硬编码颜色

## 文档与版本

- `manifest.json`：`version` 0.1.1 → **0.2.0**；`description` 中英文补一句「查看最近提交历史与单个提交的改动」。
- `README.md`：功能表新增一行「提交历史」；面板通道路径表新增 `git.log` / `git.commitFiles` / `git.commitDiff`；安全设计补一条「sha 按 `[0-9a-f]{7,40}` 校验，提交 diff 的文件路径仍走仓库相对路径校验」。
- `dist/` 已 gitignore，不重新打包。

## 验证

1. `node --check git-workbench/git.js main.js renderer/panel.js`（语法）。
2. 在 `$PI_SCRATCH_DIR` 写一个临时脚本 `require` `git-workbench/git.js`，对本仓库跑：
   - `log(root, 5)` → 记录字段齐全（sha/短哈希/作者/ISO 时间/父提交/正文）
   - `commitFiles(root, <HEAD sha>)` → 文件与 `git show --name-status` 手输结果一致
   - `commitDiff(root, <HEAD sha>, "git-workbench/git.js")` → patch 非空且以 `diff --git` 开头
   - 空仓库（`mktemp -d && git init`）上 `log` 返回 `[]` 而不是抛错
3. UI 冒烟：在 `$PI_SCRATCH_DIR` 建一个 mock 页面，注入假的 `window.pluginBridge`（`invoke("git.state"|"git.log"|"git.commitFiles"|"git.commitDiff")` 返回固定夹具），引用 `git-workbench/renderer/{index.html,panel.css,panel.js}` 的副本，用 BrowserPreview 打开，确认：历史区高度不挤压文件列表、折叠/展开、属性表两列对齐、点文件弹出 diff sheet、深/浅主题都清晰。
4. 回归：暂存、提交、拉取、推送后历史立即刷新；`⌘/Ctrl+Enter` 提交、diff sheet、Esc 关闭等既有交互不受影响。

## 不在本次范围

提交历史的筛选/搜索、右键菜单（reset/revert/cherry-pick）、图形化分支持线、以及从历史里 checkouts。
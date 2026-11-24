# Git Workbench

PI-Desktop 工作面板里的 Git 客户端：看改动、暂存/放弃、写或生成提交信息、提交、拉取、推送，都在右侧面板完成；面板底部还有可折叠的提交历史，点开任一条即可看到它的属性、改动文件与差异。

参考 VS Code 源代码管理面板的布局：提交信息输入框、跟随主题的主提交按钮（带下拉菜单）、按「已暂存 / 更改」分组的文件列表与状态字母。

## 功能

| 区域 | 能力 |
| --- | --- |
| 顶栏 | 当前分支、仓库名、`↑ahead ↓behind`，右侧依次是拉取、推送、刷新三个图标按钮 |
| 提交框 | 提交信息（`⌘/Ctrl + Enter` 提交，随内容自动增高到 8 行）、右上角 AI 按钮用当前模型流式生成提交信息、提交下拉菜单（仅暂存 / 全部更改 / 提交后推送 / `--signoff`） |
| 文件列表 | 「已暂存」与「更改」两组；分组标题右侧常驻图标（全部暂存 / 全部放弃 / 全部取消暂存，无文件时置灰不可点）；文件类型徽标、文件名 + 目录、状态字母（M/A/D/R/U）；行内悬停出现暂存、取消暂存、放弃更改 |
| 差异 | 点击文件在原地左右分栏：左侧保留面板内容，右侧显示该文件 diff（新增/删除/上下文/块头着色 + `+N −M` 统计），未跟踪文件同样可看；中间分隔条可拖拽调整宽度，双击恢复一半，聚焦后方向键微调、`Esc` 或 ✕ 关闭 |
| 提交历史 | 文件列表下方的可折叠区域：短哈希 + 说明 + 作者 · 相对时间；展开某条即在下方显示属性表（完整哈希、作者、作者时间、提交时间、父提交、说明正文）和该提交的改动文件，点文件看这份提交里的 diff；滚动到列表底部自动加载下一批（每次 30 条，最多 200 条），加载中底部固定显示「正在加载更多提交…」，也可用「⋯」手动加载，失败后点「⋯」重试 |
| 底部状态栏 | 暂存/未暂存计数、最近一次提交 |

提交语义：提交按钮只提交**已暂存**的改动；若没有任何已暂存改动则自动 `git add -A` 后再提交（与 VS Code 一致）。下拉菜单可强制指定。

## 主题适配

面板是独立文档，宿主**不会**把 `--ds-*` 设计令牌注入进来（只有 `--pi-plugin-titlebar-height` 与页面 locale/theme 启动参数），所以颜色由面板自己声明、自己跟随主题：

- `pluginBridge.invoke("app.getAppearance")` 返回 `{ theme, base, locale, pluginTheme }`：`base` 是 `light`/`dark`（面板据此切 `:root[data-base]` 调色板），`pluginTheme` 在使用插件主题时带 `{ id, base, css }`，`css` 就是该主题的 CSS 文本。
- `appearance:changed` 事件在切换主题/系统外观时推送新的 appearance，面板实时重算。
- `pluginTheme.css` 里的 `--ds-*` 会按族映射进面板变量：`bg-primary/secondary/tertiary/inset` → `--bg/--bg-soft/--surface/--field`，`text-primary/muted/faint` → `--fg/--muted/--muted-dim`，`border-default/subtle` → `--border/--border-soft`，`success/error/warning` → `--add/--del/--mod`（`--add-bg/--del-bg` 由 `color-mix` 从状态色派生）。映射表见 `panel.js` 的 `THEME_TOKENS`。
- `--accent` 有守卫：宿主的「accent」在 dark 是纯白、light 是墨黑，会让高亮变成中性色，所以只有带色相的 accent 才覆盖，否则保留面板内置的蓝（dark `#4a9eff` / light `#0a66c2`）。缺失的令牌一律 `removeProperty` 回落 `:root` 字面值；含 `var(` 的值跳过（跨文档无法解析）。
- 主按钮不写死颜色：`--commit / --commit-hover / --commit-fg` 映射到 `--theme-primary*`，默认取宿主主操作语义（dark 白底深字、light 深底白字），插件主题的 `--ds-text-primary` / `--ds-bg-primary` 在场时随之变化。
- `themes.list` 可枚举已注册的插件主题；`themes.*` 与 `ui.theme` 权限用于主题本身，本插件不申请。
- 调色板默认值就是宿主暗/浅主题的真实取值（`--bg #181818` / `--bg-soft #212121` / `--field #0d0d0d` / `--border rgba(255,255,255,.08)`；浅色 `#fff` / `#f9f9f9` / `--border rgba(26,28,31,.12)`），所以不装插件主题时和客户端一致。整行贴边、0 圆角；圆角只留给控件（`--radius-sm`(8) / `--radius`(11) / `--radius-pill`，`--radius-lg`(16) 仅确认对话框）。

## 多语言

插件不自己保存语言，而是用宿主的语言设置：面板通过 `pluginBridge.invoke("app.getAppearance")` 拿到 `locale`（主进程侧对应 `pi.app.getLocale()` / 会话的 `locale`），并用 `appearance:changed` 事件跟随用户切换。

- 判定规则：`locale` 以 `zh` 开头 → 中文；其余（`en-US`、`ja-JP`、`fr` …）→ 英文。所以非中文用户看到的是英文，而不是中英混排。
- 文案集中在 `renderer/panel.js` 的 `STRINGS`（`zh` / `en` 两份，键同名，`{0}`/`{1}` 为占位符），取用一律走 `t("key", ...)`；静态标记用 `data-i18n` / `data-i18n-title` / `data-i18n-aria` / `data-i18n-placeholder` 挂接，`applyStaticStrings()` 在启动和语言变化时统一刷新。
- 语言变化时 `setLanguage()` 会重绘顶栏、文件列表与提交历史；相对时间由 `Intl.RelativeTimeFormat` 按 `zh-CN` / `en` 生成，不再写死。
- 主进程侧同样的文案放在 `main.js` 的 `TEXT`（`en` / `"zh-CN"`），错误码 → 文案的映射在面板的 `err.*` 键，命令名用 `title(en, zh)`。
- 新增文案时请同时补 `zh` 与 `en`，并跑 `node` 自检脚本确认没有缺键（`/^err\\.[A-Z]/` 的键由运行时错误码拼接）。

## 权限

| 权限 | 用途 |
| --- | --- |
| `ui.view` | 工作面板视图与其命令 |
| `models.list` | 选择用户的模型（默认模型优先） |
| `agent.complete` | 一次性补全，生成提交信息 |

生成提交信息只发送**本次要提交的 diff、变更文件列表、diffstat 与最近 8 条提交标题**，不读取对话历史、不读取凭据。

## 面板通道（`onPanelInvoke`）

| 通道 | 说明 |
| --- | --- |
| `git.state` | 仓库、分支、ahead/behind、两组文件、计数、最近提交 |
| `git.diff` | `{ path, staged }` → 该文件的 unified diff（未跟踪文件用 `git diff --no-index`） |
| `git.log` | `{ limit? }` → 最近提交（1–200 条，默认 30）：完整/短哈希、说明、正文（截断 2000 字）、作者与提交时间、父提交 |
| `git.commitFiles` | `{ sha }` → 该提交的改动文件与状态字母（含重命名原路径） |
| `git.commitDiff` | `{ sha, path }` → 该提交中这个文件的 diff |
| `git.stage` / `git.unstage` | `{ paths }` |
| `git.stageAll` / `git.unstageAll` | 全部暂存 / 全部取消暂存 |
| `git.discard` | `{ paths }`：已跟踪文件 `git restore`，未跟踪或新加文件 `git clean` |
| `git.commit` | `{ message, stageAll?, push?, signOff?, amend? }`，信息经 stdin 传给 `git commit -F -` |
| `git.pull` | `git pull --no-rebase --no-edit` |
| `git.push` | 有上游直接 `git push`，否则 `git push -u <remote> <branch>` |
| `git.generateMessage` | 用默认模型生成提交信息 |

## 安全设计

- 所有 git 调用都是 `spawn("git", ["-c", "core.quotePath=false", "-C", root, ...args])` 的**参数数组**，从不拼接 shell 字符串；`core.quotePath=false` 保证中文等非 ASCII 路径按 UTF-8 输出，解析时再把 git 加的双引号/C 转义还原成真实文件名。
- 路径必须是仓库相对路径（拒绝绝对路径与 `..`），分支名按 git 引用规则校验。
- 仓库根始终由当前工作区经 `git rev-parse --show-toplevel` 解析，插件不会对用户未打开的目录执行 git。
- 设置 `GIT_TERMINAL_PROMPT=0`、`GIT_EDITOR=true`、`GIT_MERGE_AUTOEDIT=no`，避免插件进程卡在凭据输入或编辑器上。
- 放弃更改是不可撤销操作，面板内先弹确认，且冲突文件不提供放弃入口。
- 提交历史只读：`git log` / `git show` 不接受任何写操作；提交 ID 按 `[0-9a-f]{7,40}` 校验，查看某提交里的文件 diff 时路径仍走仓库相对路径校验。

## 本地开发

插件目录即源码，可直接在 PI-Desktop「插件 → 加载开发插件」中选中本目录，保存后热重载。

```
manifest.json          # 身份、视图/命令贡献、权限
main.js                # 生命周期、onPanelInvoke 通道、LLM 提交信息
git.js                 # git 执行层与 porcelain 解析器
renderer/index.html    # 视图页面
renderer/panel.css     # 主题变量与布局
renderer/panel.js      # 交互逻辑
```

扩大 `permissions` 后热重载会停止，需要在插件行「更多 → 重新加载」里确认新权限。

## 打包

用 PI-Desktop 的 `PluginPack` 生成 `dist/local.git-workbench-<version>.piplug`（store-only 压缩包，安装器只接受这种格式）。

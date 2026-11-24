# Git Workbench

PI-Desktop 工作面板里的 Git 客户端：看改动、暂存/放弃、写或生成提交信息、提交、拉取、推送，都在右侧面板完成。

参考 VS Code 源代码管理面板的布局：提交信息输入框、跟随主题的主提交按钮（带下拉菜单）、按「已暂存 / 更改」分组的文件列表与状态字母。

## 功能

| 区域 | 能力 |
| --- | --- |
| 顶栏 | 当前分支、仓库名、`↑ahead ↓behind`、拉取、推送、刷新 |
| 提交框 | 提交信息（`⌘/Ctrl + Enter` 提交）、✨ 用当前模型生成提交信息、提交下拉菜单（仅暂存 / 全部更改 / 提交后推送 / `--signoff`） |
| 文件列表 | 「已暂存」与「更改」两组；文件类型徽标、文件名 + 目录、状态字母（M/A/D/R/U）；悬停出现暂存、取消暂存、放弃更改 |
| 差异 | 点击文件打开整页 diff（新增/删除/上下文/块头着色），未跟踪文件同样可看 |
| 底部状态栏 | 暂存/未暂存计数、最近一次提交 |

提交语义：提交按钮只提交**已暂存**的改动；若没有任何已暂存改动则自动 `git add -A` 后再提交（与 VS Code 一致）。下拉菜单可强制指定。

## 主题适配

面板是独立文档，宿主**不会**把 `--ds-*` 设计令牌注入进来（只有 `--pi-plugin-titlebar-height` 与页面 locale/theme 启动参数），所以颜色由面板自己声明、自己跟随主题：

- `pluginBridge.invoke("app.getAppearance")` 返回 `{ theme, base, locale, pluginTheme }`：`base` 是 `light`/`dark`（面板据此切 `:root[data-base]` 调色板），`pluginTheme` 在使用插件主题时带 `{ id, base, css }`，`css` 就是该主题的 CSS 文本。
- `appearance:changed` 事件在切换主题/系统外观时推送新的 appearance，面板实时重算。
- 主按钮不写死颜色：`--commit / --commit-hover / --commit-fg` 映射到 `--theme-primary*`，默认取宿主主操作语义（dark 白底深字、light 深底白字）。若 `pluginTheme.css` 里能解析出 `--ds-text-primary` / `--ds-accent` / `--ds-bg-primary` 的字面色值，就填进 `--theme-primary*`，按钮随插件主题一起变。
- `themes.list` 可枚举已注册的插件主题；`themes.*` 与 `ui.theme` 权限用于主题本身，本插件不申请。

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
| `git.stage` / `git.unstage` | `{ paths }` |
| `git.stageAll` / `git.unstageAll` | 全部暂存 / 全部取消暂存 |
| `git.discard` | `{ paths }`：已跟踪文件 `git restore`，未跟踪或新加文件 `git clean` |
| `git.commit` | `{ message, stageAll?, push?, signOff?, amend? }`，信息经 stdin 传给 `git commit -F -` |
| `git.pull` | `git pull --no-rebase --no-edit` |
| `git.push` | 有上游直接 `git push`，否则 `git push -u <remote> <branch>` |
| `git.generateMessage` | 用默认模型生成提交信息 |

## 安全设计

- 所有 git 调用都是 `spawn("git", ["-C", root, ...args])` 的**参数数组**，从不拼接 shell 字符串。
- 路径必须是仓库相对路径（拒绝绝对路径与 `..`），分支名按 git 引用规则校验。
- 仓库根始终由当前工作区经 `git rev-parse --show-toplevel` 解析，插件不会对用户未打开的目录执行 git。
- 设置 `GIT_TERMINAL_PROMPT=0`、`GIT_EDITOR=true`、`GIT_MERGE_AUTOEDIT=no`，避免插件进程卡在凭据输入或编辑器上。
- 放弃更改是不可撤销操作，面板内先弹确认，且冲突文件不提供放弃入口。

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

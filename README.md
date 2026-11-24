# PI-Desktop 插件仓库

PI-Desktop 插件的源码集合，一个子目录一个插件，各自独立可加载、可打包、可发布到[插件中心](https://plugins.aiuo.net)。

## 插件

| 目录 | 插件 ID | 版本 | 说明 | 市场 |
| --- | --- | --- | --- | --- |
| [`git-workbench/`](git-workbench/README.md) | `local.git-workbench` | 0.1.0 | 右侧工作面板里的 Git 客户端：改动文件、暂存/放弃、AI 生成提交信息、提交、拉取、推送，可折叠提交历史与分栏 diff，跟随宿主主题、中英双语 | [plugins.aiuo.net/plugins/local.git-workbench](https://plugins.aiuo.net/plugins/local.git-workbench) |

新插件直接在本目录下新建子目录，不要让两个插件共用一份 `manifest.json` 或 `main.js`——宿主按目录加载插件，共享代码只能通过复制或独立的 npm 包解决。

## 目录结构

```
pi-desktop-plugin/
├── README.md                 # 本文件：仓库级说明
├── .gitignore                # 通用忽略规则（含各插件的 dist/ 与 .pi/）
└── <plugin-dir>/             # 单个插件，根目录必须有 manifest.json
    ├── manifest.json         # 身份、贡献点、权限、i18n、engines
    ├── main.js               # 插件入口（Node 进程）
    ├── <helper>.js           # 可选的内部模块
    ├── renderer/             # 面板/视图页面（HTML + CSS + JS）
    ├── README.md             # 插件级说明（命令/设置/工具/权限/外部服务）
    ├── CHANGELOG.md          # 变更日志，与 manifest.version 同步
    ├── LICENSE               # 许可证
    └── dist/                 # 打包产物，已忽略
```

## 单个插件的规范

每个插件按 [插件开发文档 §10 准备发布](https://docs.aiuo.net/zh-CN/plugin-development#%E5%87%86%E5%A4%87%E5%8F%91%E5%B8%83) 落地：

- **ID**：稳定不变，公开发布建议用反向域（`io.github.<user>.<name>`），本地/私有插件可用 `local.<name>`；
- **版本**：严格 semver（`0.1.0`，不能写 `0.1`），与 `CHANGELOG.md` 最新条目一致；
- **engines.piDesktop**：写成实际支持的最低客户端版本，不要凭空抬高；
- **README**：逐个记录命令、设置项、工具入参、权限与外部服务，说明数据流向；
- **产物**：所有 JS/资源都在插件目录内，不依赖构建产物缺失；
- **`dist/` 与 `*.piplug` 不入库**，需要时重新打包。

## 开发与验证

1. 应用内「插件 → 加载开发插件」选中某个插件目录，保存即热重载（改 `permissions` / `manifest.fs` 需在插件行「更多 → 重新加载」重新授权）。
2. 用宿主工具链检查与打包，不要用 `zip`/`tar` 手打（安装器只接受 store-only 归档）：

   ```
   PluginCheck → 校验 manifest、引用文件、权限、路径越界、包大小，必须 0 error
   PluginPack  → 生成 <plugin-dir>/dist/<id>-<version>.piplug 并输出 SHA-256
   ```

3. 用干净的应用状态安装生成的包，依次验证启用、禁用、卸载。

## 发布

发布走插件中心（也可用 `pi-plugin publish` 生成 `submission.json` 走 MCP）：

1. 把仓库推到 GitHub（插件可位于子目录），并给发布版本打 tag，例如 `git tag -a v0.1.0 -m "..." && git push origin v0.1.0`；
2. 插件中心 → 创建插件：绑定已授权的源码仓库、上传 `.piplug`、填名称/描述/源码 tag/更新说明；
3. 平台重新解析源码、审计包并记录 SHA-256，审核通过后上架；
4. 后续版本在「发布新版本」里提交，版本号必须递增且不能复用。

`.pi/` 是本地规划与临时笔记目录，已加入 `.gitignore`，不随仓库分发。

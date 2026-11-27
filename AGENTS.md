# PI-Desktop 插件开发规范

本仓库放 PI-Desktop 插件（每个子目录一个插件）。所有插件页面（面板 / 嵌入视图 / widget）都必须
**跟随宿主主题**、**跟随宿主语言**、**复用宿主控件样式**。以下规则来自对宿主 v0.23.0 包体
（`/Applications/PI-Desktop.app/Contents/Resources/app.asar`，`out/main`、`out/preload/plugin-panel.js`、
`out/renderer/assets/index-*.css`）的实际核对，不要凭印象改。

---

## 1. 主题（Theme）

### 1.1 唯一正确的信号来源

宿主给插件暴露了官方的外观 API，页面侧直接调用即可：

```js
const applyAppearance = (appearance) => {
  const base =
    appearance?.base === "light" || appearance?.base === "dark"
      ? appearance.base
      : window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  document.documentElement.dataset.theme = base;      // 切 token 集
  if (appearance?.locale) document.documentElement.lang = appearance.locale;
};

window.pluginBridge?.on("appearance:changed", applyAppearance);          // 宿主改主题/语言时推送
window.pluginBridge?.invoke("app.getAppearance")                          // 首次取值
  .then(applyAppearance)
  .catch(() => applyAppearance(null));                                    // 兜底走 matchMedia
```

`app.getAppearance()` 返回 `{ theme, base, locale, pluginTheme }`，`base` 是 `"light" | "dark"`。
`appearance:changed` 会在主题切换、系统外观变化、界面语言变化时推送。**这两条就是全部依据。**

### 1.2 不要使用的信号（已确认无效）

| 信号 | 为什么不能用 |
| --- | --- |
| CSS 变量 `--pi-plugin-panel-theme` | **不存在**。主题来自 preload 的 `process.argv`（`--pi-plugin-panel-theme=light\|dark`），从未写成 CSS 变量。读它永远得到空串，是最常见的「明明浅色却渲染成暗色」根因。 |
| `pi-plugin-panel-chrome[data-theme]` | 该元素只在 `widget` 和独立 `panel` 模式下创建；**嵌入视图（work-panel 标签页）没有 chrome 元素**，`maintainPanelChrome()` 在嵌入分支直接 return。 |
| `--pi-plugin-panel-page-background/foreground` | 同样只 set 在 chrome 元素上，嵌入视图取不到。 |
| 只读一次 `matchMedia` | 用户可能在插件打开期间切主题；只读一次会一直停在旧值。切换请靠 `appearance:changed`。 |
| 写死「默认暗色」 | 未知时必须退回 `matchMedia("(prefers-color-scheme: light)")`，而不是假定 dark。宿主会把 `nativeTheme.themeSource` 同步成应用设置，因此 `matchMedia` 与宿主一致。 |

### 1.3 页面渲染规则

- 用 `document.documentElement.dataset.theme = "light" | "dark"` 选 token 集，CSS 只写
  `:root[data-theme=light]` / `:root[data-theme=dark]`（宿主自己的写法，见 `--ds-*` token 集）。
- **页面必须自己画背景**：宿主把插件页 `html/body` 强制设为透明（widget 与嵌入视图都是），
  所以根容器要 `background: var(--ds-bg-primary)`、`color: var(--ds-text-primary)`，
  并补 `Canvas` / `CanvasText` 兜底，避免脚本失败时白底白字。
- 焦点环用宿主写法：`box-shadow: 0 0 0 2px color-mix(in oklab, var(--ds-accent) 30%, transparent)` +
  `outline: none`。
- canvas / WebGL 类组件（xterm.js 等）不读 CSS，必须用 `getComputedStyle(document.documentElement)
  .getPropertyValue("--ds-bg-inset")` 之类**把 token 值显式传进去**，并在主题变化时重设。

### 1.4 控件样式：vendored，不许自创

插件页是独立 webContents，宿主的 CSS 与 CSS 变量**不会**流进来（主进程 `insertCSS` 命中 0 次）。
因此把宿主设计系统**原样拷贝**进插件：

- `renderer/host-tokens.css`：`--gray-*` 灰阶、`--ds-*` 语义色（dark + light 两套）、`--text-*` 字号阶、
  `--radius-*`、`--motion-*`、`--font-sans/--font-mono`、`--ds-control-size`。
- `renderer/host-controls.css`：宿主 `.btn` / `.btn-primary` / `.btn-secondary` / `.btn-ghost` /
  `.icon-btn` / `.icon-btn-square` 的**逐字复刻**，外加最小 preflight。宿主没有 danger 变体，
  需要时只在 `.btn` 基础上覆写颜色 `color: var(--ds-error)`，其余（圆角/内边距/字号/active 缩放）不动。
- 插件自己的 `*.css` 只放**布局**（间距、网格、flex、显隐），不写字号/圆角/颜色字面量。

新增控件时的顺序：先用宿主已有类 → 用宿主 token 组合 → 最后才考虑新写规则，且必须只用 `--ds-*` /
`--gray-*` token，禁止 `#fff`、`#1a1c1f` 这类硬编码颜色（xterm 主题除外，那是取值传参）。
图标用 16px 视觉盒、`stroke="currentColor"` 的内联 SVG，颜色随 `currentColor` 继承，不要给固定 `fill`。

---

## 2. 语言（Language）

### 2.1 语言来源与判定

```js
const locale = appearance?.locale || navigator.language || "en";
const lang = locale.replaceAll("_", "-").toLowerCase().startsWith("zh") ? "zh" : "en";
```

- `appearance.locale` 来自 `app.getAppearance()` / `appearance:changed`，是宿主应用的界面语言，
  **优先于** `navigator.language`（后者跟系统，不跟应用设置）。
- 主题与语言共用同一次 `applyAppearance` 调用，不要各写一套。
- 规则只有两条：**`zh*` → 中文；其余一律英文**。不要为「非中非英」单独加分支，也不要跟着系统语言跑。
- 同时设置 `document.documentElement.lang = locale`（`<html>` 的静态默认值写 `lang="en"`）。

### 2.2 文案组织

- 单个 `STRINGS = { en: {...}, zh: {...} }` 字典，`en` 必须**完整**（它是回退），`zh` 只放中文。
- 静态节点用 `data-i18n="key"`，HTML 里写英文原文作为无脚本兜底；启动时和语言变化时统一刷新：

  ```js
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const value = t[node.dataset.i18n];
    if (typeof value === "string") node.textContent = value;
  }
  ```

- 只在运行时存在的文案（行内状态、tooltip、`placeholder`、`confirm`、错误前缀）也从同一字典取，
  不要留裸英文/裸中文；`title` / `aria-label` 同样要刷新。
- 命令文本、路径、端口、退出码**永不本地化**。
- 切换语言后要重渲染动态列表（状态文案、按钮 title），而不是只改静态节点。
- 新增语言 = 加一个字典 + 一行判定；其它一律归 `en`。

---

## 3. 数据存储（Storage）

数据一律走宿主给插件的那条路，不自己找地方放：

```js
const dataDir = await pi.plugin.getDataPath();   // 插件私有目录，宿主创建
// ~/.pi-desktop/plugins/data/<pluginId>/…
```

- **插件数据放这里**：`launches.json`、运行提示等可增长的数据，用 `node:fs` 原子写
  （写 `.tmp` → `rename`），坏文件改名留档（`*.broken-<ts>`）而不是静默丢弃。
- **用户可见的偏好**用 `pi.plugin.getSettings()` / `pi.plugin.setSettings()`，并在
  `contributes.settings` 里声明；这类值出现在宿主的设置界面，别当成数据库用。
- **禁止**：`localStorage` / `sessionStorage` / `IndexedDB` / cookie（插件页是独立
  webContents，这些数据既不受宿主管理，也会在重载/清理时丢失）、把配置写进工作区
  （`.vscode/`、`tasks.json`、隐藏文件都不行）、读取 VSCode 的 `launch.json`。
- 存的数据要带 `version` 字段；结构变化时写迁移，旧文件先备份再改写。
- 跨项目的数据要**按键隔离**：本项目只看本项目（`<workspace realpath>` 作键），不给
  用户「全局 / 本项目」开关，除非产品需求明确要求。

## 4. 提交前自检


1. 宿主切浅色：插件页各项（背景、文字、按钮、输入框、边框、状态点）都是浅色；切回深色立刻跟随，
   且不用刷新页面。
2. 宿主切语言：所有可见文案（含 tooltip、占位符、确认框）在中文/英文之间完整切换，无混排残留。
3. 把系统语言设为德/日等：插件显示**英文**，不是中文也不是原语言。
4. 颜色/字号/圆角/内边距全部来自宿主 token 或宿主类名，CSS 里 `grep -nE "#[0-9a-fA-F]{3,8}" renderer/*.css`
   只剩 xterm 相关取值。
5. `node --check` 过 JS，CSS 花括号配平，`PluginCheck` 无 error。
6. 数据只写在 `pi.plugin.getDataPath()` 下（或 `getSettings`），仓库/工作区里
   `grep -rn "localStorage\|sessionStorage\|indexedDB"` 必须为空。

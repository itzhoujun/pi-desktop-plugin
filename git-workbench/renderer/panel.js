/*
 * Wrapped in an IIFE: the view page runs this as a classic script, so
 * top-level declarations would otherwise share the global lexical scope with
 * any other script the host or another plugin injects.
 */
(function () {
"use strict";

/**
 * Git Workbench — work-panel view.
 *
 * The page has no Node access: every action is one of this plugin's own
 * onPanelInvoke channels (git.state / git.stage / git.commit / …), so payloads
 * are validated in the plugin process, not here.
 */

const $ = (id) => document.getElementById(id);

const els = {
  shell: $("shell"),
  branchName: $("branchName"),
  repoName: $("repoName"),
  syncCount: $("syncCount"),
  refreshBtn: $("refreshBtn"),
  pullBtn: $("pullBtn"),
  pushBtn: $("pushBtn"),
  message: $("message"),
  genBtn: $("genBtn"),
  commitBtn: $("commitBtn"),
  commitLabel: $("commitLabel"),
  commitMenuBtn: $("commitMenuBtn"),
  commitMenu: $("commitMenu"),
  optPush: $("optPush"),
  optSignoff: $("optSignoff"),
  banner: $("banner"),
  lists: $("lists"),
  statusRepo: $("statusRepo"),
  statusLast: $("statusLast"),
  history: $("history"),
  historyHead: $("historyHead"),
  historyToggle: $("historyToggle"),
  historyCount: $("historyCount"),
  historyMore: $("historyMore"),
  historyBody: $("historyBody"),
  commits: $("commits"),
  historyEmpty: $("historyEmpty"),
  overlay: $("overlay"),
  sheetTitle: $("sheetTitle"),
  sheetSub: $("sheetSub"),
  sheetBody: $("sheetBody"),
  sheetFoot: $("sheetFoot"),
  sheetBack: $("sheetBack"),
  sheetClose: $("sheetClose"),
  toasts: $("toasts"),
  split: $("split"),
  splitter: $("splitter"),
  diffPane: $("diffPane"),
  diffTitle: $("diffTitle"),
  diffSub: $("diffSub"),
  diffStat: $("diffStat"),
  diffBody: $("diffBody"),
  diffClose: $("diffClose"),
};

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl+";

/* The panel asks for one page at a time and caps growth like git.log does. */
const HISTORY_PAGE = 30;
const HISTORY_MAX = 200;

/* The composer grows up to this many lines, then scrolls. */
const MESSAGE_MAX_ROWS = 8;
let messageStream = null;

/* Split pane: the diff keeps at least DIFF_MIN, the work panel keeps MAIN_MIN. */
const DIFF_MIN = 200;
const MAIN_MIN = 200;
const DIFF_STEP = 24;

const state = {
  data: null,
  signature: "",
  busy: null,
  collapsed: { staged: false, changes: false },
  sheet: { mode: null, resolve: null },
  pollTimer: null,
  history: {
    repoRoot: null,
    commits: [],
    limit: HISTORY_PAGE,
    truncated: false,
    expanded: null,
    files: new Map(),
    loading: false,
    loaded: false,
    collapsed: false,
    error: "",
  },

  /* The right-hand diff pane: the target it shows, plus a load token so a slow
   * response for an older target can never overwrite a newer one. */
  diff: {
    open: false,
    path: "",
    staged: false,
    sha: null,
    token: 0,
    width: 0,
  },
};

const CHEVRON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" class="ico"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DISCARD =
  '<svg viewBox="0 0 16 16" aria-hidden="true" class="ico"><path d="M6.5 3.3 3.9 5.9l2.6 2.6M3.9 5.9h5.4a3.2 3.2 0 0 1 0 6.4H5.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const FILE_TYPES = {
  ts: ["TS", "#3b82c4"],
  tsx: ["TS", "#3b82c4"],
  mts: ["TS", "#3b82c4"],
  cts: ["TS", "#3b82c4"],
  js: ["JS", "#d6b23a"],
  jsx: ["JS", "#d6b23a"],
  mjs: ["JS", "#d6b23a"],
  cjs: ["JS", "#d6b23a"],
  json: ["{ }", "#b5b53f"],
  css: ["CSS", "#7b5ea7"],
  scss: ["SCSS", "#c6538c"],
  less: ["LESS", "#5b83b5"],
  html: ["<>", "#c9603a"],
  vue: ["VUE", "#41b883"],
  svelte: ["SV", "#ff3e00"],
  md: ["MD", "#5c9dc4"],
  mdx: ["MDX", "#5c9dc4"],
  py: ["PY", "#3f6ea8"],
  go: ["GO", "#3aa7c4"],
  rs: ["RS", "#b9734c"],
  java: ["JV", "#9b5b3f"],
  kt: ["KT", "#8a6fc4"],
  rb: ["RB", "#a3443c"],
  php: ["PHP", "#5b62a0"],
  c: ["C", "#5c7c9d"],
  h: ["H", "#5c7c9d"],
  cpp: ["C++", "#5c7c9d"],
  cs: ["C#", "#4b8a4b"],
  swift: ["SW", "#d2763a"],
  sh: ["SH", "#6fae52"],
  zsh: ["SH", "#6fae52"],
  bash: ["SH", "#6fae52"],
  yml: ["YML", "#a44b4b"],
  yaml: ["YML", "#a44b4b"],
  toml: ["TML", "#94603c"],
  ini: ["INI", "#7a7a7a"],
  sql: ["SQL", "#b0873a"],
  lock: ["LCK", "#777777"],
  svg: ["SVG", "#c99a3a"],
  png: ["IMG", "#7c5cc4"],
  jpg: ["IMG", "#7c5cc4"],
  jpeg: ["IMG", "#7c5cc4"],
  gif: ["IMG", "#7c5cc4"],
  webp: ["IMG", "#7c5cc4"],
  ico: ["ICO", "#7c5cc4"],
  txt: ["TXT", "#7a7a7a"],
};

const ERRORS = {
  NO_WORKSPACE: "请先打开一个项目文件夹。",
  NOT_A_REPO: "当前文件夹不是 git 仓库。",
  NOTHING_TO_COMMIT: "没有可提交的改动。",
  NO_MODEL: "请先在「设置 → 模型」中配置一个模型。",
  EMPTY_COMPLETION: "模型没有返回内容，请重试。",
  PROVIDER_UNAUTHORIZED: "模型未授权，请检查该服务在设置中的密钥。",
  PROVIDER_RATE_LIMITED: "模型服务限流，请稍后重试。",
  RATE_LIMITED: "操作太频繁，请稍后重试。",
  TIMEOUT: "操作超时，请稍后重试。",
  GIT_MISSING: "找不到 git，请确认已安装并已加入 PATH。",
  NO_REMOTE: "仓库没有配置远端。",
  DETACHED_HEAD: "当前处于游离 HEAD 状态，请先切换分支。",
  PERMISSION_DENIED: "权限不足：请在插件页面授予所需权限后重新加载。",
  INVALID_ARGUMENT: "参数不合法。",
};

// --------------------------------------------------------------------- utils

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function bridge() {
  const api = window.pluginBridge;
  if (!api || typeof api.invoke !== "function") {
    throw Object.assign(new Error("pluginBridge 不可用：请在 PI-Desktop 面板中打开此页面。"), {
      code: "NO_BRIDGE",
    });
  }
  return api;
}

function invoke(channel, payload) {
  return bridge().invoke(channel, payload || {});
}

function errorText(error) {
  const raw = String(error?.message || error || "");
  const code =
    error?.errorCode ||
    error?.code ||
    (raw.match(/^([A-Z][A-Z0-9_]{2,}):/) || [])[1] ||
    "";
  if (ERRORS[code]) return ERRORS[code];
  const cleaned = raw.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, "").trim();
  return cleaned || "操作失败。";
}

function fileBadge(filePath) {
  const name = String(filePath).slice(String(filePath).lastIndexOf("/") + 1);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const entry = FILE_TYPES[ext];
  if (entry) return { label: entry[0], color: entry[1] };
  return { label: ext ? ext.slice(0, 2).toUpperCase() : "·", color: "#7a7a7a" };
}

function splitPath(filePath) {
  const index = filePath.lastIndexOf("/");
  if (index === -1) return { name: filePath, dir: "" };
  return { name: filePath.slice(index + 1), dir: filePath.slice(0, index) };
}

function firstLine(text, limit = 220) {
  const line = String(text || "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

// ------------------------------------------------------------------ history

/*
 * Commit history is a separate read-only view: it never takes part in
 * applyState()'s signature check, so staging files does not repaint it.
 */

const RELATIVE_TIME =
  typeof Intl !== "undefined" && typeof Intl.RelativeTimeFormat === "function"
    ? new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" })
    : null;

const TIME_UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

function parseTime(iso) {
  const time = Date.parse(iso || "");
  return Number.isFinite(time) ? time : null;
}

function absoluteTime(iso) {
  const time = parseTime(iso);
  if (time === null) return "";
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** "3 天前" style; falls back to the absolute date when Intl is unavailable. */
function relativeTime(iso) {
  const time = parseTime(iso);
  if (time === null) return "";
  const seconds = (time - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs < 45) return "刚刚";
  for (const [unit, size] of TIME_UNITS) {
    if (abs < size && unit !== "minute") continue;
    const value = Math.round(seconds / size);
    return RELATIVE_TIME ? RELATIVE_TIME.format(value, unit) : absoluteTime(iso);
  }
  return absoluteTime(iso);
}
function toast(text, kind = "info") {
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.kind = kind;
  node.textContent = text;
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, kind === "error" ? 6000 : 3200);
}

function showBanner(text, kind = "error") {
  if (!text) {
    els.banner.hidden = true;
    els.banner.textContent = "";
    return;
  }
  els.banner.hidden = false;
  els.banner.dataset.kind = kind;
  els.banner.textContent = text;
}

// ----------------------------------------------------------------- appearance

/*
 * A panel is its own document, so the host never hands us its `--ds-*` design
 * tokens. `app.getAppearance()` does return the active theme, and a plugin theme
 * carries that theme's CSS text, so the panel mirrors every palette family it
 * can: surfaces, borders, text and the semantic state colours. Whatever a theme
 * does not define keeps the `:root` literal in panel.css, which already tracks
 * the host's own palette.
 */

const THEME_TOKENS = {
  "--bg": ["bg-primary"],
  "--bg-soft": ["bg-secondary"],
  "--surface": ["bg-tertiary", "bg-secondary"],
  "--surface-hover": ["bg-hover", "tile-hover", "bg-elevated"],
  "--field": ["field-inset-bg", "bg-inset"],
  "--border": ["border-default"],
  "--border-soft": ["border-subtle"],
  "--fg": ["text-primary"],
  "--fg-strong": ["text-primary"],
  "--muted": ["text-muted", "text-secondary"],
  "--muted-dim": ["text-faint", "text-tertiary"],
  "--add": ["success"],
  "--del": ["error"],
  "--danger": ["error"],
  "--mod": ["warning"],
  "--conflict": ["warning"],
};

function themeTokensFromCss(css) {
  const tokens = new Map();
  if (typeof css !== "string" || !css) return tokens;
  for (const match of css.matchAll(/--ds-([a-z0-9-]+)\s*:\s*([^;{}]+)/gi)) {
    const value = match[2].trim();
    // `var(--gray-0)` chains would resolve to nothing in this document.
    if (value && !/var\(/i.test(value)) tokens.set(match[1].toLowerCase(), value);
  }
  return tokens;
}

const NEUTRAL_COLORS = new Set(["white", "black", "gray", "grey", "silver", "transparent"]);

/*
 * White / black / grey. The host's own accent is `#fff` in dark and ink
 * `#1a1c1f` in light, which would flatten our highlight into a neutral, so an
 * accent token only lands when it actually carries a hue.
 */
function isNeutralColor(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return true;
  if (NEUTRAL_COLORS.has(raw)) return true;
  let rgb = null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(raw);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((digit) => digit + digit).join("");
    }
    if (digits.length < 6) return false;
    rgb = [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16));
  } else {
    const fn = /^rgba?\(([^)]+)\)$/.exec(raw);
    if (!fn) return false;
    rgb = fn[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((part) => (part.endsWith("%") ? (parseFloat(part) * 255) / 100 : parseFloat(part)));
    if (rgb.length !== 3 || rgb.some((channel) => !Number.isFinite(channel))) return false;
  }
  const [r, g, b] = rgb;
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12;
}

function applyThemeTokens(appearance) {
  const tokens = themeTokensFromCss(appearance?.pluginTheme?.css);
  const root = document.documentElement;
  const overrides = new Map();
  for (const [name, candidates] of Object.entries(THEME_TOKENS)) {
    const value = candidates.map((key) => tokens.get(key)).find(Boolean);
    if (value) overrides.set(name, value);
  }
  const accent = tokens.get("accent");
  if (accent && !isNeutralColor(accent)) overrides.set("--accent", accent);
  // Primary action pair kept for the commit button: text-primary on bg-primary.
  const primary = tokens.get("text-primary") || accent;
  const surface = tokens.get("bg-primary");
  if (primary) overrides.set("--theme-primary", primary);
  if (surface) overrides.set("--theme-primary-fg", surface);
  for (const name of [...Object.keys(THEME_TOKENS), "--accent", "--theme-primary", "--theme-primary-fg"]) {
    if (overrides.has(name)) root.style.setProperty(name, overrides.get(name));
    else root.style.removeProperty(name);
  }
}

function applyAppearance(appearance) {
  const base = appearance?.base;
  document.documentElement.dataset.base =
    base === "light" || base === "dark"
      ? base
      : window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  applyThemeTokens(appearance);
  if (typeof appearance?.locale === "string" && appearance.locale) {
    document.documentElement.lang = appearance.locale;
  }
}

// ------------------------------------------------------------------- rendering

function signatureOf(data) {
  if (!data) return "";
  return JSON.stringify([
    data.repo?.root || null,
    data.branch,
    data.upstream,
    data.ahead,
    data.behind,
    data.detached,
    (data.staged || []).map((entry) => `${entry.path}:${entry.letter}:${entry.code}`),
    (data.changes || []).map((entry) => `${entry.path}:${entry.letter}:${entry.code}`),
  ]);
}

function applyState(data, options = {}) {
  if (!data) return;
  state.data = data;
  const signature = signatureOf(data);
  renderHeader();

  // Another repository invalidates the history and its cached file lists.
  const repoRoot = data?.repo?.root || null;
  if (state.history.repoRoot !== repoRoot) {
    state.history.repoRoot = repoRoot;
    resetHistory();
    renderHistory();
  }

  if (options.quiet && signature === state.signature) return;
  state.signature = signature;
  renderLists();
}

function renderHeader() {
  const data = state.data;
  const hasRepo = Boolean(data && data.repo);
  const branch = hasRepo ? (data.detached ? "游离 HEAD" : data.branch || "（未知）") : "—";

  els.branchName.textContent = branch;
  els.repoName.textContent = hasRepo
    ? data.repo.name
    : data?.workspace?.name || "";
  els.repoName.title = hasRepo ? data.repo.root : "";

  els.message.placeholder = hasRepo
    ? `消息(${MOD_KEY}Enter 在“${branch}”提交)`
    : "消息";

  const tracking = [];
  if (hasRepo && data.ahead > 0) tracking.push(`↑${data.ahead}`);
  if (hasRepo && data.behind > 0) tracking.push(`↓${data.behind}`);
  els.syncCount.hidden = tracking.length === 0;
  els.syncCount.textContent = tracking.join(" ");

  const totals = data?.counts || { staged: 0, changes: 0, total: 0 };
  els.statusRepo.textContent = hasRepo
    ? `${totals.staged} 个已暂存 · ${totals.changes} 个未暂存`
    : "";
  els.statusLast.textContent = hasRepo && data.lastCommit
    ? `${data.lastCommit.shortSha} ${data.lastCommit.subject}`
    : "";
  els.statusLast.title = els.statusLast.textContent;

  if (data?.hasConflicts) {
    showBanner("存在未解决的合并冲突：解决冲突并暂存文件后再提交。", "error");
  } else {
    showBanner("");
  }

  refreshButtons();
}

function refreshButtons() {
  const data = state.data;
  const busy = Boolean(state.busy);
  const hasRepo = Boolean(data && data.repo);
  const dirty = Boolean(hasRepo && data.counts && data.counts.total > 0);

  els.pullBtn.disabled = busy || !hasRepo;
  els.pushBtn.disabled = busy || !hasRepo;
  els.refreshBtn.disabled = busy || !hasRepo;
  els.commitBtn.disabled = busy || !hasRepo || !dirty;
  els.commitMenuBtn.disabled = busy || !hasRepo;
  els.genBtn.disabled = busy || !hasRepo || !dirty;
  els.genBtn.dataset.busy = state.busy === "generate" ? "true" : "false";

  els.commitLabel.textContent = state.busy === "commit" ? "提交中…" : "提交";
  els.pullBtn.dataset.busy = state.busy === "pull" ? "true" : "false";
  els.pushBtn.dataset.busy = state.busy === "push" ? "true" : "false";
}

function renderLists() {
  const data = state.data;

  if (!data || !data.repo) {
    const title = data?.reason === "NOT_A_REPO" ? "当前文件夹不是 git 仓库" : "尚未打开项目";
    els.lists.innerHTML = `<div class="empty"><strong>${title}</strong>在 PI-Desktop 中打开一个 git 仓库所在的文件夹，然后返回这里。</div>`;
    return;
  }

  const parts = [];
  if (data.staged.length > 0) {
    parts.push(groupHtml("staged", "已暂存", data.staged, true));
  }
  parts.push(groupHtml("changes", "更改", data.changes, false));
  els.lists.innerHTML = parts.join("");
}

function groupHtml(key, title, entries, staged) {
  const collapsed = state.collapsed[key];
  const actions = staged
    ? `<button class="mini" data-act="unstage-all" title="全部取消暂存" aria-label="全部取消暂存">−</button>`
    : `<button class="mini" data-act="stage-all" title="暂存全部更改" aria-label="暂存全部更改">＋</button>` +
      `<button class="mini" data-act="discard-all" title="放弃全部更改" aria-label="放弃全部更改">${DISCARD}</button>`;
  const rows = entries.map((entry) => fileRow(entry, staged)).join("");
  const body = collapsed
    ? ""
    : `<ul class="files">${
        rows ||
        `<li class="empty">${
          key === "changes" ? "没有未提交的更改" : "没有已暂存的更改"
        }</li>`
      }</ul>`;

  return `<section class="group">
    <header class="group-head">
      <button class="collapse" data-toggle="${key}" data-collapsed="${collapsed}" aria-expanded="${!collapsed}" aria-label="折叠或展开${title}">${CHEVRON}</button>
      <h2>${title}</h2>
      ${entries.length > 0 ? `<span class="count">${entries.length}</span>` : ""}
      <div class="group-actions">${actions}</div>
    </header>
    ${body}
  </section>`;
}

function fileRow(entry, staged) {
  const badge = fileBadge(entry.path);
  const { name, dir } = splitPath(entry.path);
  const path = escapeHtml(entry.path);
  const actions = staged
    ? `<button class="mini" data-act="unstage" data-path="${path}" title="取消暂存" aria-label="取消暂存">−</button>`
    : `<button class="mini" data-act="stage" data-path="${path}" title="暂存" aria-label="暂存">＋</button>` +
      (entry.conflict
        ? ""
        : `<button class="mini" data-act="discard" data-path="${path}" title="放弃更改" aria-label="放弃更改">${DISCARD}</button>`);

  return `<li class="file" data-path="${path}" data-staged="${staged ? "1" : "0"}" data-untracked="${
    entry.untracked ? "1" : "0"
  }" data-conflict="${entry.conflict ? "1" : "0"}" tabindex="0" role="button" title="${path}">
    <span class="ftype" style="--ft:${badge.color}">${escapeHtml(badge.label)}</span>
    <span class="ftext"><span class="fname">${escapeHtml(name)}</span>${
      dir ? `<span class="fdir">${escapeHtml(dir)}</span>` : ""
    }</span>
    <span class="factions">${actions}</span>
    <span class="fstat stat-${entry.letter}">${escapeHtml(entry.letter)}</span>
  </li>`;
}

// ------------------------------------------------------------- commit history

function resetHistory() {
  const history = state.history;
  history.commits = [];
  history.limit = HISTORY_PAGE;
  history.truncated = false;
  history.expanded = null;
  history.files.clear();
  history.loading = false;
  history.loaded = false;
  history.error = "";
}

function commitPropsHtml(commit) {
  const parents = commit.parents.length
    ? commit.parents.map((sha) => `<span class="mono">${escapeHtml(sha.slice(0, 7))}</span>`).join(" ")
    : "（根提交）";
  const committer =
    commit.committer && commit.committer !== commit.author
      ? `<span class="props-rel">${escapeHtml(commit.committer)}</span>`
      : "";
  const rows = [
    ["提交", `<span class="mono">${escapeHtml(commit.sha)}</span>`],
    ["作者", escapeHtml(commit.author)],
    [
      "作者时间",
      `${escapeHtml(absoluteTime(commit.authorDate))}<span class="props-rel">${escapeHtml(
        relativeTime(commit.authorDate),
      )}</span>`,
    ],
    ["提交时间", `${escapeHtml(absoluteTime(commit.commitDate))}${committer}`],
    ["父提交", parents],
  ];
  if (commit.body) rows.push(["说明", `<span class="props-body">${escapeHtml(commit.body)}</span>`]);

  return `<dl class="props">${rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`)
    .join("")}</dl>`;
}

function commitFileRow(sha, file) {
  const badge = fileBadge(file.path);
  const { name, dir } = splitPath(file.path);
  const path = escapeHtml(file.path);
  return `<li class="commit-file" data-sha="${escapeHtml(sha)}" data-path="${path}" tabindex="0" role="button" title="${path}">
    <span class="ftype" style="--ft:${badge.color}">${escapeHtml(badge.label)}</span>
    <span class="ftext"><span class="fname">${escapeHtml(name)}</span>${
      dir ? `<span class="fdir">${escapeHtml(dir)}</span>` : ""
    }</span>
    ${
      file.origPath
        ? `<span class="corig" title="原路径 ${escapeHtml(file.origPath)}">← ${escapeHtml(file.origPath)}</span>`
        : ""
    }
    <span class="fstat stat-${escapeHtml(file.letter)}">${escapeHtml(file.letter)}</span>
  </li>`;
}

function commitFilesHtml(sha) {
  const entry = state.history.files.get(sha);
  if (!entry) return `<div class="commit-files-note">读取改动文件…</div>`;
  if (entry.error) return `<div class="commit-files-note">${escapeHtml(entry.error)}</div>`;
  if (entry.files.length === 0) return `<div class="commit-files-note">该提交没有文件改动。</div>`;
  return `<ul class="commit-files">${entry.files
    .map((file) => commitFileRow(sha, file))
    .join("")}</ul>`;
}

function commitRowHtml(commit) {
  const expanded = state.history.expanded === commit.sha;
  const subject = commit.subject || "（无提交说明）";
  const title = `${subject} — ${commit.author} · ${absoluteTime(commit.authorDate)}`;
  return `<li class="commit" data-sha="${escapeHtml(commit.sha)}" data-expanded="${expanded ? "1" : "0"}">
    <div class="commit-line" role="button" tabindex="0" aria-expanded="${expanded}" title="${escapeHtml(title)}">
      <span class="csha">${escapeHtml(commit.shortSha)}</span>
      <span class="csub">${escapeHtml(subject)}</span>
      <span class="cauthor">${escapeHtml(commit.author)}</span>
      <span class="ctime">· ${escapeHtml(relativeTime(commit.authorDate))}</span>
    </div>
    ${expanded ? `<div class="commit-detail">${commitPropsHtml(commit)}${commitFilesHtml(commit.sha)}</div>` : ""}
  </li>`;
}

function renderHistory() {
  const history = state.history;
  const hasRepo = Boolean(state.data && state.data.repo);
  els.history.hidden = !hasRepo;
  if (!hasRepo) {
    els.commits.innerHTML = "";
    els.historyEmpty.hidden = true;
    return;
  }

  els.historyToggle.dataset.collapsed = history.collapsed ? "true" : "false";
  els.history.dataset.collapsed = history.collapsed ? "true" : "false";
  els.historyToggle.setAttribute("aria-expanded", String(!history.collapsed));
  els.historyBody.hidden = history.collapsed;
  els.historyMore.hidden = history.collapsed || !history.truncated;
  els.historyCount.hidden = history.commits.length === 0;
  els.historyCount.textContent = String(history.commits.length);

  // Keep the reader where they were when only the expanded row changed.
  const scrollTop = els.historyBody.scrollTop;
  els.commits.innerHTML = history.commits.map(commitRowHtml).join("");
  els.historyBody.scrollTop = scrollTop;

  if (history.commits.length > 0) {
    els.historyEmpty.hidden = true;
    return;
  }
  els.historyEmpty.hidden = false;
  els.historyEmpty.textContent =
    history.error || (history.loaded ? "此仓库还没有提交记录。" : "读取提交历史…");
}

async function loadHistory(options = {}) {
  const history = state.history;
  if (history.loading) return;
  if (!state.data || !state.data.repo) {
    history.commits = [];
    renderHistory();
    return;
  }

  const limit = Math.min(Math.max(Number(options.limit) || history.limit, 1), HISTORY_MAX);
  history.loading = true;
  if (!history.loaded) renderHistory();

  try {
    const result = await invoke("git.log", { limit });
    history.commits = Array.isArray(result?.commits) ? result.commits : [];
    history.limit = Number(result?.limit) || limit;
    history.truncated = Boolean(result?.truncated);
    history.error = "";
    history.loaded = true;

    // Drop cached file lists for commits that fell out of the current page.
    const present = new Set(history.commits.map((commit) => commit.sha));
    if (history.expanded && !present.has(history.expanded)) history.expanded = null;
    for (const sha of [...history.files.keys()]) {
      if (!present.has(sha)) history.files.delete(sha);
    }
  } catch (error) {
    history.error = errorText(error);
    history.loaded = true;
    if (history.commits.length === 0) toast(history.error, "error");
  } finally {
    history.loading = false;
    renderHistory();
  }
}

function loadMoreHistory() {
  const history = state.history;
  const next = Math.min(history.limit + HISTORY_PAGE, HISTORY_MAX);
  if (next <= history.limit) return;
  loadHistory({ limit: next });
}

async function loadCommitFiles(sha) {
  try {
    const result = await invoke("git.commitFiles", { sha });
    state.history.files.set(sha, {
      files: Array.isArray(result?.files) ? result.files : [],
      error: "",
    });
  } catch (error) {
    state.history.files.set(sha, { files: [], error: errorText(error) });
  }
  if (state.history.expanded === sha) renderHistory();
}

async function toggleCommit(sha) {
  const history = state.history;
  if (!sha) return;
  if (history.expanded === sha) {
    history.expanded = null;
    renderHistory();
    return;
  }
  history.expanded = sha;
  renderHistory();
  const row = els.commits.querySelector(`.commit[data-sha="${sha}"] .commit-line`);
  if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  if (!history.files.has(sha)) await loadCommitFiles(sha);
}

/** One file inside one commit, shown in the same split pane the working diff uses. */
function openCommitDiff(sha, filePath) {
  const short = String(sha).slice(0, 7);
  const token = beginDiff({ path: filePath, sha });
  openDiffPane({
    title: filePath,
    sub: `${short} · 提交差异`,
    body: `<div class="patch-note">读取差异…</div>`,
  });

  return invoke("git.commitDiff", { sha, path: filePath }).then(
    (result) => showPatch(token, result?.patch, `<div class="patch-note">该提交对这个文件没有可显示的文本差异。</div>`),
    (error) => {
      if (state.diff.token !== token) return;
      els.diffBody.innerHTML = `<div class="patch-note">${escapeHtml(errorText(error))}</div>`;
    },
  );
}

// ---------------------------------------------------------------- split pane

function splitBounds() {
  const total = els.split.clientWidth || 0;
  const max = Math.max(total - MAIN_MIN, 0);
  return { total, min: Math.min(DIFF_MIN, max), max };
}

/** Clamp the requested diff width and hand it to CSS; the pane reads it back. */
function setDiffWidth(width) {
  const { total, min, max } = splitBounds();
  if (!total) return;
  const next = Math.round(Math.min(Math.max(Number(width) || 0, min), max));
  if (next === state.diff.width && els.split.style.getPropertyValue("--diff-width")) return;
  state.diff.width = next;
  els.split.style.setProperty("--diff-width", `${next}px`);
  els.splitter.setAttribute("aria-valuemin", String(min));
  els.splitter.setAttribute("aria-valuemax", String(max));
  els.splitter.setAttribute("aria-valuenow", String(next));
}

function openDiffPane({ title, sub, body }) {
  els.diffTitle.textContent = title || "";
  els.diffTitle.title = title || "";
  els.diffSub.textContent = sub || "";
  els.diffSub.hidden = !sub;
  els.diffStat.hidden = true;
  els.diffStat.textContent = "";
  els.diffBody.innerHTML = body || "";
  els.diffBody.scrollTop = 0;
  els.diffPane.hidden = false;
  els.splitter.hidden = false;
  state.diff.open = true;
  setDiffWidth(state.diff.width || splitBounds().total / 2);
}

function closeDiffPane() {
  state.diff.token += 1; // drop any in-flight load
  state.diff.open = false;
  state.diff.path = "";
  state.diff.staged = false;
  state.diff.sha = null;
  els.diffPane.hidden = true;
  els.splitter.hidden = true;
  els.diffBody.innerHTML = "";
  els.diffStat.hidden = true;
  els.diffStat.textContent = "";
  els.diffTitle.textContent = "";
  els.diffSub.textContent = "";
  els.split.style.removeProperty("--diff-width");
}

/** Point the pane at a new target, and return the token that guards its load. */
function beginDiff(target) {
  state.diff.token += 1;
  state.diff.path = target.path || "";
  state.diff.staged = Boolean(target.staged);
  state.diff.sha = target.sha || null;
  return state.diff.token;
}

function patchStat(patch) {
  let add = 0;
  let del = 0;
  for (const line of String(patch).split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
}

function showDiffStat(stat) {
  if (!stat || (!stat.add && !stat.del)) {
    els.diffStat.hidden = true;
    els.diffStat.textContent = "";
    return;
  }
  els.diffStat.innerHTML = `<span class="dstat-add">+${stat.add}</span><span class="dstat-del">−${stat.del}</span>`;
  els.diffStat.hidden = false;
}

/** Render a patch unless the pane has already moved on to another target. */
function showPatch(token, patch, emptyHtml) {
  if (state.diff.token !== token) return;
  const text = String(patch || "");
  if (!text.trim()) {
    showDiffStat(null);
    els.diffBody.innerHTML = emptyHtml;
    return;
  }
  showDiffStat(patchStat(text));
  els.diffBody.innerHTML = patchHtml(text);
  els.diffBody.scrollTop = 0;
}

function onSplitterDown(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  const right = els.split.getBoundingClientRect().right;
  els.splitter.dataset.dragging = "true";
  document.body.classList.add("is-resizing");
  if (typeof els.splitter.setPointerCapture === "function") {
    els.splitter.setPointerCapture(event.pointerId);
  }

  const move = (moveEvent) => setDiffWidth(right - moveEvent.clientX);
  const stop = () => {
    els.splitter.removeEventListener("pointermove", move);
    els.splitter.removeEventListener("pointerup", stop);
    els.splitter.removeEventListener("pointercancel", stop);
    delete els.splitter.dataset.dragging;
    document.body.classList.remove("is-resizing");
  };

  els.splitter.addEventListener("pointermove", move);
  els.splitter.addEventListener("pointerup", stop);
  els.splitter.addEventListener("pointercancel", stop);
}

function onSplitterKey(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  // ArrowLeft pulls the divider left, which gives the diff pane more room.
  const step = (event.shiftKey ? 64 : DIFF_STEP) * (event.key === "ArrowLeft" ? 1 : -1);
  setDiffWidth(state.diff.width + step);
}

// ----------------------------------------------------------------------- sheet

function openSheet({ title, sub, body, footer, mode }) {
  els.sheetTitle.textContent = title || "";
  els.sheetSub.textContent = sub || "";
  els.sheetSub.hidden = !sub;
  els.sheetBody.innerHTML = body || "";
  els.sheetBody.scrollTop = 0;
  if (footer) {
    els.sheetFoot.innerHTML = footer;
    els.sheetFoot.hidden = false;
  } else {
    els.sheetFoot.innerHTML = "";
    els.sheetFoot.hidden = true;
  }
  state.sheet.mode = mode || "info";
  els.overlay.dataset.mode = state.sheet.mode;
  els.overlay.hidden = false;
  els.sheetBack.focus();
}

function closeSheet(result) {
  els.overlay.hidden = true;
  delete els.overlay.dataset.mode;
  state.sheet.mode = null;
  const resolve = state.sheet.resolve;
  state.sheet.resolve = null;
  if (resolve) resolve(Boolean(result));
}

function confirmAction(title, bodyHtml, confirmLabel) {
  return new Promise((resolve) => {
    state.sheet.resolve = resolve;
    openSheet({
      title,
      sub: "",
      body: `<div class="confirm-body">${bodyHtml}</div>`,
      footer: `<button class="btn" data-answer="0">取消</button><button class="btn btn-danger" data-answer="1">${escapeHtml(
        confirmLabel,
      )}</button>`,
      mode: "confirm",
    });
  });
}

function patchHtml(patch) {
  const lines = String(patch).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const LIMIT = 4000;
  const shown = lines.slice(0, LIMIT);

  const body = shown
    .map((line) => {
      let kind = "ctx";
      if (
        line.startsWith("+++") ||
        line.startsWith("---") ||
        line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("similarity ") ||
        line.startsWith("rename ") ||
        line.startsWith("\\ No newline")
      ) {
        kind = "meta";
      } else if (line.startsWith("@@")) {
        kind = "hunk";
      } else if (line.startsWith("+")) {
        kind = "add";
      } else if (line.startsWith("-")) {
        kind = "del";
      }
      return `<span class="line ${kind}">${line ? escapeHtml(line) : " "}</span>`;
    })
    .join("");

  const note =
    lines.length > LIMIT
      ? `<div class="patch-note">已截断：仅显示前 ${LIMIT} 行（共 ${lines.length} 行）。</div>`
      : "";

  return `<pre class="patch">${body}</pre>${note}`;
}

async function openDiff(filePath, staged) {
  const token = beginDiff({ path: filePath, staged });
  openDiffPane({
    title: filePath,
    sub: staged ? "已暂存" : "工作区",
    body: `<div class="patch-note">读取差异…</div>`,
  });

  try {
    const result = await invoke("git.diff", { path: filePath, staged });
    if (state.diff.token !== token) return;
    const sub = [staged ? "已暂存" : "工作区"];
    if (result.untracked) sub.push("未跟踪文件");
    if (result.conflict) sub.push("存在冲突");
    els.diffSub.textContent = sub.join(" · ");
    els.diffSub.hidden = false;
    showPatch(
      token,
      result.patch,
      `<div class="patch-note">${
        result.untracked ? "该未跟踪文件没有可显示的文本差异。" : "没有可显示的差异。"
      }</div>`,
    );
  } catch (error) {
    if (state.diff.token !== token) return;
    els.diffBody.innerHTML = `<div class="patch-note">${escapeHtml(errorText(error))}</div>`;
  }
}

// --------------------------------------------------------------------- actions

async function withBusy(label, fn) {
  if (state.busy) return null;
  state.busy = label;
  refreshButtons();
  try {
    return await fn();
  } catch (error) {
    toast(errorText(error), "error");
    return null;
  } finally {
    state.busy = null;
    refreshButtons();
  }
}

async function loadState(options = {}) {
  const result = await withBusy("refresh", () => invoke("git.state"));
  if (result) applyState(result, options);
  // History is a separate read-only call, so the 6 s poll never pays for it.
  if (result?.repo) await loadHistory();
  return result;
}

async function pollState() {
  if (state.busy || document.hidden || !els.overlay.hidden) return;
  try {
    const result = await invoke("git.state");
    if (result && result.ok) applyState(result, { quiet: true });
  } catch {
    /* polling is best-effort */
  }
}

async function stagePaths(paths, staged) {
  const result = await withBusy(staged ? "unstage" : "stage", () =>
    invoke(staged ? "git.unstage" : "git.stage", { paths }),
  );
  if (result) applyState(result.state);
}

async function stageAll(staged) {
  const result = await withBusy(staged ? "unstage-all" : "stage-all", () =>
    invoke(staged ? "git.unstageAll" : "git.stageAll"),
  );
  if (result) applyState(result.state);
}

async function discardPaths(paths) {
  if (paths.length === 0) return;
  const what =
    paths.length === 1
      ? `<code>${escapeHtml(paths[0])}</code>`
      : `这 ${paths.length} 个文件`;
  const ok = await confirmAction(
    "放弃更改",
    `放弃 ${what} 的本地改动？此操作不可撤销。`,
    "放弃更改",
  );
  if (!ok) return;
  const result = await withBusy("discard", () => invoke("git.discard", { paths }));
  if (result) {
    applyState(result.state);
    toast("已放弃更改", "success");
  }
}

async function commit(forceAll) {
  const data = state.data;
  if (!data || !data.repo) return;
  const message = els.message.value.trim();
  if (!message) {
    toast("请先填写提交信息，或点右上角的 AI 按钮让模型写一条。", "error");
    els.message.focus();
    return;
  }
  if (!data.counts || data.counts.total === 0) {
    toast("没有可提交的改动。", "error");
    return;
  }

  const stageAllChanges =
    forceAll === true || (forceAll !== false && data.staged.length === 0);

  const result = await withBusy("commit", () =>
    invoke("git.commit", {
      message,
      stageAll: stageAllChanges,
      push: els.optPush.checked,
      signOff: els.optSignoff.checked,
    }),
  );
  if (!result) return;

  els.message.value = "";
  autosizeMessage();
  applyState(result.state);
  loadHistory();
  const sha = result.commit?.shortSha ? `${result.commit.shortSha} ` : "";
  toast(`已提交 ${sha}${result.commit?.subject || ""}`.trim(), "success");
  if (result.pushOutput !== null && result.pushOutput !== undefined) {
    toast(firstLine(result.pushOutput) || "已推送到远端", "success");
  }
}

// The composer grows with its content, but never past a readable size; the
// cap is also bounded by the panel so the lists above keep usable height.
function autosizeMessage() {
  const el = els.message;
  const styles = getComputedStyle(el);
  const lineHeight = parseFloat(styles.lineHeight) || 18;
  const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  const borders = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
  const minHeight = Math.round(lineHeight * 3 + padding + borders);
  const maxHeight = Math.max(
    minHeight,
    Math.round(
      Math.min(lineHeight * MESSAGE_MAX_ROWS + padding + borders, window.innerHeight * 0.42),
    ),
  );
  el.style.height = "auto";
  const content = el.scrollHeight + borders;
  el.style.height = `${Math.min(Math.max(content, minHeight), maxHeight)}px`;
  el.style.overflowY = content > maxHeight ? "auto" : "hidden";
}

/** Abort an in-flight typewriter fill and release the pending promise. */
function stopMessageStream() {
  const stream = messageStream;
  if (!stream) return;
  messageStream = null;
  cancelAnimationFrame(stream.raf);
  stream.resolve();
}

/**
 * Write the generated message character by character so the reasoning trail is
 * visible and the composer grows as lines arrive. Resolves when finished or
 * cancelled; prefers-reduced-motion fills in one go.
 */
function streamMessage(text) {
  stopMessageStream();
  const value = String(text || "");
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  if (!value || reduceMotion) {
    els.message.value = value;
    autosizeMessage();
    return Promise.resolve();
  }

  els.message.value = "";
  autosizeMessage();
  els.message.focus();

  return new Promise((resolve) => {
    const chars = Array.from(value);
    const duration = Math.min(1100, Math.max(320, chars.length * 12));
    const started = performance.now();
    const stream = { raf: 0, resolve };
    messageStream = stream;

    const tick = (now) => {
      if (messageStream !== stream) return;
      const progress = Math.min(1, (now - started) / duration);
      els.message.value = chars.slice(0, Math.round(chars.length * progress)).join("");
      autosizeMessage();
      if (progress < 1) {
        stream.raf = requestAnimationFrame(tick);
        return;
      }
      messageStream = null;
      els.message.setSelectionRange(chars.length, chars.length);
      resolve();
    };
    stream.raf = requestAnimationFrame(tick);
  });
}

async function generateMessage() {
  const result = await withBusy("generate", async () => {
    const generated = await invoke("git.generateMessage");
    await streamMessage(generated && generated.message);
    return generated;
  });
  if (!result) return;
  toast(
    result.basedOn === "staged" ? "已根据已暂存的改动生成提交信息" : "已根据全部改动生成提交信息",
    "success",
  );
}

async function pull() {
  const result = await withBusy("pull", () => invoke("git.pull"));
  if (!result) return;
  applyState(result.state);
  loadHistory();
  toast(firstLine(result.output) || "已是最新", "success");
}

async function push() {
  const result = await withBusy("push", () => invoke("git.push"));
  if (!result) return;
  applyState(result.state);
  loadHistory();
  toast(firstLine(result.output) || "已推送", "success");
}

// ---------------------------------------------------------------------- events

function closeMenu() {
  if (els.commitMenu.hidden) return;
  els.commitMenu.hidden = true;
  els.commitMenuBtn.setAttribute("aria-expanded", "false");
}

function toggleMenu() {
  const next = els.commitMenu.hidden;
  els.commitMenu.hidden = !next;
  els.commitMenuBtn.setAttribute("aria-expanded", String(next));
}

function bindEvents() {
  els.refreshBtn.addEventListener("click", () => loadState());
  els.pullBtn.addEventListener("click", pull);
  els.pushBtn.addEventListener("click", push);
  els.commitBtn.addEventListener("click", () => commit(undefined));
  els.genBtn.addEventListener("click", generateMessage);

  // User edits win over a running typewriter fill.
  els.message.addEventListener("input", () => {
    stopMessageStream();
    autosizeMessage();
  });

  // Same for the history header: the whole strip collapses, minus its actions.
  els.historyHead.addEventListener("click", (event) => {
    if (event.target.closest(".group-actions")) return;
    state.history.collapsed = !state.history.collapsed;
    renderHistory();
  });
  els.historyMore.addEventListener("click", loadMoreHistory);

  els.commits.addEventListener("click", (event) => {
    const file = event.target.closest(".commit-file");
    if (file) {
      event.stopPropagation();
      openCommitDiff(file.dataset.sha, file.dataset.path);
      return;
    }
    const row = event.target.closest(".commit-line");
    if (!row) return;
    const item = row.closest(".commit");
    if (item) toggleCommit(item.dataset.sha);
  });

  els.commits.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target.closest(".commit-line, .commit-file");
    if (!target) return;
    event.preventDefault();
    target.click();
  });

  els.commitMenuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
  });

  els.commitMenu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-menu]");
    if (!item) return;
    closeMenu();
    if (item.dataset.menu === "commit-staged") commit(false);
    if (item.dataset.menu === "commit-all") commit(true);
  });

  document.addEventListener("click", (event) => {
    if (!els.commitMenu.hidden && !event.target.closest(".composer")) closeMenu();
  });

  els.lists.addEventListener("click", (event) => {
    const row = event.target.closest(".file");
    const action = event.target.closest("[data-act]");
    // The whole group header toggles collapse, but its own actions must not.
    const toggle = event.target.closest(".group-actions")
      ? null
      : event.target.closest(".group-head")?.querySelector("[data-toggle]") ||
        event.target.closest("[data-toggle]");

    if (action) {
      event.stopPropagation();
      const act = action.dataset.act;
      if (act === "stage-all") return void stageAll(false);
      if (act === "unstage-all") return void stageAll(true);
      if (act === "discard-all") {
        const changes = state.data?.changes || [];
        return void discardPaths(changes.filter((entry) => !entry.conflict).map((entry) => entry.path));
      }
      const filePath = action.dataset.path;
      if (!filePath) return;
      if (act === "stage") return void stagePaths([filePath], false);
      if (act === "unstage") return void stagePaths([filePath], true);
      if (act === "discard") return void discardPaths([filePath]);
      return;
    }

    if (toggle) {
      const key = toggle.dataset.toggle;
      state.collapsed[key] = !state.collapsed[key];
      renderLists();
      return;
    }

    if (row) {
      const filePath = row.dataset.path;
      const staged = row.dataset.staged === "1";
      if (filePath) openDiff(filePath, staged);
    }
  });

  els.lists.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".file");
    if (!row) return;
    event.preventDefault();
    openDiff(row.dataset.path, row.dataset.staged === "1");
  });

  els.sheetBack.addEventListener("click", () => closeSheet(false));
  els.sheetClose.addEventListener("click", () => closeSheet(false));

  els.diffClose.addEventListener("click", () => closeDiffPane());
  els.splitter.addEventListener("pointerdown", onSplitterDown);
  els.splitter.addEventListener("dblclick", () => setDiffWidth(splitBounds().total / 2));
  els.splitter.addEventListener("keydown", onSplitterKey);

  els.sheetFoot.addEventListener("click", (event) => {
    const button = event.target.closest("[data-answer]");
    if (!button) return;
    closeSheet(button.dataset.answer === "1");
  });

  els.overlay.addEventListener("click", (event) => {
    if (event.target === els.overlay && state.sheet.mode === "confirm") closeSheet(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!els.overlay.hidden) {
        closeSheet(false);
        return;
      }
      // The diff is a pane, not a dialog: Esc closes it before anything else.
      if (state.diff.open) {
        closeDiffPane();
        return;
      }
      closeMenu();
      return;
    }
    const withMod = IS_MAC ? event.metaKey : event.ctrlKey;
    if (withMod && event.key === "Enter") {
      event.preventDefault();
      commit(event.shiftKey ? true : undefined);
    }
  });

  // ⌘/Ctrl + Enter from the composer reaches the document handler above; a
  // second handler here would fire the commit twice for one keystroke.
}

async function init() {
  autosizeMessage();
  bindEvents();
  applyAppearance(null);
  renderHistory();

  if (typeof ResizeObserver === "function") {
    // The host can resize the work panel at any time: keep the stored width legal.
    const observer = new ResizeObserver(() => {
      if (state.diff.open) setDiffWidth(state.diff.width || splitBounds().total / 2);
    });
    observer.observe(els.split);
  }

  if (window.pluginBridge?.on) {
    window.pluginBridge.on("appearance:changed", applyAppearance);
    window.pluginBridge.on("workspace:changed", () => {
      loadState();
    });
    window.pluginBridge.on("view:open", () => {
      loadState();
    });
  }

  try {
    const appearance = await invoke("app.getAppearance");
    applyAppearance(appearance || null);
  } catch {
    /* older hosts keep the system palette */
  }

  try {
    await loadState();
  } catch (error) {
    showBanner(errorText(error));
  }

  document.documentElement.dataset.bootReady = "true";
  state.pollTimer = setInterval(pollState, 6000);
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    showBanner(errorText(error));
    refreshButtons();
  });
});
})();

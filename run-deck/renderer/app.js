"use strict";

/**
 * Run Deck page.
 *
 * Lives in a work-panel tab (an embedded plugin view), so it belongs to the
 * session that opened it and never leaves the main window. It talks to the
 * plugin only through `pluginBridge.invoke`, and it keeps one long poll open so
 * a dev server's output shows up as it arrives.
 */

(() => {
  const bridge = window.pluginBridge;

  const STRINGS = {
    en: {
      add: "Add launch",
      edit: "Edit",
      dialogNew: "New launch",
      dialogEdit: "Edit launch",
      formName: "Name",
      formCommand: "Command",
      formCwd: "Working directory",
      formEnv: "Environment variables",
      envHint: "One KEY=value per line, passed to the process as-is (stored in plain text).",
      envBadLine: (line) => `Line ${line}: expected KEY=value`,
      save: "Save",
      cancel: "Cancel",
      delete: "Delete",
      emptyLine1: "No launch commands yet.",
      emptyLine2: "Add one with ＋, or ask the agent.",
      start: "Start",
      stop: "Stop",
      running: "running",
      stopped: "stopped",
      exited: "exited",
      failed: "failed",
      confirmDelete: (name) => `Delete "${name}"?`,
      noWorkspace: "No project open",
      bridgeMissing: "The plugin bridge is unavailable — reopen this tab.",
      startFailed: "Could not start",
      saveFailed: "Could not save",
      deleteFailed: "Could not delete",
      clearFailed: "Could not clear output",
      clearOutput: "Clear output",
      close: "Close",
      namePlaceholder: "Web dev server",
      cwdPlaceholder: "~/code/my-app — empty means the project folder",
      envPlaceholder: "PORT=3000\nNODE_ENV=development",
    },
    zh: {
      add: "新增启动项",
      edit: "编辑",
      dialogNew: "新增启动项",
      dialogEdit: "编辑启动项",
      formName: "名称",
      formCommand: "命令",
      formCwd: "工作目录",
      formEnv: "环境变量",
      envHint: "每行一个 KEY=value，按原样传给进程（以明文保存）。",
      envBadLine: (line) => `第 ${line} 行：应为 KEY=value`,
      save: "保存",
      cancel: "取消",
      delete: "删除",
      emptyLine1: "还没有启动命令。",
      emptyLine2: "点 ＋ 添加，或者让 agent 帮你加。",
      start: "启动",
      stop: "停止",
      running: "运行中",
      stopped: "已停止",
      exited: "已退出",
      failed: "失败",
      confirmDelete: (name) => `删除“${name}”？`,
      noWorkspace: "未打开项目",
      bridgeMissing: "插件桥不可用，请重新打开此标签页。",
      startFailed: "启动失败",
      saveFailed: "保存失败",
      deleteFailed: "删除失败",
      clearFailed: "无法清空输出",
      clearOutput: "清空输出",
      close: "关闭",
      namePlaceholder: "Web 开发服务",
      cwdPlaceholder: "~/code/my-app —— 留空表示项目目录",
      envPlaceholder: "PORT=3000\nNODE_ENV=development",
    },
  };

  // The host's own interface language decides the strings; anything that is not
  // Chinese reads English (see AGENTS.md, "语言").
  let lang = null;
  let t = STRINGS.en;

  const el = {
    project: document.getElementById("project"),
    count: document.getElementById("count"),
    add: document.getElementById("add"),
    list: document.getElementById("list"),
    empty: document.getElementById("empty"),
    dialog: document.getElementById("dialog"),
    dlgForm: document.getElementById("dialog-form"),
    dlgTitle: document.getElementById("dlg-title"),
    dlgName: document.getElementById("dlg-name"),
    dlgCommand: document.getElementById("dlg-command"),
    dlgCwd: document.getElementById("dlg-cwd"),
    dlgEnv: document.getElementById("dlg-env"),
    dlgDelete: document.getElementById("dlg-delete"),
    dlgCancel: document.getElementById("dlg-cancel"),
    detail: document.getElementById("detail"),
    detailCmd: document.getElementById("detail-cmd"),
    detailStop: document.getElementById("detail-stop"),
    detailClear: document.getElementById("detail-clear"),
    detailClose: document.getElementById("detail-close"),
    term: document.getElementById("term"),
    status: document.getElementById("status"),
  };

  const state = {
    workspacePath: null,
    launches: [],
    processes: new Map(),
    expanded: null,
    // project realpath -> launch id whose output panel was open there
    expandedByWorkspace: new Map(),
    editing: null,
    cursors: {},
    maxConcurrent: 8,
    term: null,
    fit: null,
    appearance: null,
    stopped: false,
  };

  // ---------------------------------------------------------------- plumbing

  function setStatus(message, kind) {
    if (!message) {
      el.status.hidden = true;
      el.status.textContent = "";
      return;
    }
    el.status.hidden = false;
    el.status.dataset.kind = kind ?? "info";
    el.status.textContent = message;
  }

  async function invoke(channel, payload) {
    if (!bridge?.invoke) throw new Error(t.bridgeMissing);
    const result = await bridge.invoke(channel, payload ?? {});
    if (result && result.ok === false) {
      const message = result.error?.message ?? result.reason ?? "request failed";
      const error = new Error(message);
      error.code = result.error?.code ?? "FAILED";
      throw error;
    }
    return result;
  }

  function applySnapshot(snapshot) {
    const previous = state.workspacePath;
    state.workspacePath = snapshot.workspacePath ?? null;
    // The editor is a modal for one project's launch, so it cannot survive a
    // project switch: it would sit over a list it does not belong to, and
    // saving would target the wrong project.
    if (previous !== state.workspacePath) closeDialog();
    state.launches = snapshot.launches ?? [];
    state.maxConcurrent = snapshot.maxConcurrent ?? 8;
    state.processes = new Map();
    for (const record of snapshot.known ?? []) state.processes.set(record.launchId, record);
    // The panel belongs to a launch, not to the tab: switching project hides it
    // without forgetting what was open, so coming back restores it. Only an
    // explicit close (or deleting the launch) clears the memory.
    if (state.expanded && !allLaunches().some((launch) => launch.id === state.expanded)) hideDetail();
    const remembered = state.workspacePath ? state.expandedByWorkspace.get(state.workspacePath) : null;
    if (!state.expanded && remembered && allLaunches().some((launch) => launch.id === remembered)) {
      void expand(remembered);
    }
    render();
  }

  function applyProcess(record) {
    if (!record?.launchId) return;
    state.processes.set(record.launchId, { ...(state.processes.get(record.launchId) ?? {}), ...record });
    updateRow(record.launchId);
  }

  function allLaunches() {
    return state.launches.map((launch) => ({ ...launch }));
  }

  function dotState(record) {
    if (!record) return "idle";
    if (record.status === "running") return record.stopping ? "stopping" : "running";
    if (record.status === "exited") return record.exitCode === 0 || record.exitCode === null ? "exited" : "failed";
    return "idle";
  }

  function statusLabel(record) {
    const dot = dotState(record);
    if (dot === "running") return t.running;
    if (dot === "stopping") return t.stop;
    if (dot === "failed") return `${t.failed}${record?.exitCode === null ? "" : ` ${record.exitCode}`}`;
    if (dot === "exited") return t.exited;
    return t.stopped;
  }

  // -------------------------------------------------------------------- view

  function render() {
    const launches = allLaunches();
    el.project.textContent = state.workspacePath
      ? state.workspacePath.split("/").filter(Boolean).pop()
      : t.noWorkspace;
    el.project.title = state.workspacePath ?? "";

    const running = [...state.processes.values()].filter((record) => record.status === "running").length;
    el.count.textContent = launches.length ? `${running}/${state.maxConcurrent}` : "";
    el.add.title = t.add;

    el.list.textContent = "";
    for (const launch of launches) el.list.append(rowElement(launch));

    const none = launches.length === 0;
    el.empty.hidden = !none;
    el.list.hidden = none;
    if (none) hideDetail();
  }

  // Small inline glyphs: the host's own icon buttons use 16px stroked SVGs.
  const ICON_PLAY =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M5.5 3.6 12.4 8l-6.9 4.4z" fill="currentColor" stroke="none"/></svg>';
  const ICON_STOP =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.4" fill="currentColor" stroke="none"/></svg>';
  const ICON_EDIT =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M9.7 3.3l3 3M3.3 12.7l.7-3.1 6.3-6.3a1.1 1.1 0 0 1 1.6 0l1.5 1.5a1.1 1.1 0 0 1 0 1.6L7.1 12.7l-3.8 0z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function rowElement(launch) {
    const record = state.processes.get(launch.id);
    const li = document.createElement("li");
    li.className = "row";
    li.dataset.id = launch.id;
    li.dataset.expanded = String(state.expanded === launch.id);

    const main = document.createElement("button");
    main.type = "button";
    main.className = "row-main";
    main.dataset.act = "expand";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.dataset.state = dotState(record);

    const col = document.createElement("span");
    col.className = "col";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = launch.name;
    const cmd = document.createElement("span");
    cmd.className = "cmd";
    cmd.textContent = launch.command;
    col.append(name, cmd);
    main.append(dot, col);

    if (record?.port) {
      const port = document.createElement("span");
      port.className = "port";
      port.textContent = `:${record.port}`;
      main.append(port);
    }

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-btn icon-btn-square";
    edit.dataset.act = "edit";
    edit.title = t.edit;
    edit.innerHTML = ICON_EDIT;

    const act = document.createElement("button");
    act.type = "button";
    act.className = "icon-btn icon-btn-square";
    const isRunning = record?.status === "running";
    act.dataset.act = isRunning ? "stop" : "start";
    act.title = isRunning ? t.stop : t.start;
    act.innerHTML = isRunning ? ICON_STOP : ICON_PLAY;

    li.append(main, edit, act);
    return li;
  }

  function updateRow(launchId) {
    const existing = el.list.querySelector(`.row[data-id="${CSS.escape(launchId)}"]`);
    const launch = allLaunches().find((candidate) => candidate.id === launchId);
    if (!launch) return;
    const fresh = rowElement(launch);
    if (existing) existing.replaceWith(fresh);
    else el.list.append(fresh);
  }

  // ------------------------------------------------------------------ detail

  // xterm paints its own canvas, so it needs the host colours explicitly.
  function hostToken(name, fallback) {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return value || fallback;
  }

  function termTheme() {
    // One colour for the panel and the canvas inside it: `--deck-term-bg` is the
    // page white in light (a terminal block does not become gray just because it
    // is a terminal) and the recessed inset in dark.
    const background = hostToken("--deck-term-bg", hostToken("--ds-bg-primary", "#ffffff"));
    return {
      background,
      foreground: hostToken("--ds-text-primary", "#ffffff"),
      cursor: background,
      selectionBackground: hostToken("--ds-tile-deep", undefined),
    };
  }

  function ensureTerm() {
    if (state.term) return state.term;
    const term = new window.Terminal({
      disableStdin: true,
      // The child is a pipe, not a tty, so nobody translates LF into CRLF the way
      // a pty would (ONLCR). Python/uvicorn/go loggers emit bare "\n"; without
      // this every new line starts at the previous line's column and the output
      // looks scattered. "\r\n" output is unaffected: the CR still wins.
      convertEol: true,
      cursorBlink: false,
      fontSize: 11,
      fontFamily: hostToken("--font-mono", 'ui-monospace, Menlo, monospace'),
      lineHeight: 1.25,
      scrollback: 4000,
      theme: termTheme(),
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el.term);
    state.term = term;
    state.fit = fit;
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* the panel can be zero-sized while hidden */
      }
    });
    observer.observe(el.term);
    return term;
  }

  function writeChunks(chunks) {
    const term = state.term;
    if (!term) return;
    for (const chunk of chunks) term.write(chunk.text);
  }

  async function expand(launchId) {
    const launch = allLaunches().find((candidate) => candidate.id === launchId);
    if (!launch) return;
    state.expanded = launchId;
    if (state.workspacePath) state.expandedByWorkspace.set(state.workspacePath, launchId);
    el.detail.hidden = false;
    el.detailCmd.textContent = launch.command;
    // The bar only has room for the command; where it runs stays in the tooltip.
    el.detailCmd.title = launch.cwd ? `${launch.command}\n${launch.cwd}` : launch.command;

    const term = ensureTerm();
    term.reset();
    try {
      state.fit?.fit();
    } catch {
      /* ignore */
    }
    const result = await invoke("deck.output", { launchId });
    writeChunks(result?.chunks ?? []);
    state.cursors[launchId] = result?.chunks?.length ? result.chunks[result.chunks.length - 1].seq : 0;
    if (result?.process) applyProcess(result.process);
    for (const row of el.list.querySelectorAll(".row")) {
      row.dataset.expanded = String(row.dataset.id === launchId);
    }
  }

  /** Hide the panel but keep the per-project memory of which launch was open. */
  function hideDetail() {
    state.expanded = null;
    el.detail.hidden = true;
    state.term?.reset();
    for (const row of el.list.querySelectorAll(".row")) row.dataset.expanded = "false";
  }

  /** The user closed it: forget it too, so returning to this project stays closed. */
  function closeDetail() {
    if (state.workspacePath) state.expandedByWorkspace.delete(state.workspacePath);
    hideDetail();
  }

  // ------------------------------------------------------------------ dialog

  // `KEY=value` per line, the way a `.env` file reads. Only the first `=` splits
  // the pair, so a value keeps its own `=` and spaces.
  function parseEnvText(text) {
    const env = {};
    const lines = String(text ?? "").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line || line.startsWith("#")) continue;
      const split = line.indexOf("=");
      if (split <= 0) return { error: t.envBadLine(index + 1) };
      const key = line.slice(0, split).trim();
      let value = line.slice(split + 1).trim();
      const quoted =
        value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
      if (quoted) value = value.slice(1, -1);
      env[key] = value;
    }
    return { env };
  }

  function envToText(env) {
    return Object.entries(env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  }

  function openDialog(launch) {
    state.editing = launch?.id ?? null;
    el.dlgTitle.textContent = launch ? t.dialogEdit : t.dialogNew;
    el.dlgName.value = launch?.name ?? "";
    el.dlgCommand.value = launch?.command ?? "";
    el.dlgCwd.value = launch?.cwd ?? "";
    el.dlgEnv.value = envToText(launch?.env);
    el.dlgDelete.hidden = !launch;
    setStatus("");
    el.dialog.hidden = false;
    el.dlgName.focus();
    el.dlgName.select();
  }

  function closeDialog() {
    state.editing = null;
    el.dialog.hidden = true;
  }

  // -------------------------------------------------------------------- poll

  async function pollLoop() {
    while (!state.stopped) {
      try {
        const result = await invoke("deck.poll", { cursors: state.cursors, waitMs: 8000 });
        for (const event of result?.events ?? []) {
          const record = event.process;
          if (record) applyProcess(record);
          if (state.expanded === event.launchId) writeChunks(event.chunks);
          const last = event.chunks?.[event.chunks.length - 1];
          if (last) state.cursors[event.launchId] = last.seq;
        }
        for (const record of result?.processes ?? []) {
          const known = state.processes.get(record.launchId);
          if (!known || known.status !== record.status || known.port !== record.port) applyProcess(record);
        }
        setStatus("");
      } catch (error) {
        if (state.stopped) return;
        setStatus(String(error?.message ?? error), "error");
        await sleep(1500);
      }
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function refreshSnapshot() {
    try {
      applySnapshot(await invoke("deck.snapshot"));
      setStatus("");
      return true;
    } catch (error) {
      setStatus(String(error?.message ?? error), "error");
      return false;
    }
  }

  // ------------------------------------------------------------------- wiring

  el.add.addEventListener("click", () => openDialog(null));

  el.dlgCancel.addEventListener("click", closeDialog);

  // The command box is multi-line, so Enter is a newline there; Cmd/Ctrl+Enter
  // saves, which is what an editor-style box is expected to do.
  el.dlgForm.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      el.dlgForm.requestSubmit();
    }
  });

  // A click on the dimmed area (but not inside the panel) cancels the dialog.
  el.dialog.addEventListener("click", (event) => {
    if (event.target === el.dialog) closeDialog();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.dialog.hidden) {
      event.preventDefault();
      closeDialog();
    }
  });

  async function runAction(launchId, act, button) {
    if (button) button.disabled = true;
    try {
      if (act === "start") {
        const result = await invoke("deck.start", { launchId });
        setStatus("");
        // Starting something is a request to watch it: open the output panel
        // below and take it over from whichever launch was expanded before.
        await expand(launchId);
        if (result?.process) applyProcess(result.process);
      } else if (act === "stop") {
        applyProcess({ launchId, stopping: true, status: "running" });
        const result = await invoke("deck.stop", { launchId });
        if (result?.process) applyProcess(result.process);
        setStatus("");
      }
    } catch (error) {
      setStatus(`${act === "start" ? t.startFailed : t.stop}: ${error.message}`, "error");
    } finally {
      if (button) button.disabled = false;
      updateRow(launchId);
    }
  }

  el.list.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    const row = button.closest(".row");
    const launchId = row?.dataset.id;
    if (!launchId) return;
    const act = button.dataset.act;
    if (act === "expand") {
      if (state.expanded === launchId) closeDetail();
      else await expand(launchId);
      return;
    }
    if (act === "edit") {
      const launch = allLaunches().find((candidate) => candidate.id === launchId);
      if (launch) openDialog(launch);
      return;
    }
    await runAction(launchId, act, button);
  });

  // Double-clicking a row is the quick way to start it (stop while it runs).
  // The icon keeps doing the same thing.
  el.list.addEventListener("dblclick", (event) => {
    if (event.target.closest('button[data-act="start"], button[data-act="stop"], button[data-act="edit"]')) return;
    const launchId = event.target.closest(".row")?.dataset.id;
    if (!launchId) return;
    const running = state.processes.get(launchId)?.status === "running";
    runAction(launchId, running ? "stop" : "start", null);
  });

  el.detailStop.addEventListener("click", async () => {
    if (!state.expanded) return;
    try {
      const result = await invoke("deck.stop", { launchId: state.expanded });
      if (result?.process) applyProcess(result.process);
    } catch (error) {
      setStatus(String(error?.message ?? error), "error");
    }
  });

  el.detailClear.addEventListener("click", async () => {
    if (!state.expanded) return;
    try {
      await invoke("deck.clear", { launchId: state.expanded });
      state.term?.reset();
      state.cursors[state.expanded] = 0;
      applyProcess({ launchId: state.expanded, status: "exited", exitCode: null, seq: 0 });
    } catch (error) {
      setStatus(`${t.clearFailed}: ${error.message}`, "error");
    }
  });

  el.detailClose.addEventListener("click", closeDetail);

  el.dlgForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const parsed = parseEnvText(el.dlgEnv.value);
    if (parsed.error) {
      setStatus(parsed.error, "error");
      el.dlgEnv.focus();
      return;
    }
    const payload = {
      name: el.dlgName.value.trim(),
      command: el.dlgCommand.value.trim(),
      cwd: el.dlgCwd.value.trim(),
      env: parsed.env,
    };
    if (state.editing) payload.id = state.editing;
    try {
      await invoke("deck.save", payload);
      closeDialog();
      setStatus("");
      await refreshSnapshot();
    } catch (error) {
      setStatus(`${t.saveFailed}: ${error.message}`, "error");
    }
  });

  el.dlgDelete.addEventListener("click", async () => {
    const launch = allLaunches().find((candidate) => candidate.id === state.editing);
    if (!launch) return;
    if (!window.confirm(t.confirmDelete(launch.name))) return;
    try {
      await invoke("deck.delete", { launchId: launch.id });
      if (state.expanded === launch.id) closeDetail();
      closeDialog();
      await refreshSnapshot();
    } catch (error) {
      setStatus(`${t.deleteFailed}: ${error.message}`, "error");
    }
  });

  // -------------------------------------------------------------- appearance

  // The page is a separate webContents: the host's CSS never reaches it, and an
  // embedded view has no `pi-plugin-panel-chrome` element (nor any
  // `--pi-plugin-panel-theme` variable), so theme and locale come from the host
  // API. See AGENTS.md §1 and §2 for why those are the only valid signals.
  function mediaTheme() {
    return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
  }

  function applyTheme(base) {
    const theme = base === "light" || base === "dark" ? base : mediaTheme();
    if (document.documentElement.dataset.theme === theme) return;
    document.documentElement.dataset.theme = theme;
    if (state.term) state.term.options.theme = termTheme();
  }

  function applyStrings() {
    for (const node of document.querySelectorAll("[data-i18n]")) {
      const value = t[node.dataset.i18n];
      if (typeof value === "string") node.textContent = value;
    }
    el.add.title = t.add;
    el.detailStop.title = t.stop;
    el.detailClear.title = t.clearOutput;
    el.detailClose.title = t.close;
    el.dlgName.placeholder = t.namePlaceholder;
    el.dlgCwd.placeholder = t.cwdPlaceholder;
    el.dlgEnv.placeholder = t.envPlaceholder;
    // The editor's title is set when it opens, so a language switch while it is
    // open has to refresh it too.
    if (!el.dialog.hidden) el.dlgTitle.textContent = state.editing ? t.dialogEdit : t.dialogNew;
  }

  // Chinese for zh*, English for everything else — no third branch.
  function applyLocale(locale) {
    const tag = locale || navigator.language || "en";
    document.documentElement.lang = tag;
    const next = tag.replaceAll("_", "-").toLowerCase().startsWith("zh") ? "zh" : "en";
    if (next === lang) return;
    lang = next;
    t = STRINGS[lang];
    applyStrings();
    render();
    if (state.expanded) {
      const launch = allLaunches().find((candidate) => candidate.id === state.expanded);
      if (launch) el.detailCmd.textContent = launch.command;
    }
  }

  function applyAppearance(appearance) {
    if (appearance && typeof appearance === "object") state.appearance = appearance;
    applyTheme(appearance?.base);
    applyLocale(appearance?.locale);
  }

  window.addEventListener("beforeunload", () => {
    state.stopped = true;
  });

  (async function start() {
    // Paint the right side first (system appearance), then let the host correct
    // it. Waiting for the bridge would leave the tab dark for a frame.
    applyAppearance(null);
    bridge?.on?.("appearance:changed", applyAppearance);
    bridge?.invoke?.("app.getAppearance")
      .then(applyAppearance)
      .catch(() => applyAppearance(null));
    // Only used when the bridge could not answer, e.g. the preview pane.
    window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener?.("change", () => {
      if (!state.appearance) applyTheme(null);
    });

    if (!bridge?.invoke) {
      setStatus(t.bridgeMissing, "error");
      return;
    }
    // Switching project changes which launches are listed; the host tells the
    // view too, so the list does not have to wait for the next refresh.
    bridge.on?.("workspace:changed", (event) => {
      // Close first, and only when the project really changed: the host can
      // re-emit this event for the same project, and killing an open editor
      // mid-typing would be worse than the frame the snapshot costs.
      const next = typeof event?.path === "string" ? event.path : null;
      if (next && next !== state.workspacePath) closeDialog();
      refreshSnapshot();
    });
    await refreshSnapshot();
    pollLoop();
    // The workspace (and therefore the project's launch list) can change while
    // this tab stays open, so re-read the snapshot now and then.
    setInterval(() => {
      if (state.stopped) return;
      refreshSnapshot();
    }, 20000);
  })();
})();

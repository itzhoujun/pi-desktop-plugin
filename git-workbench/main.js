"use strict";

/**
 * Git Workbench — PI-Desktop plugin entry.
 *
 * Plugin id : local.git-workbench
 * View      : work-panel view "changes" (contributes.views)
 * Channels  : git.state / git.diff / git.stage / git.unstage / git.stageAll /
 *             git.unstageAll / git.discard / git.commit / git.pull / git.push /
 *             git.generateMessage
 *
 * Design notes
 * - All git access lives in ./git.js: spawn("git", [...]) with argument
 *   arrays against the repository root resolved from the open workspace.
 * - Commit messages are written with `git commit -F -` over stdin, so no
 *   message text ever becomes a command argument.
 * - "Generate message" uses the host's one-shot completion API
 *   (pi.models.list + pi.agent.complete) and only sees the diff of the
 *   changes being committed — never the chat transcript.
 *
 * Permissions
 * - ui.view          the work-panel view
 * - models.list      list the user's ready models for the picker
 * - agent.complete   generate the commit message
 */

const path = require("node:path");
const git = require("./git");

const MAX_PATHS = 500;
const MAX_PROMPT_DIFF_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 8_000;

const TEXT = {
  en: {
    noWorkspace: "Open a project folder first.",
    notARepo: "The open folder is not a git repository.",
    nothingToCommit: "There are no changes to commit.",
    noModel: "Configure a model in Settings → Models first.",
  },
  "zh-CN": {
    noWorkspace: "请先打开一个项目文件夹。",
    notARepo: "当前文件夹不是 git 仓库。",
    nothingToCommit: "没有可提交的改动。",
    noModel: "请先在“设置 → 模型”中配置一个模型。",
  },
};

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isZh(locale) {
  return String(locale || "").toLowerCase().startsWith("zh");
}

async function hostLocale() {
  try {
    if (typeof pi.app?.getLocale === "function") {
      return await pi.app.getLocale();
    }
  } catch {
    /* older hosts */
  }
  try {
    const active = await pi.session?.getActive?.();
    if (active && active.locale) return active.locale;
  } catch {
    /* ignore */
  }
  return "en";
}

async function strings() {
  return isZh(await hostLocale()) ? TEXT["zh-CN"] : TEXT.en;
}

function requirePaths(payload, { allowEmpty = false } = {}) {
  const list = Array.isArray(payload?.paths) ? payload.paths : [];
  if (!allowEmpty && list.length === 0) {
    throw fail("INVALID_ARGUMENT", "No files were given.");
  }
  if (list.length > MAX_PATHS) {
    throw fail("INVALID_ARGUMENT", `At most ${MAX_PATHS} files per call.`);
  }
  return list.map((entry) => {
    const filePath = String(entry ?? "");
    if (!git.isSafeRelativePath(filePath)) {
      throw fail("INVALID_ARGUMENT", `Not a repository-relative path: ${filePath}`);
    }
    return filePath;
  });
}

async function repoContext() {
  const workspace = await pi.workspace.get();
  if (!workspace || !workspace.path) {
    throw fail("NO_WORKSPACE", (await strings()).noWorkspace);
  }
  const root = await git.resolveRepoRoot(workspace.path);
  if (!root) {
    throw fail("NOT_A_REPO", (await strings()).notARepo);
  }
  return { workspace, root };
}

async function readState() {
  let workspace = null;
  try {
    workspace = await pi.workspace.get();
  } catch {
    workspace = null;
  }
  if (!workspace || !workspace.path) {
    return { ok: true, repo: null, reason: "NO_WORKSPACE" };
  }

  let root = null;
  try {
    root = await git.resolveRepoRoot(workspace.path);
  } catch {
    root = null;
  }
  if (!root) {
    return {
      ok: true,
      repo: null,
      reason: "NOT_A_REPO",
      workspace: { path: workspace.path, name: workspace.name || path.basename(workspace.path) },
    };
  }

  const status = await git.status(root);
  const groups = git.buildFileGroups(status);
  const staged = groups.staged;
  const changes = groups.changes;

  return {
    ok: true,
    repo: { root, name: path.basename(root) },
    workspace: { path: workspace.path, name: workspace.name || path.basename(workspace.path) },
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    gone: status.gone,
    detached: status.detached,
    lastCommit: await git.headCommit(root),
    staged,
    changes,
    counts: { staged: staged.length, changes: changes.length, total: staged.length + changes.length },
    clean: staged.length === 0 && changes.length === 0,
    hasConflicts: changes.some((entry) => entry.conflict),
  };
}

// ---------------------------------------------------------------------------
// LLM commit message
// ---------------------------------------------------------------------------

function buildPrompt(state, diffText, statText, untracked, recent, language) {
  const describe = (entry) =>
    `${entry.letter}  ${entry.path}${entry.origPath ? ` (was ${entry.origPath})` : ""}`;

  const files = [
    ...state.staged.map(describe),
    ...state.changes.map(describe),
  ];

  const sections = [
    `Branch: ${state.branch || "(detached HEAD)"}`,
    "",
    "Changed files:",
    ...files.slice(0, 200),
  ];

  if (statText) {
    sections.push("", "Diffstat:", statText);
  }
  if (untracked.length > 0) {
    sections.push("", "Untracked (new) files:", ...untracked.slice(0, 50));
  }
  if (recent.length > 0) {
    sections.push("", "Recent commit subjects (match this style, do not copy):", ...recent.map((line) => `- ${line}`));
  }

  const trimmedDiff =
    diffText.length > MAX_PROMPT_DIFF_CHARS
      ? `${diffText.slice(0, MAX_PROMPT_DIFF_CHARS)}\n… (diff truncated)`
      : diffText;

  sections.push("", "Diff:", "```diff", trimmedDiff || "(no textual diff)", "```");

  return [
    sections.join("\n"),
    "",
    `Write the ${language === "简体中文" ? "提交信息" : "commit message"} for exactly these changes.`,
  ].join("\n");
}

function cleanCompletion(text) {
  let value = String(text || "").trim();
  value = value.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```\s*$/m, "");
  value = value.replace(/^(commit message|提交信息)\s*[:：]\s*/i, "");
  value = value.replace(/^["'`](.*)["'`]$/s, "$1").trim();
  if (value.length > MAX_MESSAGE_CHARS) value = value.slice(0, MAX_MESSAGE_CHARS).trim();
  return value;
}

async function generateMessage() {
  const messages = await strings();
  const { root } = await repoContext();
  const status = await git.status(root);
  const groups = git.buildFileGroups(status);
  if (groups.staged.length === 0 && groups.changes.length === 0) {
    throw fail("NOTHING_TO_COMMIT", messages.nothingToCommit);
  }

  const useStaged = groups.staged.length > 0;
  const mode = useStaged ? "staged" : "worktree";
  const [diffText, statText, recent] = await Promise.all([
    git.diffForCommit(root, mode).catch(() => ""),
    git.diffStat(root, mode).catch(() => ""),
    git.recentSubjects(root, 8),
  ]);
  const untracked = groups.changes.filter((entry) => entry.untracked).map((entry) => entry.path);
  const language = isZh(await hostLocale()) ? "简体中文" : "English";

  const models = await pi.models.list();
  const model = models.find((item) => item.isDefault) ?? models[0];
  if (!model) throw fail("NO_MODEL", messages.noModel);

  const state = {
    branch: status.branch,
    staged: groups.staged,
    changes: groups.changes,
  };

  const system = [
    "You write Git commit messages for a developer who is about to commit.",
    `Reply in ${language}.`,
    "Only output the commit message: no code fences, no quotes, no explanation, no trailing notes.",
    "First line: imperative subject, at most 72 characters, Conventional Commits format `type(scope): summary`.",
    "If the change is not trivial, add one blank line and at most four bullet points describing what and why.",
    "Use only facts visible in the diff; never invent files, features, or issue numbers.",
  ].join("\n");

  const user = buildPrompt(state, diffText, statText, untracked, recent, language);

  let completion;
  try {
    completion = await pi.agent.complete({
      modelKey: model.key,
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (error) {
    const code = error?.errorCode || error?.code || "AGENT_FAILED";
    throw fail(code, `生成提交信息失败：${error?.message || "未知错误"}`);
  }

  const message = cleanCompletion(completion?.text);
  if (!message) throw fail("EMPTY_COMPLETION", "模型没有返回内容，请重试。");

  return {
    ok: true,
    message,
    modelKey: model.key,
    basedOn: useStaged ? "staged" : "all",
    files: groups.staged.length + groups.changes.length,
  };
}

// ---------------------------------------------------------------------------
// panel bridge
// ---------------------------------------------------------------------------

async function onPanelInvoke(channel, payload) {
  const input = payload && typeof payload === "object" ? payload : {};

  switch (channel) {
    case "git.state":
      return readState();

    case "git.diff": {
      const [filePath] = requirePaths({ paths: [input.path] });
      const { root } = await repoContext();
      const status = await git.status(root);
      const groups = git.buildFileGroups(status);
      const entry =
        groups.staged.find((item) => item.path === filePath && Boolean(input.staged)) ||
        groups.changes.find((item) => item.path === filePath) ||
        groups.staged.find((item) => item.path === filePath) ||
        null;
      if (!entry) throw fail("NOT_FOUND", `${filePath} 不在当前改动中。`);
      const result = await git.fileDiff(root, filePath, Boolean(input.staged), entry);
      return {
        ok: true,
        path: filePath,
        staged: Boolean(input.staged),
        untracked: result.untracked,
        conflict: Boolean(entry.conflict),
        patch: result.patch,
      };
    }

    case "git.stage": {
      const { root } = await repoContext();
      await git.stage(root, requirePaths(input));
      return { ok: true, state: await readState() };
    }

    case "git.stageAll": {
      const { root } = await repoContext();
      await git.stageAll(root);
      return { ok: true, state: await readState() };
    }

    case "git.unstage": {
      const { root } = await repoContext();
      await git.unstage(root, requirePaths(input));
      return { ok: true, state: await readState() };
    }

    case "git.unstageAll": {
      const { root } = await repoContext();
      await git.unstageAll(root);
      return { ok: true, state: await readState() };
    }

    case "git.discard": {
      const { root } = await repoContext();
      await git.discard(root, requirePaths(input));
      return { ok: true, state: await readState() };
    }

    case "git.commit": {
      const { root } = await repoContext();
      if (input.stageAll === true) {
        await git.stageAll(root);
      }
      const result = await git.commit(root, input.message, {
        signOff: input.signOff === true,
        amend: input.amend === true,
      });
      let pushOutput = null;
      if (input.push === true) {
        pushOutput = (await git.push(root)).output;
      }
      return {
        ok: true,
        output: result.output,
        commit: result.commit,
        pushOutput,
        state: await readState(),
      };
    }

    case "git.pull": {
      const { root } = await repoContext();
      const result = await git.pull(root);
      return { ok: true, output: result.output, branch: result.branch, state: await readState() };
    }

    case "git.push": {
      const { root } = await repoContext();
      const result = await git.push(root);
      return { ok: true, output: result.output, state: await readState() };
    }

    case "git.generateMessage":
      return generateMessage();

    default:
      throw fail("UNSUPPORTED", `Unsupported channel: ${channel}`);
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function registerCommands() {
  const zh = isZh(await hostLocale());
  const title = (en, cn) => (zh ? cn : en);

  await pi.commands.register({
    id: "git-workbench.open",
    title: title("Git Workbench: Open", "Git Workbench：打开"),
    keywords: ["git", "commit", "push", "pull", "提交", "推送", "拉取"],
    run: async () => {
      try {
        await pi.ui.revealView({ viewId: "changes" });
      } catch (error) {
        await pi.ui.showToast(error?.message || "请先在对话中打开右侧工作面板").catch(() => {});
      }
    },
  });

  await pi.commands.register({
    id: "git-workbench.pull",
    title: title("Git Workbench: Pull", "Git Workbench：拉取"),
    keywords: ["git", "pull", "拉取", "更新"],
    run: async () => {
      const { root } = await repoContext();
      const result = await git.pull(root);
      await pi.ui.showToast(result.output || "已是最新").catch(() => {});
      await pi.ui.revealView({ viewId: "changes" }).catch(() => {});
    },
  });

  await pi.commands.register({
    id: "git-workbench.push",
    title: title("Git Workbench: Push", "Git Workbench：推送"),
    keywords: ["git", "push", "推送", "上传"],
    run: async () => {
      const { root } = await repoContext();
      const result = await git.push(root);
      await pi.ui.showToast(result.output || "已推送").catch(() => {});
    },
  });
}

async function onLoad() {
  await registerCommands();
}

async function onUnload() {
  const ids = ["git-workbench.open", "git-workbench.pull", "git-workbench.push"];
  await Promise.all(ids.map((id) => pi.commands.unregister(id).catch(() => {})));
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  __test: { cleanCompletion, buildPrompt, readState, requirePaths },
};

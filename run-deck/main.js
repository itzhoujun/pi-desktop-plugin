"use strict";

/**
 * Run Deck — plugin entry.
 *
 * The current project's launch commands, one click away, inside the main
 * window: configure them, start and stop them, watch their output.
 *
 * Surfaces:
 *   - work-panel view (contributes.views, opened from the work panel itself)
 *   - agent tools   run_deck_list / run_deck_create / run_deck_update / run_deck_delete
 *
 * Storage is per project and lives in the plugin's private data directory,
 * which the host hands out through `pi.plugin.getDataPath()`; nothing is
 * written into the workspace and no browser storage is used.
 */

const os = require("node:os");
const path = require("node:path");

const { LaunchStore, StoreError, cleanWorkspace } = require("./lib/store");
const { Runner } = require("./lib/runner");

const TOOL_NAMES = ["run_deck_list", "run_deck_create", "run_deck_update", "run_deck_delete"];

let dataDir = null;
let store = null;
let runner = null;

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

async function currentWorkspace() {
  try {
    const result = await pi.workspace.get();
    return cleanWorkspace(result?.workspace?.path ?? result?.path ?? null);
  } catch {
    return null;
  }
}

function requireRuntime() {
  if (!store || !runner) throw new StoreError("Run Deck is still starting up");
}

/**
 * The directory a launch runs in: its own `cwd` (with `~` and relative paths
 * resolved), else the project it belongs to, else the open workspace, else home.
 */
async function cwdFor(found) {
  const workspace = found?.workspace ?? (await currentWorkspace());
  const override = typeof found?.launch?.cwd === "string" ? found.launch.cwd.trim() : "";
  if (!override) return workspace || process.env.HOME || process.cwd();
  const expanded =
    override === "~" || override.startsWith("~/") ? path.join(os.homedir(), override.slice(1)) : override;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(workspace || process.cwd(), expanded);
}

function decode(error) {
  if (error instanceof StoreError || error?.code === "INVALID") {
    return fail("INVALID", error.message);
  }
  return fail(error?.code || "ERROR", String(error?.message ?? error));
}

async function deckSnapshot() {
  requireRuntime();
  const workspace = await currentWorkspace();
  const lists = store.list(workspace);
  return {
    ok: true,
    workspacePath: workspace,
    workspaceName: workspace ? workspace.split("/").filter(Boolean).pop() : null,
    launches: lists.launches,
    ...runner.snapshot(),
    environment: runner.environmentSummary(),
  };
}

async function deckStart(launchId) {
  requireRuntime();
  const found = store.find(launchId);
  if (!found) return fail("NOT_FOUND", "that launch no longer exists");
  const cwd = await cwdFor(found);
  // First click may land before the probe finished; this resolves in µs once done.
  await runner.warmEnvironment();
  return runner.start(found.launch, cwd);
}

/**
 * The page only ever reaches the plugin through the host's panel bridge, which
 * forwards unknown channels here. Every answer must come back inside the host's
 * 30 s channel budget, so `deck.poll` caps its own wait at 10 s.
 */
async function onPanelInvoke(channel, payload) {
  try {
    switch (channel) {
      case "deck.snapshot":
        return await deckSnapshot();
      case "deck.poll":
        requireRuntime();
        return await runner.poll(payload?.cursors ?? {}, payload?.waitMs ?? 8000);
      case "deck.output":
        requireRuntime();
        return runner.output(String(payload?.launchId ?? ""));
      case "deck.start":
        return await deckStart(String(payload?.launchId ?? ""));
      case "deck.stop":
        requireRuntime();
        return await runner.stop(String(payload?.launchId ?? ""));
      case "deck.clear":
        requireRuntime();
        return runner.clear(String(payload?.launchId ?? ""));
      case "deck.save": {
        requireRuntime();
        const workspace = await currentWorkspace();
        const id = typeof payload?.id === "string" && payload.id ? payload.id : null;
        const input = { name: payload?.name, command: payload?.command };
        if (payload?.cwd !== undefined) input.cwd = payload.cwd;
        if (payload?.env !== undefined) input.env = payload.env;
        const saved = id ? store.update(id, input) : store.create(input, workspace);
        return { ok: true, ...saved, workspacePath: workspace };
      }
      case "deck.delete": {
        requireRuntime();
        const id = String(payload?.launchId ?? "");
        const record = runner.record(id);
        if (record && record.status === "running") {
          return fail("RUNNING", "stop this launch before deleting it");
        }
        runner.clear(id);
        return { ok: true, ...store.remove(id) };
      }
      default:
        return fail("UNKNOWN_CHANNEL", `unknown channel: ${channel}`);
    }
  } catch (error) {
    return decode(error);
  }
}

function toolList() {
  return {
    name: "run_deck_list",
    description:
      "List this project's Run Deck launch commands (the start/stop commands it keeps). Project-scoped: another project has its own list.",
    risk: "low",
    schema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const snapshot = await deckSnapshot();
      return {
        ok: true,
        workspacePath: snapshot.workspacePath,
        launches: snapshot.launches.map(({ id, name, command, cwd, env }) => ({
          id,
          name,
          command,
          ...(cwd ? { cwd } : {}),
          ...(env ? { env } : {}),
        })),
        running: snapshot.running,
      };
    },
  };
}

function toolCreate() {
  return {
    name: "run_deck_create",
    description:
      "Add a launch command to this project's Run Deck list. The user writes the shell command themselves; it runs with a login shell in the project directory, or in the launch's own cwd.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short label shown in the tab, e.g. 'Web dev server'" },
        command: { type: "string", description: "The shell command to run, e.g. 'npm run dev'" },
        cwd: {
          type: "string",
          description:
            "Optional working directory: '~', an absolute path, or a path relative to the project root. Defaults to the project root.",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional environment overrides, e.g. {\"ENABLE_SCHEDULER\": \"False\"}",
        },
      },
      required: ["name", "command"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const workspace = await currentWorkspace();
      const created = store.create(
        { name: args?.name, command: args?.command, cwd: args?.cwd, env: args?.env },
        workspace,
      );
      return { ok: true, id: created.launch.id, name: created.launch.name, workspacePath: created.workspace };
    },
  };
}

function toolUpdate() {
  return {
    name: "run_deck_update",
    description: "Change a Run Deck launch: its label, command, working directory or environment.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Launch id from run_deck_list" },
        name: { type: "string", description: "New label, if it should change" },
        command: { type: "string", description: "New shell command, if it should change" },
        cwd: {
          type: "string",
          description:
            "Working directory override: '~', an absolute path, or a path relative to the project root. Pass an empty string to fall back to the project root.",
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Environment overrides, e.g. {\"ENABLE_SCHEDULER\": \"False\"}. Pass {} to clear them.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const input = { name: args?.name, command: args?.command };
      if (args?.cwd !== undefined) input.cwd = args.cwd;
      if (args?.env !== undefined) input.env = args.env;
      const updated = store.update(String(args?.id ?? ""), input);
      return { ok: true, launch: updated.launch };
    },
  };
}

function toolDelete() {
  return {
    name: "run_deck_delete",
    description: "Remove a launch from Run Deck. A running launch must be stopped first.",
    risk: "medium",
    schema: {
      type: "object",
      properties: { id: { type: "string", description: "Launch id from run_deck_list" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const id = String(args?.id ?? "");
      const record = runner.record(id);
      if (record && record.status === "running") {
        throw Object.assign(new Error("this launch is still running; stop it first"), { code: "RUNNING" });
      }
      runner.clear(id);
      const removed = store.remove(id);
      return { ok: true, id: removed.launch.id, name: removed.launch.name };
    },
  };
}

async function onLoad() {
  dataDir = await pi.plugin.getDataPath();
  store = new LaunchStore(dataDir);
  store.load();
  runner = new Runner({ dataDir });

  // Ask the user's login shell for its PATH in the background: a GUI-launched
  // app inherits launchd's minimal PATH, so uv/cargo/nvm/asdf installed the
  // usual way are invisible until we do. Not awaited, so a slow rc cannot
  // delay the plugin load; `deck.start` waits for it if a click beats it.
  runner.warmEnvironment();

  // A previous session may have left dev servers behind. Reporting them is
  // honest; killing the pids is not, because a pid can be reused by then.
  const orphans = runner.loadOrphanHints().filter((entry) => Number.isInteger(entry?.pid));
  if (orphans.length > 0) {
    runner.persistRuns();
    const names = orphans.map((entry) => `${entry.name ?? entry.launchId} (pid ${entry.pid})`).join(", ");
    await pi.ui
      .showToast(`Run Deck: ${orphans.length} process(es) left over from a previous session — ${names}`, "warn")
      .catch(() => {});
    runner.orphans = [];
  }

  for (const tool of [toolList(), toolCreate(), toolUpdate(), toolDelete()]) {
    await pi.agent.registerTool(tool);
  }
}

async function onUnload() {
  for (const name of TOOL_NAMES) {
    await pi.agent.unregisterTool(name).catch(() => {});
  }
  // Children are detached process groups, so shutdown has to be explicit.
  await runner?.stopAll().catch(() => {});
  runner = null;
  store = null;
}

module.exports = { onLoad, onUnload, onPanelInvoke };

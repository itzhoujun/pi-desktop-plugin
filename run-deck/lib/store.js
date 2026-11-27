"use strict";

/**
 * Launch storage.
 *
 * One JSON file inside the plugin's private data directory — the directory the
 * host hands out through `pi.plugin.getDataPath()`. Nothing here is written into
 * the workspace, and no browser storage (localStorage / IndexedDB) is used:
 * the host owns plugin data, so the plugin owns exactly this file.
 *
 *   { "version": 3, "projects": { "<workspace realpath>": [Launch] } }
 *
 * Launch = { id, name, command, cwd?, env?, createdAt, updatedAt }
 *
 *   cwd  optional; `~`, absolute, or relative to the project root
 *   env  optional; a flat { KEY: "value" } map
 *
 * A launch belongs to one project only; there is no shared list.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STORE_VERSION = 3;
const MAX_NAME = 60;
const MAX_COMMAND = 2000;
const MAX_CWD = 500;
const MAX_ENV_ENTRIES = 32;
const MAX_ENV_KEY = 64;
const MAX_ENV_VALUE = 2000;
const MAX_PER_PROJECT = 40;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

class StoreError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID";
  }
}

function emptyStore() {
  return { version: STORE_VERSION, projects: {} };
}

function cleanName(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new StoreError("name is required");
  if (text.length > MAX_NAME) throw new StoreError(`name must be at most ${MAX_NAME} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new StoreError("name must be a single line");
  return text;
}

function cleanCommand(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new StoreError("command is required");
  if (text.length > MAX_COMMAND) throw new StoreError(`command must be at most ${MAX_COMMAND} characters`);
  if (text.includes("\u0000")) throw new StoreError("command must not contain NUL");
  return text;
}

/** `null` clears the override and means "the project root". */
function cleanCwd(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length > MAX_CWD) throw new StoreError(`working directory must be at most ${MAX_CWD} characters`);
  if (/[\u0000\n\r]/.test(text)) throw new StoreError("working directory must be a single line");
  return text;
}

/**
 * A flat string map, so it reaches `spawn` unchanged. Keys must be shell-safe
 * identifiers; values are passed verbatim (that is the point of the field).
 */
function cleanEnv(value) {
  if (value === undefined || value === null) return null;
  const source = typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source) throw new StoreError("env must be an object of KEY: value pairs");
  const entries = Object.entries(source);
  if (entries.length > MAX_ENV_ENTRIES) {
    throw new StoreError(`env must have at most ${MAX_ENV_ENTRIES} entries`);
  }
  const out = {};
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey).trim();
    if (!ENV_KEY_PATTERN.test(key) || key.length > MAX_ENV_KEY) {
      throw new StoreError(`env key "${key}" must match ${ENV_KEY_PATTERN}`);
    }
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") {
      throw new StoreError(`env value for ${key} must be a string`);
    }
    const text = String(rawValue);
    if (text.length > MAX_ENV_VALUE) {
      throw new StoreError(`env value for ${key} must be at most ${MAX_ENV_VALUE} characters`);
    }
    if (text.includes("\u0000")) throw new StoreError(`env value for ${key} must not contain NUL`);
    out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Best-effort version of cleanCwd for data already on disk. */
function normalizeCwd(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > MAX_CWD) return null;
  return /[\u0000\n\r]/.test(text) ? null : text;
}

/** Best-effort version of cleanEnv for data already on disk. */
function normalizeEnv(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(raw).slice(0, MAX_ENV_ENTRIES)) {
    const key = String(rawKey).trim();
    if (!ENV_KEY_PATTERN.test(key)) continue;
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") continue;
    const text = String(rawValue).slice(0, MAX_ENV_VALUE);
    if (text.includes("\u0000")) continue;
    out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Workspace paths key the project sections, so they must be stable and unique. */
function cleanWorkspace(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  let resolved = text;
  try {
    resolved = fs.realpathSync(text);
  } catch {
    /* keep the given path when it cannot be resolved (not created yet) */
  }
  return resolved.replace(/\/+$/, "") || "/";
}

function normalizeLaunch(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!id || !name || !command) return null;
  const launch = {
    id,
    name: name.slice(0, MAX_NAME),
    command: command.slice(0, MAX_COMMAND),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
  const cwd = normalizeCwd(raw.cwd);
  if (cwd) launch.cwd = cwd;
  const env = normalizeEnv(raw.env);
  if (env) launch.env = env;
  return launch;
}

class LaunchStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "launches.json");
    this.data = emptyStore();
    this.loaded = false;
  }

  load() {
    this.data = emptyStore();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      // Older shapes: v1 kept a shared list, v2 predates cwd/env. Both are copied
      // aside once (per version) before the file is rewritten in the current one.
      if (typeof parsed?.version === "number" && parsed.version < STORE_VERSION) {
        this.backup(parsed.version);
      }
      const projects = parsed?.projects && typeof parsed.projects === "object" ? parsed.projects : {};
      for (const [key, list] of Object.entries(projects)) {
        if (!Array.isArray(list)) continue;
        const workspace = cleanWorkspace(key);
        if (!workspace) continue;
        this.data.projects[workspace] = list.map(normalizeLaunch).filter(Boolean);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Keep the broken file for inspection instead of silently dropping it.
        try {
          fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`);
        } catch {
          /* best effort */
        }
      }
    }
    this.loaded = true;
    return this.data;
  }

  /** One copy per old version, never overwritten, so a field is never lost blind. */
  backup(version) {
    const target = `${this.file}.v${version}-backup`;
    try {
      if (!fs.existsSync(target)) fs.copyFileSync(this.file, target);
    } catch {
      /* best effort: every project list still migrates */
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, this.file);
  }

  ensureLoaded() {
    if (!this.loaded) this.load();
  }

  list(workspace) {
    this.ensureLoaded();
    const launches = workspace ? this.data.projects[workspace] ?? [] : [];
    return { launches: launches.map((launch) => ({ ...launch })), hasWorkspace: Boolean(workspace) };
  }

  /** Every launch id that currently exists, in any project. */
  ids() {
    this.ensureLoaded();
    const all = new Set();
    for (const list of Object.values(this.data.projects)) {
      for (const launch of list) all.add(launch.id);
    }
    return all;
  }

  find(id) {
    this.ensureLoaded();
    if (typeof id !== "string" || !id) return null;
    for (const [workspace, list] of Object.entries(this.data.projects)) {
      const hit = list.find((launch) => launch.id === id);
      if (hit) return { launch: hit, workspace };
    }
    return null;
  }

  create(input, workspace) {
    this.ensureLoaded();
    if (!workspace) throw new StoreError("open a project before adding a launch");
    const name = cleanName(input?.name);
    const command = cleanCommand(input?.command);
    const cwd = cleanCwd(input?.cwd);
    const env = cleanEnv(input?.env);
    const list = (this.data.projects[workspace] ??= []);
    if (list.length >= MAX_PER_PROJECT) throw new StoreError(`this project already has ${MAX_PER_PROJECT} launches`);
    const now = Date.now();
    const launch = { id: crypto.randomUUID(), name, command };
    if (cwd) launch.cwd = cwd;
    if (env) launch.env = env;
    launch.createdAt = now;
    launch.updatedAt = now;
    list.push(launch);
    this.persist();
    return { launch: { ...launch }, workspace };
  }

  update(id, input) {
    this.ensureLoaded();
    const found = this.find(id);
    if (!found) throw new StoreError(`no launch with id ${id}`);
    const { launch } = found;
    if (input?.name !== undefined) launch.name = cleanName(input.name);
    if (input?.command !== undefined) launch.command = cleanCommand(input.command);
    if (input?.cwd !== undefined) {
      const cwd = cleanCwd(input.cwd);
      if (cwd) launch.cwd = cwd;
      else delete launch.cwd;
    }
    if (input?.env !== undefined) {
      const env = cleanEnv(input.env);
      if (env) launch.env = env;
      else delete launch.env;
    }
    launch.updatedAt = Date.now();
    this.persist();
    return { launch: { ...launch }, workspace: found.workspace };
  }

  remove(id) {
    this.ensureLoaded();
    const found = this.find(id);
    if (!found) throw new StoreError(`no launch with id ${id}`);
    const list = this.data.projects[found.workspace] ?? [];
    this.data.projects[found.workspace] = list.filter((launch) => launch.id !== id);
    if (this.data.projects[found.workspace].length === 0) delete this.data.projects[found.workspace];
    this.persist();
    return { launch: found.launch, workspace: found.workspace };
  }
}

module.exports = {
  LaunchStore,
  StoreError,
  cleanWorkspace,
  cleanCwd,
  cleanEnv,
  STORE_VERSION,
  MAX_PER_PROJECT,
  MAX_ENV_ENTRIES,
};

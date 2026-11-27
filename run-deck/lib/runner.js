"use strict";

/**
 * Process runtime.
 *
 * v0.1 is deliberately pipe-only: no PTY, so the child sees pipes for stdout and
 * stderr. That costs us isatty-driven progress bars and full-screen TUIs, and it
 * buys a backend that works identically on macOS, Linux and Windows with no
 * native module and no ABI coupling to the host's Electron. `TermBackend` is the
 * seam a PTY implementation can plug into later without touching callers.
 *
 * Colour is re-enabled explicitly, because most tools disable it on a pipe.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_CONCURRENT = 8;
const MAX_CHUNKS = 1500;
const MAX_CHARS = 200_000;
const MAX_CHUNK_CHARS = 16_000;
const POLL_MAX_WAIT_MS = 10_000;
const POLL_MAX_CHUNKS_PER_PROCESS = 400;

const PORT_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i;
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SHELL_PATH_MARKER = "__PI_RUN_DECK_PATH__";
const SHELL_PROBE_TIMEOUT_MS = 5000;
const SHELL_PROBE_MAX_CHARS = 200_000;
// Only shells we know how to ask for $PATH. `ulimit`-style POSIX shells print a
// colon-separated string; fish keeps a list and needs joining.
const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "yash", "posh"]);

let environment = null; // the environment every child process gets
let environmentProbe = null; // one shared in-flight/settled warm-up
let environmentSource = "inherited";
let environmentShell = null;

function baseEnvironment() {
  return {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
    CLICOLOR_FORCE: "1",
    PYTHONUNBUFFERED: "1",
    // Keep the child from inheriting anything that would make output appear
    // buffered or block-based when it is not attached to a terminal.
    NODE_DISABLE_COLORS: "",
  };
}

/**
 * The environment every child gets.
 *
 * A GUI-launched app inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
 * and a login shell (`-lc`) only reads `.zshenv` / `.zprofile` / `.zlogin`. So
 * everything a user adds in `.zshrc` — `~/.local/bin` (where the official uv
 * installer puts `uv`), `~/.cargo/bin`, nvm, asdf, pyenv, pnpm — is missing, and
 * those tools report "command not found" even though they work in a terminal.
 *
 * Guessing a list of well-known directories would fail for the next tool, so we
 * ask the user's own login shell instead: one bounded `-ilc` probe per plugin
 * load, sentinel-marked so rc-file chatter cannot corrupt it. The result is
 * prepended to the inherited PATH (the host's entries stay reachable) and the
 * probe falls back to the inherited PATH if the rc hangs or prints nothing.
 */
function probeScriptFor(shell) {
  const name = path.basename(String(shell || "")).toLowerCase();
  if (name.startsWith("fish")) {
    return `printf '\\n${SHELL_PATH_MARKER}%s\\n' (string join : $PATH)`;
  }
  if (!POSIX_SHELLS.has(name)) return null;
  return `printf '\\n${SHELL_PATH_MARKER}%s\\n' "$PATH"`;
}

function stopProbe(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // The probe is spawned detached, so kill the whole group.
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function probeShellPath(shell) {
  const script = probeScriptFor(shell);
  if (!script) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = "";
    let child = null;
    let timer = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      stopProbe(child);
      resolve(value);
    };
    try {
      child = spawn(shell, ["-ilc", script], {
        env: process.env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return resolve(null);
    }
    timer = setTimeout(() => finish(null), SHELL_PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (text) => {
      out += text;
      if (out.length > SHELL_PROBE_MAX_CHARS) finish(null);
    });
    child.on("close", () => {
      // rc files may print banners; the sentinel marks the real answer.
      const index = out.lastIndexOf(SHELL_PATH_MARKER);
      if (index === -1) return finish(null);
      const value = out.slice(index + SHELL_PATH_MARKER.length).split("\n")[0].trim();
      finish(value || null);
    });
  });
}

/** Probe PATH first, inherited PATH second, no duplicates. */
function mergePath(preferred, inherited) {
  const seen = new Set();
  const merged = [];
  for (const part of `${preferred || ""}${path.delimiter}${inherited || ""}`.split(path.delimiter)) {
    const entry = part.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(path.delimiter);
}

async function resolveEnvironment() {
  const base = baseEnvironment();
  const inherited = base.PATH ?? base.Path ?? "";
  environmentShell = process.env.SHELL || null;
  const probed = process.platform === "win32" ? null : await probeShellPath(environmentShell || "/bin/zsh");
  if (probed) {
    base.PATH = mergePath(probed, inherited);
    environmentSource = "login-shell";
  } else {
    environmentSource = "inherited";
  }
  environment = base;
  return environment;
}

/** Resolve once per plugin load; safe to call from anywhere, never throws. */
function warmEnvironment() {
  if (!environmentProbe) {
    environmentProbe = resolveEnvironment().catch(() => {
      environment = environment ?? baseEnvironment();
      environmentSource = "inherited";
      return environment;
    });
  }
  return environmentProbe;
}

function environmentSummary() {
  const env = environment ?? baseEnvironment();
  return {
    shell: environmentShell ?? process.env.SHELL ?? null,
    source: environmentSource,
    path: env.PATH ?? env.Path ?? null,
  };
}

function childEnvironment() {
  return environment ?? baseEnvironment();
}
/**
 * The inherited/login-shell environment plus this launch's own overrides. Values
 * go to `spawn` verbatim: the shell never sees them, so no quoting rules apply.
 */
function childEnvironmentWith(extraEnv) {
  const base = childEnvironment();
  if (!extraEnv || typeof extraEnv !== "object") return base;
  return { ...base, ...extraEnv };
}

/** macOS/Linux: a login shell, so nvm/asdf/homebrew PATH entries exist. */
function spawnCommand(command, cwd, extraEnv) {
  const env = childEnvironmentWith(extraEnv);
  if (process.platform === "win32") {
    const shell = process.env.ComSpec || "cmd.exe";
    return {
      child: spawn(shell, ["/d", "/s", "/c", command], {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      detached: false,
    };
  }
  const shell = process.env.SHELL || "/bin/zsh";
  return {
    child: spawn(shell, ["-lc", command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    detached: true,
  };
}

class ProcessRecord {
  constructor(launch, cwd) {
    this.launchId = launch.id;
    this.name = launch.name;
    this.command = launch.command;
    this.cwd = cwd;
    this.status = "running";
    this.pid = null;
    this.detached = false;
    this.child = null;
    this.exitCode = null;
    this.signal = null;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.port = null;
    this.seq = 0;
    this.chunks = [];
    this.chars = 0;
    this.stopping = false;
  }

  push(stream, text) {
    if (!text) return;
    const limited = text.length > MAX_CHUNK_CHARS ? text.slice(-MAX_CHUNK_CHARS) : text;
    this.seq += 1;
    this.chunks.push({ seq: this.seq, stream, text: limited });
    this.chars += limited.length;
    while (this.chunks.length > MAX_CHUNKS || this.chars > MAX_CHARS) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.chars -= dropped.text.length;
    }
    if (!this.port) {
      const match = PORT_PATTERN.exec(limited.replace(ANSI_PATTERN, ""));
      if (match) this.port = Number(match[1]);
    }
  }

  summary() {
    return {
      launchId: this.launchId,
      name: this.name,
      command: this.command,
      // Where it actually runs — shown in the panel and useful when debugging.
      cwd: this.cwd,
      status: this.status,
      pid: this.pid,
      port: this.port,
      exitCode: this.exitCode,
      signal: this.signal,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      seq: this.seq,
      stopping: this.stopping,
    };
  }
}

class Runner {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.runsFile = path.join(dataDir, "runs.json");
    this.processes = new Map();
    this.waiters = new Set();
    this.orphans = [];
  }

  /** Leftover pids from a previous session. We never kill them: pids get reused. */
  loadOrphanHints() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.runsFile, "utf8"));
      this.orphans = Array.isArray(parsed?.runs) ? parsed.runs : [];
    } catch {
      this.orphans = [];
    }
    return this.orphans;
  }

  persistRuns() {
    const runs = [];
    for (const record of this.processes.values()) {
      if (record.status !== "running" || !record.pid) continue;
      runs.push({ launchId: record.launchId, name: record.name, pid: record.pid, startedAt: record.startedAt });
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      if (runs.length === 0) {
        fs.rmSync(this.runsFile, { force: true });
        return;
      }
      const tmp = `${this.runsFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, this.runsFile);
    } catch {
      /* the runtime keeps working even if this hint file cannot be written */
    }
  }

  runningCount() {
    let count = 0;
    for (const record of this.processes.values()) if (record.status === "running") count += 1;
    return count;
  }

  record(launchId) {
    return this.processes.get(launchId) ?? null;
  }

  wake() {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  waitForChange(ms) {
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, ms);
      timer.unref?.();
      this.waiters.add(finish);
    });
  }

  /** Resolve the login-shell PATH once; every spawn afterwards uses it. */
  warmEnvironment() {
    return warmEnvironment();
  }

  environmentSummary() {
    return environmentSummary();
  }

  start(launch, cwd) {
    const existing = this.processes.get(launch.id);
    if (existing && existing.status === "running") {
      return { ok: false, code: "ALREADY_RUNNING", message: "this launch is already running" };
    }
    if (this.runningCount() >= MAX_CONCURRENT) {
      return { ok: false, code: "TOO_MANY", message: `at most ${MAX_CONCURRENT} processes can run at once` };
    }
    if (!cwd || !fs.existsSync(cwd)) {
      return { ok: false, code: "NO_CWD", message: `working directory does not exist: ${cwd}` };
    }

    const record = new ProcessRecord(launch, cwd);
    const { child, detached } = spawnCommand(launch.command, cwd, launch.env);
    record.child = child;
    record.pid = child.pid ?? null;
    record.detached = detached;
    this.processes.set(launch.id, record);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text) => {
      record.push("out", text);
      this.wake();
    });
    child.stderr?.on("data", (text) => {
      record.push("err", text);
      this.wake();
    });

    const settle = (code, signal) => {
      if (record.status !== "running") return;
      record.status = record.stopping ? "stopped" : "exited";
      record.exitCode = typeof code === "number" ? code : null;
      record.signal = signal ?? null;
      record.endedAt = Date.now();
      record.child = null;
      record.push("meta", `\r\n[${record.status}${record.exitCode === null ? "" : ` code ${record.exitCode}`}]\r\n`);
      this.persistRuns();
      this.wake();
    };

    child.on("exit", settle);
    child.on("error", (error) => {
      record.push("err", `spawn failed: ${error.message}\r\n`);
      if (record.status === "running") {
        record.status = "exited";
        record.exitCode = null;
        record.endedAt = Date.now();
      }
      this.persistRuns();
      this.wake();
    });

    this.persistRuns();
    this.wake();
    return { ok: true, process: record.summary() };
  }

  signal(record, signalName) {
    if (!record.pid) return;
    if (record.detached) {
      try {
        process.kill(-record.pid, signalName);
        return;
      } catch {
        /* fall through to the direct child */
      }
    }
    try {
      record.child?.kill(signalName);
    } catch {
      /* already gone */
    }
  }

  /** SIGINT, grace, SIGTERM, grace, SIGKILL — dev servers often need all three. */
  async stop(launchId) {
    const record = this.processes.get(launchId);
    if (!record || record.status !== "running") return { ok: true, already: true };
    record.stopping = true;
    record.push("meta", "\r\n[stopping]\r\n");
    this.wake();

    this.signal(record, "SIGINT");
    await delay(3000);
    if (record.status === "running") this.signal(record, "SIGTERM");
    await delay(2000);
    if (record.status === "running") this.signal(record, "SIGKILL");

    if (record.status === "running") {
      record.status = "stopped";
      record.endedAt = Date.now();
      record.child = null;
      this.persistRuns();
      this.wake();
    }
    return { ok: true, process: record.summary() };
  }

  clear(launchId) {
    const record = this.processes.get(launchId);
    if (!record || record.status === "running") return { ok: false };
    record.chunks = [];
    record.chars = 0;
    record.seq = 0;
    this.processes.delete(launchId);
    this.wake();
    return { ok: true };
  }

  output(launchId) {
    const record = this.processes.get(launchId);
    if (!record) return { ok: true, chunks: [], process: null };
    return { ok: true, chunks: record.chunks.slice(), process: record.summary() };
  }

  snapshot() {
    return {
      running: [...this.processes.values()].filter((record) => record.status === "running").map((r) => r.summary()),
      known: [...this.processes.values()].map((record) => record.summary()),
      runningCount: this.runningCount(),
      maxConcurrent: MAX_CONCURRENT,
      orphans: this.orphans,
    };
  }

  collectSince(cursors) {
    const events = [];
    for (const record of this.processes.values()) {
      const cursor = Number(cursors?.[record.launchId] ?? 0);
      const fresh = record.chunks.filter((chunk) => chunk.seq > cursor);
      if (fresh.length === 0) continue;
      events.push({
        launchId: record.launchId,
        chunks: fresh.slice(-POLL_MAX_CHUNKS_PER_PROCESS),
        process: record.summary(),
      });
    }
    return events;
  }

  hasPending(cursors) {
    for (const record of this.processes.values()) {
      const cursor = Number(cursors?.[record.launchId] ?? 0);
      if (record.chunks.length > 0 && record.chunks[record.chunks.length - 1].seq > cursor) return true;
    }
    return false;
  }

  async poll(cursors, waitMs) {
    const budget = Math.max(0, Math.min(POLL_MAX_WAIT_MS, Number(waitMs) || 0));
    if (budget > 0 && !this.hasPending(cursors)) {
      await this.waitForChange(budget);
    }
    return {
      ok: true,
      events: this.collectSince(cursors),
      processes: [...this.processes.values()].map((record) => record.summary()),
      runningCount: this.runningCount(),
      maxConcurrent: MAX_CONCURRENT,
    };
  }

  /** Kill everything this session started. Children are detached, so be explicit. */
  async stopAll() {
    const running = [...this.processes.values()].filter((record) => record.status === "running");
    for (const record of running) record.stopping = true;
    for (const record of running) this.signal(record, "SIGTERM");
    await delay(1500);
    for (const record of running) if (record.status === "running") this.signal(record, "SIGKILL");
    this.processes.clear();
    this.persistRuns();
  }
}

module.exports = { Runner, MAX_CONCURRENT };

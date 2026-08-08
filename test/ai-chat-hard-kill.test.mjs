import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cleanupAiTurnProcesses } from "../server/ai-turn-process-registry.mjs";
import { createTaskboardSupervisor } from "../scripts/taskboard-supervisor.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await wait(25);
  }
  throw new Error("Timed out waiting for condition");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupMembers(pgid) {
  return execFileSync("/bin/ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
    .filter((match) => match && Number(match[2]) === pgid)
    .map((match) => ({ pid: Number(match[1]), command: match[3] }));
}

async function reservePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("registry cleanup does not signal a reused PGID with a different identity", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-stale-pgid-"));
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await waitFor(() => processExists(sentinel.pid));
    const identity = execFileSync(
      "/bin/ps",
      ["-p", String(sentinel.pid), "-o", "pgid=,lstart=,command="],
      { encoding: "utf8" },
    ).trim();
    await writeFile(path.join(directory, "stale.json"), `${JSON.stringify({
      version: 1,
      generation: "old-generation",
      owner: "run:stale",
      pid: sentinel.pid,
      pgid: sentinel.pid,
      identity: `${identity} reused`,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    await cleanupAiTurnProcesses({ registryDirectory: directory });
    assert.equal(processExists(sentinel.pid), true);
    assert.equal((await readdir(directory)).filter((name) => name.endsWith(".json")).length, 0);
  } finally {
    if (processExists(sentinel.pid)) process.kill(-sentinel.pid, "SIGKILL");
    await new Promise((resolve) => sentinel.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("supervisor recovery removes a hard-killed server's SIGTERM-resistant AI process group", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-ai-hard-kill-"));
  const dataDirectory = path.join(directory, "data");
  const codexHome = path.join(directory, "codex-home");
  const workspace = path.join(directory, "workspace");
  const registryDirectory = path.join(dataDirectory, "ai-turn-processes");
  const readyPath = path.join(directory, "turn-ready.json");
  const signalPath = path.join(directory, "signals.log");
  const fakeCodex = path.join(directory, "fake-codex.mjs");
  await Promise.all([mkdir(dataDirectory), mkdir(codexHome), mkdir(workspace)]);
  await writeFile(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { local: { rootPaths: [workspace] } },
  }));
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "debug" && args[1] === "models") {
  process.stdout.write('{"models":[{"slug":"gpt-hard-kill","display_name":"Hard Kill","description":"","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"}],"service_tiers":[]}]}');
  process.exit(0);
}
if (args[0] === "app-server") {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === 1) process.stdout.write('{"id":1,"result":{}}\\n');
      if (message.id === 2) process.stdout.write('{"id":2,"result":{"data":[]}}\\n');
    }
  });
} else if (args[0] === "exec") {
  if (args.includes("--ephemeral")) {
    process.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"summary"}}\\n');
    process.stdout.write('{"type":"turn.completed"}\\n');
    process.exit(0);
  }
  process.on("SIGTERM", () => appendFileSync(process.env.FAKE_SIGNAL_PATH, "turn:" + process.pid + "\\n"));
  const descendant = spawn(process.execPath, ["-e",
    'const fs=require("node:fs"); process.on("SIGTERM",()=>fs.appendFileSync(process.env.FAKE_SIGNAL_PATH,"descendant:"+process.pid+"\\\\n")); process.send("ready"); setInterval(()=>{},1000);'
  ], { env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  descendant.once("message", () => {
    const pgid = Number(execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pgid="], {encoding:"utf8"}).trim());
    writeFileSync(process.env.FAKE_READY_PATH, JSON.stringify({codexPid:process.pid,descendantPid:descendant.pid,pgid}));
    process.stdout.write('{"type":"thread.started","thread_id":"hard-kill-session"}\\n');
    process.stdout.write('{"type":"turn.started"}\\n');
  });
  setInterval(() => {}, 1000);
}
`);
  await chmod(fakeCodex, 0o755);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  let currentServer = null;
  let ready = null;
  const isReachable = async () => fetch(`${baseUrl}/health`).then(
    (response) => response.ok,
    () => false,
  );
  const waitUntilReachable = async (timeoutMs) => waitFor(isReachable, timeoutMs);
  const supervisor = createTaskboardSupervisor({
    detached: false,
    isReachable,
    waitUntilReachable,
    cleanupOwnedProcesses: (generation) => cleanupAiTurnProcesses({
      registryDirectory,
      generation,
    }),
    start: () => {
      const generation = randomUUID();
      const child = spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CODEX_EXECUTABLE: fakeCodex,
          CODEX_HOME: codexHome,
          CODEX_TASKBOARD_DATA_DIR: dataDirectory,
          CODEX_TASKBOARD_HOST: "127.0.0.1",
          CODEX_TASKBOARD_PORT: String(port),
          CODEX_TASKBOARD_SERVER_GENERATION: generation,
          FAKE_READY_PATH: readyPath,
          FAKE_SIGNAL_PATH: signalPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));
      currentServer = child;
      return { child, generation };
    },
  });

  try {
    await supervisor.ensure({ force: true });
    const firstServer = currentServer;
    const created = await request(baseUrl, "/api/local/ai/threads", {
      method: "POST",
      body: {
        projectId: "local",
        model: "gpt-hard-kill",
        reasoningEffort: "low",
        sandbox: "workspace-write",
      },
    });
    assert.equal(created.response.status, 201);
    const threadId = created.body.thread.id;
    const started = await request(baseUrl, `/api/local/ai/threads/${threadId}/turns`, {
      method: "POST",
      body: { message: "stay alive" },
    });
    assert.equal(started.response.status, 202);

    ready = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(readyPath, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    });
    assert.equal(processExists(ready.codexPid), true);
    assert.equal(processExists(ready.descendantPid), true);
    assert.equal(processGroupMembers(ready.pgid).some(({ pid }) => pid === ready.codexPid), true);
    assert.equal(processGroupMembers(ready.pgid).some(({ pid }) => pid === ready.descendantPid), true);
    assert.equal((await readdir(registryDirectory)).filter((name) => name.endsWith(".json")).length, 1);

    process.kill(firstServer.pid, "SIGKILL");
    await new Promise((resolve) => firstServer.once("exit", resolve));
    const recovery = await supervisor.ensure({ force: true });
    assert.equal(recovery.restarted, true);
    assert.notEqual(currentServer.pid, firstServer.pid);
    await waitFor(() => !processGroupExists(ready.pgid));
    assert.equal(processExists(ready.codexPid), false);
    assert.equal(processExists(ready.descendantPid), false);
    assert.deepEqual(processGroupMembers(ready.pgid), []);
    const signals = await readFile(signalPath, "utf8");
    assert.match(signals, new RegExp(`turn:${ready.codexPid}`));
    assert.match(signals, new RegExp(`descendant:${ready.descendantPid}`));
    assert.equal((await readdir(registryDirectory)).filter((name) => name.endsWith(".json")).length, 0);

    const snapshot = await request(baseUrl, `/api/local/ai/threads/${threadId}`);
    assert.equal(snapshot.body.runs[0].status, "interrupted");
  } catch (error) {
    error.message += `\nServer output:\n${logs.join("")}`;
    throw error;
  } finally {
    await supervisor.stop().catch(() => {});
    if (ready && processGroupExists(ready.pgid)) {
      const members = processGroupMembers(ready.pgid);
      if (members.some(({ command }) => command.includes(fakeCodex))) {
        process.kill(-ready.pgid, "SIGKILL");
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

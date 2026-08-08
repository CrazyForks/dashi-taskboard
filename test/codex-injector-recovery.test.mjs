import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fakeCodexMain() {
  const fs = require("node:fs");
  const path = require("node:path");
  const controlDirectory = process.env.FAKE_CODEX_CONTROL_DIR;
  const countPath = path.join(controlDirectory, "launch-count");
  const eventsPath = path.join(controlDirectory, "events.log");
  let launchCount = 0;
  try {
    launchCount = Number(fs.readFileSync(countPath, "utf8"));
  } catch {}
  launchCount += 1;
  fs.writeFileSync(countPath, String(launchCount));
  fs.appendFileSync(eventsPath, `launch:${launchCount}:${process.pid}\n`);

  const input = fs.createReadStream(null, { fd: 3 });
  const output = fs.createWriteStream(null, { fd: 4 });
  const keepAlive = setInterval(() => {}, 1_000);
  const exit = (signal, code) => {
    clearInterval(keepAlive);
    fs.appendFileSync(eventsPath, `exit:${launchCount}:${signal}:${code}\n`);
    process.exit(code);
  };
  process.once("SIGTERM", () => exit("SIGTERM", 0));

  if (launchCount === 2) {
    fs.appendFileSync(eventsPath, "instant-failure:2\n");
    output.end();
    setTimeout(() => exit("self", 1), 50);
    return;
  }

  let buffer = Buffer.alloc(0);
  input.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let boundary = buffer.indexOf(0); boundary !== -1; boundary = buffer.indexOf(0)) {
      const source = buffer.subarray(0, boundary).toString("utf8");
      buffer = buffer.subarray(boundary + 1);
      if (!source) continue;
      const request = JSON.parse(source);
      if (request.method === "Target.getTargets") {
        fs.appendFileSync(eventsPath, `targets:${launchCount}:${process.pid}\n`);
      }
      if (launchCount === 1 && request.method === "Target.getTargets") {
        fs.appendFileSync(eventsPath, `pipe-eof:${launchCount}:${process.pid}\n`);
        output.end();
        continue;
      }
      const result = request.method === "Target.getTargets" ? { targetInfos: [] } : {};
      output.write(`${JSON.stringify({ id: request.id, result })}\0`);
    }
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("private CDP recovery retries after one relaunch failure", { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-cdp-recovery-"));
  const executableDirectory = path.join(directory, "FakeCodex.app", "Contents", "MacOS");
  const executablePath = path.join(executableDirectory, "FakeCodex");
  await mkdir(executableDirectory, { recursive: true });
  await writeFile(
    executablePath,
    `#!/usr/bin/env node\n(${fakeCodexMain.toString()})();\n`,
  );
  await chmod(executablePath, 0o755);

  let injector;
  let stdout = "";
  let stderr = "";
  try {
    const port = await freePort();
    injector = spawn(
      process.execPath,
      [
        path.join(repository, "scripts", "codex-injector.mjs"),
        "--launch",
        "--watch",
        "--cdp-pipe",
        "--app-path",
        path.join(directory, "FakeCodex.app"),
      ],
      {
        cwd: repository,
        env: {
          ...process.env,
          CODEX_TASKBOARD_DATA_DIR: path.join(directory, "taskboard-data"),
          CODEX_TASKBOARD_CODEX_PROFILE: path.join(directory, "profile"),
          CODEX_TASKBOARD_RUNTIME_FILE: path.join(directory, "runtime.json"),
          CODEX_TASKBOARD_HOST: "127.0.0.1",
          CODEX_TASKBOARD_PORT: String(port),
          CODEX_TASKBOARD_INSTANCE_TOKEN: "recovery-verifier-0001",
          CODEX_TASKBOARD_INSTANCE_SECRET:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          CODEX_TASKBOARD_VERSION: "recovery-verifier",
          FAKE_CODEX_CONTROL_DIR: directory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    injector.stdout.on("data", (chunk) => { stdout += chunk; });
    injector.stderr.on("data", (chunk) => { stderr += chunk; });

    let events = "";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        events = await readFile(path.join(directory, "events.log"), "utf8");
      } catch {}
      if ((events.match(/targets:3:/g) || []).length >= 2) break;
      assert.equal(injector.exitCode, null, `${stdout}\n${stderr}`);
      await delay(200);
    }

    assert.equal((events.match(/targets:3:/g) || []).length >= 2, true, stderr);
    assert.equal(injector.exitCode, null, stderr);
    injector.kill("SIGTERM");
    const [code] = await once(injector, "exit");
    assert.equal(code, 0, stderr);

    const lines = events.trim().split("\n");
    const pipeEofIndex = lines.findIndex((line) => line.startsWith("pipe-eof:1:"));
    const firstExitIndex = lines.findIndex((line) => line === "exit:1:SIGTERM:0");
    assert.equal(Number(await readFile(path.join(directory, "launch-count"), "utf8")), 3);
    assert.ok(pipeEofIndex >= 0);
    assert.ok(firstExitIndex > pipeEofIndex);
    assert.ok(lines.includes("instant-failure:2"));
    assert.ok(
      lines.includes("exit:2:SIGTERM:0") || lines.includes("exit:2:self:1"),
    );
    assert.equal(lines.filter((line) => line.startsWith("targets:3:")).length >= 2, true);
    assert.match(stderr, /CDP pipe became unhealthy; restarting Codex/);
    assert.match(stderr, /Waiting to restart Codex: (?:CDP pipe ended|Codex exited)/);
  } finally {
    if (injector?.exitCode === null && injector.signalCode === null) {
      injector.kill("SIGTERM");
      await Promise.race([once(injector, "exit"), delay(5_000)]);
    }
    await rm(directory, { recursive: true, force: true });
  }
});

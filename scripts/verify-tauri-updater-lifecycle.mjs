#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, createReadStream, openSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("The Tauri updater lifecycle verifier requires macOS");
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const [major, minor, patch] = packageJson.version.split(".").map(Number);
const currentVersion = packageJson.version;
const updateVersion = `${major}.${minor}.${patch + 1}`;
const target = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const productName = "Codex Taskboard Updater Test";
const executableName = "codex-taskboard-launcher";
const tauriPath = path.join(projectRoot, "node_modules", ".bin", "tauri");
const overlayPath = path.join(projectRoot, "src-tauri", "tauri.updater-test.conf.json");
const privateKeyPath = path.join(projectRoot, "test", "fixtures", "updater", "updater-test.key");
const publicKeyPath = `${privateKeyPath}.pub`;
const rustupCargo = spawnSync(
  "rustup",
  ["which", "cargo", "--toolchain", "1.88.0"],
  { encoding: "utf8" },
);
if (rustupCargo.status !== 0) throw new Error("Rust 1.88.0 is not installed through rustup");
const cargoPath = rustupCargo.stdout.trim();
const rustBin = path.dirname(cargoPath);
const buildEnvironment = {
  ...process.env,
  CI: "true",
  PATH: `${rustBin}:${process.env.PATH}`,
  RUSTC: path.join(rustBin, "rustc"),
};
const temporaryRoot = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "codex-taskboard-updater-lifecycle.")),
);
const fixtureRoot = path.join(temporaryRoot, "fixtures");
const results = {};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

async function waitFor(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processTable() {
  return output("/bin/ps", ["-axo", "pid=,pgid=,command="])
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }));
}

function processGroup(pgid) {
  return processTable().filter((entry) => entry.pgid === pgid);
}

function appPids(executablePath) {
  return processTable()
    .filter((entry) => entry.command === executablePath || entry.command.startsWith(`${executablePath} `))
    .map((entry) => entry.pid);
}

async function health(runtime) {
  const response = await fetch(new URL("/health", runtime.url), {
    headers: { "x-codex-taskboard-challenge": "a".repeat(32) },
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error(`health returned ${response.status}`);
  return response.json();
}

async function runtimeWithVersion(runtimePath, version, condition = () => true) {
  return waitFor(async () => {
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    if (!condition(runtime)) return null;
    const body = await health(runtime);
    return body.version === version ? { runtime, health: body } : null;
  }, `Taskboard ${version} health`, 45_000);
}

async function logContains(logPath, text) {
  return waitFor(async () => {
    const content = await readFile(logPath, "utf8");
    return content.includes(text) ? content : null;
  }, `launcher log text ${JSON.stringify(text)}`, 45_000);
}

async function waitForChildExit(child, timeout = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Child did not exit")), timeout)),
  ]);
}

async function stopScenario(executablePath, childRecordPath) {
  let pgid = null;
  try {
    pgid = JSON.parse(await readFile(childRecordPath, "utf8")).pid;
  } catch {}
  for (const pid of appPids(executablePath)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  if (pgid) {
    try { process.kill(-pgid, "SIGTERM"); } catch {}
  }
  await waitFor(
    () => appPids(executablePath).length === 0 && (!pgid || processGroup(pgid).length === 0),
    "test App cleanup",
    8_000,
  ).catch(() => null);
  for (const pid of appPids(executablePath)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  if (pgid && processGroup(pgid).length > 0) {
    try { process.kill(-pgid, "SIGKILL"); } catch {}
  }
}

const requests = [];
const artifacts = new Map();
let activeScenario = null;

function sendManifest(response, scenario) {
  const artifact = artifacts.get(scenario.name);
  const body = JSON.stringify({
    version: updateVersion,
    notes: `Updater lifecycle ${scenario.name}`,
    pub_date: "2026-08-08T00:00:00Z",
    url: `${serverOrigin}/artifact/${scenario.name}`,
    signature: artifact.signature,
  });
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, serverOrigin);
  requests.push({
    scenario: activeScenario?.name ?? null,
    path: requestUrl.pathname,
    accept: request.headers.accept,
    userAgent: request.headers["user-agent"],
  });
  if (requestUrl.pathname === "/latest.json") {
    if (!activeScenario) {
      response.writeHead(204).end();
    } else if (activeScenario.released) {
      sendManifest(response, activeScenario);
    } else {
      activeScenario.pending.push(response);
    }
    return;
  }
  const match = requestUrl.pathname.match(/^\/artifact\/(.+)$/);
  if (match && artifacts.has(match[1])) {
    const artifact = artifacts.get(match[1]);
    const details = await stat(artifact.path);
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": details.size,
    });
    createReadStream(artifact.path).pipe(response);
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const serverAddress = server.address();
const serverOrigin = `http://127.0.0.1:${serverAddress.port}`;

function selectScenario(name) {
  activeScenario = { name, released: false, pending: [] };
}

function releaseScenario() {
  activeScenario.released = true;
  for (const response of activeScenario.pending.splice(0)) {
    sendManifest(response, activeScenario);
  }
}

function assertUpdaterRequests(name) {
  const scenarioRequests = requests.filter((request) => request.scenario === name);
  const checkRequest = scenarioRequests.find((request) => request.path === "/latest.json");
  const downloadRequest = scenarioRequests.find((request) => request.path === `/artifact/${name}`);
  assert.equal(checkRequest?.accept, "application/json");
  assert.equal(downloadRequest?.accept, "application/octet-stream");
  assert.equal(checkRequest?.userAgent, "tauri-plugin-updater/2.10.1");
  assert.equal(downloadRequest?.userAgent, "tauri-plugin-updater/2.10.1");
}

async function buildApp(version) {
  const config = JSON.stringify({
    version,
    bundle: { createUpdaterArtifacts: false },
    plugins: { updater: { endpoints: [`${serverOrigin}/latest.json`] } },
  });
  run(tauriPath, [
    "build",
    "--target", target,
    "--runner", cargoPath,
    "--bundles", "app",
    "--no-sign",
    "--ignore-version-mismatches",
    "--features", "updater-lifecycle-test",
    "--config", overlayPath,
    "--config", config,
  ], { cwd: projectRoot, env: buildEnvironment });
  const bundleDirectory = path.join(
    projectRoot,
    "src-tauri",
    "target",
    target,
    "release",
    "bundle",
    "macos",
  );
  const appPath = path.join(bundleDirectory, `${productName}.app`);
  assert.equal(
    output("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(appPath, "Contents", "Info.plist")]),
    version,
  );
  return appPath;
}

async function prepareScenario(name, baselineApp) {
  const scenarioRoot = path.join(temporaryRoot, "scenarios", name);
  const homeDirectory = path.join(scenarioRoot, "home");
  const installDirectory = path.join(scenarioRoot, "install");
  const installedApp = path.join(installDirectory, `${productName}.app`);
  await mkdir(path.join(homeDirectory, "Applications", "ChatGPT.app"), { recursive: true });
  await mkdir(installDirectory, { recursive: true });
  await cp(baselineApp, installedApp, { recursive: true, preserveTimestamps: true });
  const executablePath = path.join(installedApp, "Contents", "MacOS", executableName);
  const dataDirectory = path.join(homeDirectory, "Library", "Application Support", "Codex Taskboard");
  const runtimePath = path.join(dataDirectory, "launcher-runtime.json");
  const childRecordPath = path.join(dataDirectory, "launcher-child.json");
  const logPath = path.join(homeDirectory, "Library", "Logs", "Codex Taskboard", "codex-taskboard-launcher.log");
  const outputPath = path.join(scenarioRoot, "app-output.log");
  const outputFd = openSync(outputPath, "a");
  const app = spawn(executablePath, [], {
    env: { ...process.env, HOME: homeDirectory },
    stdio: ["ignore", outputFd, outputFd],
  });
  closeSync(outputFd);
  const initial = await runtimeWithVersion(runtimePath, currentVersion);
  const record = JSON.parse(await readFile(childRecordPath, "utf8"));
  assert.equal(record.pid, initial.runtime.pid);
  assert.ok(processIsAlive(app.pid));
  assert.ok(processGroup(record.pid).length >= 2);
  return {
    name,
    app,
    homeDirectory,
    installedApp,
    executablePath,
    runtimePath,
    childRecordPath,
    logPath,
    initial,
  };
}

async function runBadSignature(baselineApp) {
  selectScenario("bad-signature");
  const scenario = await prepareScenario("bad-signature", baselineApp);
  try {
    releaseScenario();
    const log = await logContains(scenario.logPath, "Update download failed:");
    const current = await runtimeWithVersion(scenario.runtimePath, currentVersion);
    assert.equal(current.runtime.pid, scenario.initial.runtime.pid);
    assert.equal(current.runtime.url, scenario.initial.runtime.url);
    assert.ok(processGroup(current.runtime.pid).length >= 2);
    assert.doesNotMatch(log, /Update installation failed:/);
    assertUpdaterRequests("bad-signature");
    results.badSignature = {
      version: current.health.version,
      childPid: current.runtime.pid,
      listenerPort: Number(new URL(current.runtime.url).port),
      serviceStayedRunning: true,
    };
  } finally {
    await stopScenario(scenario.executablePath, scenario.childRecordPath);
  }
}

async function runInstallFailure(baselineApp) {
  selectScenario("install-failure");
  const scenario = await prepareScenario("install-failure", baselineApp);
  try {
    const oldPid = scenario.initial.runtime.pid;
    const oldPort = new URL(scenario.initial.runtime.url).port;
    releaseScenario();
    await logContains(scenario.logPath, "Taskboard restarted after update installation failure");
    const recovered = await runtimeWithVersion(
      scenario.runtimePath,
      currentVersion,
      (runtime) => runtime.pid !== oldPid,
    );
    await waitFor(() => processGroup(oldPid).length === 0, "old launcher process group cleanup");
    assert.equal(new URL(recovered.runtime.url).port, oldPort);
    assert.notEqual(recovered.runtime.url, scenario.initial.runtime.url);
    assert.ok(processGroup(recovered.runtime.pid).length >= 2);
    assert.ok(processIsAlive(scenario.app.pid));
    assertUpdaterRequests("install-failure");
    results.installFailure = {
      version: recovered.health.version,
      oldChildPid: oldPid,
      recoveredChildPid: recovered.runtime.pid,
      listenerPort: Number(oldPort),
      oldProcessGroupRemoved: true,
    };
  } finally {
    await stopScenario(scenario.executablePath, scenario.childRecordPath);
  }
}

async function runSuccess(baselineApp) {
  selectScenario("success");
  const scenario = await prepareScenario("success", baselineApp);
  try {
    const oldAppPid = scenario.app.pid;
    const oldChildPid = scenario.initial.runtime.pid;
    releaseScenario();
    await logContains(scenario.logPath, `Installed update ${updateVersion}; restarting`);
    const updated = await runtimeWithVersion(
      scenario.runtimePath,
      updateVersion,
      (runtime) => runtime.pid !== oldChildPid,
    );
    await waitFor(() => !processIsAlive(oldAppPid), "old Tauri process exit");
    await waitFor(() => processGroup(oldChildPid).length === 0, "old launcher process group cleanup");
    const [newAppPid] = await waitFor(
      () => {
        const pids = appPids(scenario.executablePath).filter((pid) => pid !== oldAppPid);
        return pids.length > 0 ? pids : null;
      },
      "updated Tauri process",
    );
    assert.ok(processIsAlive(newAppPid));
    assert.ok(processGroup(updated.runtime.pid).length >= 2);
    const oldListenerPort = Number(new URL(scenario.initial.runtime.url).port);
    const newListenerPort = Number(new URL(updated.runtime.url).port);
    assert.notEqual(newListenerPort, oldListenerPort);
    assert.equal(
      output("/usr/libexec/PlistBuddy", [
        "-c", "Print :CFBundleShortVersionString",
        path.join(scenario.installedApp, "Contents", "Info.plist"),
      ]),
      updateVersion,
    );

    const runtimeBeforeDuplicate = JSON.parse(await readFile(scenario.runtimePath, "utf8"));
    const duplicate = spawn(scenario.executablePath, [], {
      env: { ...process.env, HOME: scenario.homeDirectory },
      stdio: "ignore",
    });
    const duplicateExit = await waitForChildExit(duplicate);
    assert.equal(duplicateExit.code, 0);
    const runtimeAfterDuplicate = JSON.parse(await readFile(scenario.runtimePath, "utf8"));
    assert.deepEqual(runtimeAfterDuplicate, runtimeBeforeDuplicate);
    assert.deepEqual(appPids(scenario.executablePath), [newAppPid]);
    assertUpdaterRequests("success");
    results.success = {
      version: updated.health.version,
      oldAppPid,
      newAppPid,
      oldChildPid,
      newChildPid: updated.runtime.pid,
      oldListenerPort,
      newListenerPort,
      singleInstanceLock: true,
      oldProcessGroupRemoved: true,
    };
  } finally {
    await stopScenario(scenario.executablePath, scenario.childRecordPath);
  }
}

try {
  await mkdir(fixtureRoot, { recursive: true });
  const overlay = JSON.parse(await readFile(overlayPath, "utf8"));
  assert.equal(overlay.plugins.updater.pubkey, (await readFile(publicKeyPath, "utf8")).trim());

  run(process.platform === "win32" ? "npm.cmd" : "npm", [
    "run", "app:prepare", "--", "--target", target,
  ], { cwd: projectRoot });

  const builtUpdateApp = await buildApp(updateVersion);
  const updateApp = path.join(fixtureRoot, `${productName}.app`);
  await cp(builtUpdateApp, updateApp, { recursive: true, preserveTimestamps: true });
  const updateArchive = path.join(fixtureRoot, "update.app.tar.gz");
  run("/usr/bin/tar", ["-czf", updateArchive, path.basename(updateApp)], {
    cwd: path.dirname(updateApp),
  });
  const privateKey = (await readFile(privateKeyPath, "utf8")).trim();
  run(tauriPath, [
    "signer", "sign",
    "--private-key", privateKey,
    "--password", "",
    updateArchive,
  ], { cwd: projectRoot });
  const updateSignature = await readFile(`${updateArchive}.sig`, "utf8");

  const invalidArchive = path.join(fixtureRoot, "invalid-update.app.tar.gz");
  await writeFile(invalidArchive, "signed, but not a gzip tar archive\n");
  run(tauriPath, [
    "signer", "sign",
    "--private-key", privateKey,
    "--password", "",
    invalidArchive,
  ], { cwd: projectRoot });
  const invalidSignature = await readFile(`${invalidArchive}.sig`, "utf8");

  artifacts.set("success", { path: updateArchive, signature: updateSignature });
  artifacts.set("bad-signature", { path: updateArchive, signature: invalidSignature });
  artifacts.set("install-failure", { path: invalidArchive, signature: invalidSignature });

  const builtBaselineApp = await buildApp(currentVersion);
  const baselineApp = path.join(fixtureRoot, "baseline", `${productName}.app`);
  await mkdir(path.dirname(baselineApp), { recursive: true });
  await cp(builtBaselineApp, baselineApp, { recursive: true, preserveTimestamps: true });

  await runBadSignature(baselineApp);
  await runInstallFailure(baselineApp);
  await runSuccess(baselineApp);
  console.log(JSON.stringify({ currentVersion, updateVersion, ...results }, null, 2));
} finally {
  for (const response of activeScenario?.pending ?? []) response.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}

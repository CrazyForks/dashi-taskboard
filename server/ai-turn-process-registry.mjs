#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TURN_TOKEN_ENV = "DASHI_TASKBOARD_AI_TURN_TOKEN";
const PS_ENVIRONMENT = { PATH: "/usr/bin:/bin", LC_ALL: "C" };

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function processIdentity(pid) {
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(pid), "-o", "pgid=,lstart=,command="],
      { env: PS_ENVIRONMENT, maxBuffer: 1024 * 1024 },
    );
    const identity = stdout.trim();
    if (!identity) return null;
    const pgid = Number.parseInt(identity, 10);
    return Number.isInteger(pgid) ? { identity, pgid } : null;
  } catch (error) {
    if (error.code === 1 && !String(error.stdout ?? "").trim()) return null;
    throw error;
  }
}

async function ownedProcessGroupMembers(record) {
  if (process.platform !== "darwin") {
    let members;
    try {
      const { stdout } = await execFileAsync(
        "/bin/ps",
        ["-axo", "pid=,pgid="],
        { env: PS_ENVIRONMENT, maxBuffer: 4 * 1024 * 1024 },
      );
      members = stdout.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        return match && Number(match[2]) === record.pgid ? [Number(match[1])] : [];
      });
    } catch {
      throw new Error("Could not inspect the AI turn process group");
    }
    const owned = [];
    for (const pid of members) {
      try {
        const { stdout } = await execFileAsync(
          "/bin/ps",
          ["eww", "-p", String(pid), "-o", "command="],
          { env: PS_ENVIRONMENT, maxBuffer: 4 * 1024 * 1024 },
        );
        if (stdout.includes(`${TURN_TOKEN_ENV}=${record.token}`)) owned.push(pid);
      } catch (error) {
        if (error.code !== 1) throw new Error("Could not inspect the AI turn process group");
      }
    }
    return owned;
  }

  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      [
        "-wwE",
        "-g",
        String(record.pgid),
        "-o",
        "pid=",
        "-o",
        "pgid=",
        "-o",
        "command=",
      ],
      { env: PS_ENVIRONMENT, maxBuffer: 4 * 1024 * 1024 },
    );
    const marker = `${TURN_TOKEN_ENV}=${record.token}`;
    return stdout.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match || Number(match[2]) !== record.pgid || !match[3].includes(marker)) return [];
      return [Number(match[1])];
    });
  } catch (error) {
    if (error.code === 1) return [];
    throw new Error("Could not inspect the AI turn process group");
  }
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function signalProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pgid) && Date.now() < deadline) await wait(25);
  return !processGroupExists(pgid);
}

function parseRecord(value) {
  if (
    value?.version !== 1
    || typeof value.generation !== "string"
    || typeof value.owner !== "string"
    || !Number.isInteger(value.pid)
    || value.pid < 1
    || !Number.isInteger(value.pgid)
    || value.pgid < 1
    || typeof value.identity !== "string"
    || typeof value.token !== "string"
  ) {
    throw new Error("AI turn process record is invalid");
  }
  return value;
}

async function recordMatchesProcessGroup(record) {
  const leader = await processIdentity(record.pid);
  if (
    leader
    && leader.pgid === record.pgid
    && leader.identity === record.identity
  ) {
    return true;
  }
  return (await ownedProcessGroupMembers(record)).length > 0;
}

async function removeRecord(recordPath) {
  try {
    await unlink(recordPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function registerAiTurnProcess({
  registryDirectory,
  generation,
  owner,
  pid,
  token,
}) {
  const observed = await processIdentity(pid);
  if (!observed || observed.pgid !== pid) {
    throw new Error("AI turn owner did not start as its process-group leader");
  }

  const record = {
    version: 1,
    generation,
    owner,
    pid,
    pgid: observed.pgid,
    identity: observed.identity,
    token,
    createdAt: new Date().toISOString(),
  };
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  await chmod(registryDirectory, 0o700);
  const recordPath = path.join(registryDirectory, `${randomUUID()}.json`);
  const temporaryPath = `${recordPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, recordPath);
  await chmod(recordPath, 0o600);
  return { ...record, recordPath };
}

export async function cleanupAiTurnRecord(
  recordPath,
  {
    terminateGraceMs = 1_000,
    killWaitMs = 1_000,
    generation = null,
    excludeGeneration = null,
  } = {},
) {
  let record;
  try {
    record = parseRecord(JSON.parse(await readFile(recordPath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  if (generation !== null && record.generation !== generation) return;
  if (excludeGeneration !== null && record.generation === excludeGeneration) return;

  if (await recordMatchesProcessGroup(record)) {
    signalProcessGroup(record.pgid, "SIGTERM");
    if (!(await waitForProcessGroupExit(record.pgid, terminateGraceMs))) {
      if (await recordMatchesProcessGroup(record)) {
        signalProcessGroup(record.pgid, "SIGKILL");
        if (!(await waitForProcessGroupExit(record.pgid, killWaitMs))) {
          if (await recordMatchesProcessGroup(record)) {
            throw new Error(`AI turn process group ${record.pgid} did not exit after SIGKILL`);
          }
        }
      }
    }
  }
  await removeRecord(recordPath);
}

export async function cleanupAiTurnProcesses({
  registryDirectory,
  terminateGraceMs = 1_000,
  killWaitMs = 1_000,
  generation = null,
  excludeGeneration = null,
}) {
  let entries;
  try {
    entries = await readdir(registryDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const recordPath = path.join(registryDirectory, entry.name);
    if (entry.name.endsWith(".tmp")) {
      if (generation === null && excludeGeneration === null) await removeRecord(recordPath);
    } else if (entry.name.endsWith(".json")) {
      await cleanupAiTurnRecord(recordPath, {
        terminateGraceMs,
        killWaitMs,
        generation,
        excludeGeneration,
      });
    }
  }
}

export { TURN_TOKEN_ENV };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, registryDirectory] = process.argv.slice(2);
  if (command !== "--cleanup" || !registryDirectory) {
    throw new Error("Usage: ai-turn-process-registry.mjs --cleanup REGISTRY_DIRECTORY");
  }
  await cleanupAiTurnProcesses({ registryDirectory }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

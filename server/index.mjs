import os from "node:os";
import { pathToFileURL } from "node:url";

import {
  createTaskboardServer,
  resolveHost,
  resolvePort,
  resolveServerOptions,
} from "./app.mjs";
import { cleanupAiTurnProcesses } from "./ai-turn-process-registry.mjs";

export { createTaskboardServer, resolveHost, resolvePort, resolveServerOptions } from "./app.mjs";

async function main() {
  const options = resolveServerOptions();
  const app = createTaskboardServer(options);
  const host = resolveHost();
  const listenFd = process.env.CODEX_TASKBOARD_LISTEN_FD === undefined
    ? null
    : Number(process.env.CODEX_TASKBOARD_LISTEN_FD);
  let address;
  try {
    address = await app.listen({ host, port: resolvePort(), fd: listenFd });
    await cleanupAiTurnProcesses({
      registryDirectory: options.aiTurnRegistryDirectory,
      excludeGeneration: options.serverGeneration,
    });
  } catch (error) {
    await app.close();
    throw error;
  }
  console.log(`Codex Taskboard listening on http://127.0.0.1:${address.port}`);
  if (host === "0.0.0.0") {
    const addresses = Object.values(os.networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === "IPv4" && !entry.internal)
      .map((entry) => entry.address);
    for (const lanAddress of [...new Set(addresses)]) {
      console.log(`Codex Taskboard available on LAN at http://${lanAddress}:${address.port}`);
    }
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

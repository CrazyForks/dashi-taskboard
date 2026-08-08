import { readSync } from "node:fs";
import { spawn } from "node:child_process";

import { TURN_TOKEN_ENV } from "./ai-turn-process-registry.mjs";

const [token, executable, encodedArgs] = process.argv.slice(2);
if (!token || !executable || !encodedArgs || process.env[TURN_TOKEN_ENV] !== token) {
  process.exit(2);
}

const control = Buffer.alloc(1);
if (readSync(3, control, 0, 1, null) !== 1 || control[0] !== 1) {
  process.exit(0);
}

const ignoreTermination = () => {};
process.on("SIGTERM", ignoreTermination);

const child = spawn(executable, JSON.parse(encodedArgs), {
  env: process.env,
  stdio: "inherit",
});
child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.removeListener("SIGTERM", ignoreTermination);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

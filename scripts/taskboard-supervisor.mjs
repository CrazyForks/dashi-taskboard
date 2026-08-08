function isRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function waitForExit(child, timeoutMs) {
  if (!isRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", handleExit);
      resolve(exited);
    };
    const handleExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", handleExit);
    if (!isRunning(child)) finish(true);
  });
}

export async function terminateManagedChild(
  child,
  { terminateTimeoutMs = 3_000, killTimeoutMs = 1_000 } = {},
) {
  if (!isRunning(child)) return;
  const terminated = waitForExit(child, terminateTimeoutMs);
  child.kill("SIGTERM");
  if (await terminated) return;

  if (isRunning(child)) child.kill("SIGKILL");
  if (!(await waitForExit(child, killTimeoutMs)) && isRunning(child)) {
    throw new Error("Taskboard process did not exit after SIGKILL");
  }
}

export function createTaskboardSupervisor({
  detached,
  isReachable,
  waitUntilReachable,
  start,
  cleanupOwnedProcesses,
  onProcessError = () => {},
  onUnexpectedExit = () => {},
}) {
  let child = null;
  let generation = null;
  let cleanupInFlight = null;
  let ensureInFlight = null;
  let retryAfter = 0;
  let stopping = false;

  async function cleanupGeneration(targetGeneration) {
    if (targetGeneration === null) return;
    if (cleanupInFlight?.generation === targetGeneration) {
      await cleanupInFlight.promise;
      return;
    }
    if (cleanupInFlight) await cleanupInFlight.promise;
    const promise = cleanupOwnedProcesses(targetGeneration);
    cleanupInFlight = { generation: targetGeneration, promise };
    try {
      await promise;
    } finally {
      if (cleanupInFlight?.promise === promise) cleanupInFlight = null;
    }
  }

  async function ensure({ force = false } = {}) {
    const reachable = await isReachable();
    if (stopping) throw new Error("Taskboard supervisor is stopping");
    if (reachable) return { status: "ok", restarted: false };
    if (ensureInFlight) return ensureInFlight;
    if (!force && Date.now() < retryAfter) {
      throw new Error("Taskboard restart is waiting before its next attempt");
    }

    ensureInFlight = (async () => {
      const managedChild = child;
      const managedGeneration = generation;
      if (isRunning(managedChild)) {
        try {
          await waitUntilReachable(3_000);
          return { status: "ok", restarted: false };
        } catch (_) {}
        await terminateManagedChild(managedChild);
        if (child === managedChild) child = null;
      }

      if (stopping) throw new Error("Taskboard supervisor is stopping");
      await cleanupGeneration(managedGeneration);
      if (generation === managedGeneration) generation = null;
      if (stopping) throw new Error("Taskboard supervisor is stopping");
      const { child: started, generation: startedGeneration } = start();
      child = started;
      generation = startedGeneration;
      if (detached) started.unref();
      started.once("error", (error) => {
        if (!stopping) onProcessError(error);
      });
      started.once("exit", (code, signal) => {
        if (child === started) child = null;
        if (!stopping && !detached && code !== 0) onUnexpectedExit(code, signal);
      });

      try {
        await waitUntilReachable(10_000);
        retryAfter = 0;
        return { status: "ok", restarted: true };
      } catch (error) {
        retryAfter = Date.now() + 2_000;
        throw error;
      }
    })();

    try {
      return await ensureInFlight;
    } finally {
      ensureInFlight = null;
    }
  }

  async function stop() {
    stopping = true;
    const managedChild = child;
    const managedGeneration = generation;
    await terminateManagedChild(managedChild);
    if (child === managedChild) child = null;
    await cleanupGeneration(managedGeneration);
    if (generation === managedGeneration) generation = null;
  }

  return { ensure, stop };
}

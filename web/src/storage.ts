export type TaskboardStorageStatus = "persisted" | "pending" | "failed";

interface PendingStorageWrite {
  value: string | null;
  revision: number;
}

const RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
const UNLOAD_KEEPALIVE_BUDGET_BYTES = 64 * 1024;
const memoryStorage = new Map<string, string>();
const pendingWrites = new Map<string, PendingStorageWrite>();
const storageStatusListeners = new Set<() => void>();
let localStorageBackend: Storage | null = null;
let serverBacked = false;
let nextRevision = 0;
let storageStatus: TaskboardStorageStatus = "persisted";
let storageDrain: Promise<void> | null = null;
let wakeRetry: (() => void) | null = null;

function setStorageStatus(status: TaskboardStorageStatus) {
  if (storageStatus === status) return;
  storageStatus = status;
  storageStatusListeners.forEach((listener) => listener());
}

function waitForRetry(delay: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      if (wakeRetry === finish) wakeRetry = null;
      resolve();
    };
    const timer = window.setTimeout(finish, delay);
    wakeRetry = finish;
  });
}

async function drainStorageWrites() {
  let retryDelay = RETRY_DELAY_MS;
  let permanentlyFailed = false;
  while (pendingWrites.size > 0) {
    const writes = [...pendingWrites.entries()];
    let retryableFailure = false;
    setStorageStatus("pending");
    for (const [key, write] of writes) {
      try {
        const response = await fetch(new URL("api/client-storage", document.baseURI), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key, value: write.value }),
        });
        if (response.status === 204) {
          if (pendingWrites.get(key)?.revision === write.revision) pendingWrites.delete(key);
          continue;
        }
        console.error(new Error(`Taskboard storage returned ${response.status}`));
        if (response.status >= 400 && response.status < 500) {
          if (pendingWrites.get(key)?.revision === write.revision) {
            pendingWrites.delete(key);
            permanentlyFailed = true;
          }
        } else {
          retryableFailure = true;
        }
      } catch (error) {
        retryableFailure = true;
        console.error(error);
      }
    }
    if (retryableFailure && pendingWrites.size > 0) {
      setStorageStatus("failed");
      await waitForRetry(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    } else {
      retryDelay = RETRY_DELAY_MS;
    }
  }
  setStorageStatus(permanentlyFailed ? "failed" : "persisted");
}

function ensureStorageDrain() {
  if (!storageDrain) {
    storageDrain = drainStorageWrites().finally(() => {
      storageDrain = null;
      if (pendingWrites.size > 0) void ensureStorageDrain();
    });
  }
  return storageDrain;
}

function persist(key: string, value: string | null) {
  pendingWrites.set(key, { value, revision: ++nextRevision });
  setStorageStatus("pending");
  void ensureStorageDrain();
}

export function getTaskboardStorageStatus(): TaskboardStorageStatus {
  return storageStatus;
}

export function subscribeTaskboardStorageStatus(listener: () => void): () => void {
  storageStatusListeners.add(listener);
  return () => storageStatusListeners.delete(listener);
}

export async function flushTaskboardStorage(): Promise<void> {
  if (localStorageBackend || !serverBacked) return;
  do {
    wakeRetry?.();
    if (pendingWrites.size > 0) await ensureStorageDrain();
  } while (pendingWrites.size > 0);
}

export function flushTaskboardStorageForUnload(): void {
  if (localStorageBackend || !serverBacked) return;
  let remainingBytes = UNLOAD_KEEPALIVE_BUDGET_BYTES;
  for (const [key, write] of pendingWrites) {
    const body = JSON.stringify({ key, value: write.value });
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    if (bodyBytes > remainingBytes) continue;
    remainingBytes -= bodyBytes;
    void fetch(new URL("api/client-storage", document.baseURI), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch((error) => console.error(error));
  }
}

export async function initializeTaskboardStorage() {
  try {
    localStorageBackend = window.localStorage;
    setStorageStatus("persisted");
    return;
  } catch {
    const response = await fetch(new URL("api/client-storage", document.baseURI));
    if (!response.ok) throw new Error(`Taskboard storage returned ${response.status}`);
    const payload = await response.json() as { entries: Record<string, string> };
    for (const [key, value] of Object.entries(payload.entries)) {
      memoryStorage.set(key, value);
    }
    serverBacked = true;
  }
}

export const taskboardStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem(key) {
    return localStorageBackend?.getItem(key) ?? memoryStorage.get(key) ?? null;
  },
  setItem(key, value) {
    if (localStorageBackend) {
      localStorageBackend.setItem(key, value);
      return;
    }
    memoryStorage.set(key, value);
    if (serverBacked) persist(key, value);
  },
  removeItem(key) {
    if (localStorageBackend) {
      localStorageBackend.removeItem(key);
      return;
    }
    memoryStorage.delete(key);
    if (serverBacked) persist(key, null);
  },
};

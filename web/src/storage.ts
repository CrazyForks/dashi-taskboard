const memoryStorage = new Map<string, string>();
let localStorageBackend: Storage | null = null;
let serverBacked = false;
let storageWrite = Promise.resolve();

function persist(key: string, value: string | null) {
  storageWrite = storageWrite.catch(() => {}).then(async () => {
    const response = await fetch(new URL("api/client-storage", document.baseURI), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
      keepalive: true,
    });
    if (!response.ok) throw new Error(`Taskboard storage returned ${response.status}`);
  });
  void storageWrite.catch((error) => console.error(error));
}

export async function initializeTaskboardStorage() {
  try {
    localStorageBackend = window.localStorage;
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

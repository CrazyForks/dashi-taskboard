const memoryStorage = new Map<string, string>();

export const taskboardStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = (() => {
  try {
    return window.localStorage;
  } catch {
    return {
      getItem: (key) => memoryStorage.get(key) ?? null,
      setItem: (key, value) => memoryStorage.set(key, value),
      removeItem: (key) => memoryStorage.delete(key),
    };
  }
})();

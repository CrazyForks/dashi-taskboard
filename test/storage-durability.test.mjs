import assert from "node:assert/strict";
import { test } from "node:test";

const storageUrl = new URL("../web/src/storage.ts", import.meta.url);

function installOpaqueStorageEnvironment(t, fetchImplementation) {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      clearTimeout,
      setTimeout,
      get localStorage() {
        throw new Error("opaque origin");
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { baseURI: "http://127.0.0.1:47823/runtime/" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchImplementation,
  });

  t.after(() => {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else delete globalThis.window;
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete globalThis.document;
    if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else delete globalThis.fetch;
  });
}

function storageModule(name) {
  const url = new URL(storageUrl);
  url.searchParams.set("case", name);
  return import(url.href);
}

test("the final server-backed write retries without later input", async (t) => {
  const patches = [];
  let patchAttempt = 0;
  installOpaqueStorageEnvironment(t, async (_url, init) => {
    if (!init?.method) {
      return Response.json({ entries: {} });
    }
    patches.push(JSON.parse(init.body));
    patchAttempt += 1;
    return new Response(null, { status: patchAttempt === 1 ? 503 : 204 });
  });
  t.mock.method(console, "error", () => {});

  const storage = await storageModule("final-write");
  await storage.initializeTaskboardStorage();
  let failed = false;
  const persistedAfterRetry = new Promise((resolve) => {
    const unsubscribe = storage.subscribeTaskboardStorageStatus(() => {
      const status = storage.getTaskboardStorageStatus();
      if (status === "failed") failed = true;
      if (!failed || status !== "persisted") return;
      unsubscribe();
      resolve();
    });
  });

  storage.taskboardStorage.setItem("taskboard.comment-draft.issue-1", "最终草稿");
  await persistedAfterRetry;

  assert.deepEqual(patches, [
    { key: "taskboard.comment-draft.issue-1", value: "最终草稿" },
    { key: "taskboard.comment-draft.issue-1", value: "最终草稿" },
  ]);
  assert.equal(storage.getTaskboardStorageStatus(), "persisted");
});

test("server-backed writes larger than 64 KiB use ordinary acknowledged fetch", async (t) => {
  const patches = [];
  installOpaqueStorageEnvironment(t, async (_url, init) => {
    if (!init?.method) return Response.json({ entries: {} });
    patches.push(init);
    return new Response(null, { status: 204 });
  });

  const storage = await storageModule("large-acknowledged-write");
  await storage.initializeTaskboardStorage();
  const value = "大".repeat(24_000);
  storage.taskboardStorage.setItem("taskboard.comment-draft.issue-large", value);
  await storage.flushTaskboardStorage();

  assert.equal(patches.length, 1);
  assert.ok(Buffer.byteLength(patches[0].body, "utf8") > 64 * 1024);
  assert.equal(patches[0].keepalive, undefined);
  assert.equal(JSON.parse(patches[0].body).value, value);
});

test("pagehide keepalive uses the shared 64 KiB UTF-8 body budget", async (t) => {
  const ordinaryPatches = [];
  const keepalivePatches = [];
  let releaseFirstPatch;
  const firstPatchReleased = new Promise((resolve) => {
    releaseFirstPatch = resolve;
  });
  let markFirstPatchStarted;
  const firstPatchStarted = new Promise((resolve) => {
    markFirstPatchStarted = resolve;
  });

  installOpaqueStorageEnvironment(t, async (_url, init) => {
    if (!init?.method) return Response.json({ entries: {} });
    if (init.keepalive) {
      keepalivePatches.push(init);
      return new Response(null, { status: 204 });
    }
    ordinaryPatches.push(init);
    if (ordinaryPatches.length === 1) {
      markFirstPatchStarted();
      await firstPatchReleased;
    }
    return new Response(null, { status: 204 });
  });

  function valueForPatchBytes(key, targetBytes) {
    const emptyBodyBytes = Buffer.byteLength(JSON.stringify({ key, value: "" }), "utf8");
    const valueBytes = targetBytes - emptyBodyBytes;
    const chinese = "界".repeat(Math.floor(valueBytes / 3));
    return chinese + "a".repeat(valueBytes - Buffer.byteLength(chinese, "utf8"));
  }

  const storage = await storageModule("unload-utf8-budget");
  await storage.initializeTaskboardStorage();
  const oversizedKey = "taskboard.comment-draft.issue-over-budget";
  const boundaryKey = "taskboard.comment-draft.issue-at-budget";
  storage.taskboardStorage.setItem(oversizedKey, valueForPatchBytes(oversizedKey, 64 * 1024 + 1));
  await firstPatchStarted;
  storage.taskboardStorage.setItem(boundaryKey, valueForPatchBytes(boundaryKey, 64 * 1024));

  storage.flushTaskboardStorageForUnload();

  assert.equal(keepalivePatches.length, 1);
  assert.equal(JSON.parse(keepalivePatches[0].body).key, boundaryKey);
  assert.equal(Buffer.byteLength(keepalivePatches[0].body, "utf8"), 64 * 1024);
  assert.equal(keepalivePatches[0].keepalive, true);
  assert.equal(ordinaryPatches[0].keepalive, undefined);

  releaseFirstPatch();
  await storage.flushTaskboardStorage();
});

test("permanent 4xx stops retrying and lets flush complete", async (t) => {
  let patchAttempts = 0;
  installOpaqueStorageEnvironment(t, async (_url, init) => {
    if (!init?.method) return Response.json({ entries: {} });
    patchAttempts += 1;
    return new Response(null, { status: 413 });
  });
  t.mock.method(console, "error", () => {});

  const storage = await storageModule("permanent-client-error");
  await storage.initializeTaskboardStorage();
  storage.taskboardStorage.setItem("taskboard.comment-draft.issue-invalid", "无法保存");
  await storage.flushTaskboardStorage();

  assert.equal(patchAttempts, 1);
  assert.equal(storage.getTaskboardStorageStatus(), "failed");
});

test("flush preserves the latest queued value across destruction and reload", async (t) => {
  const persisted = { "taskboard.comment-draft.issue-2": "旧草稿" };
  const patches = [];
  let releaseFirstPatch;
  const firstPatchReleased = new Promise((resolve) => {
    releaseFirstPatch = resolve;
  });
  let markFirstPatchStarted;
  const firstPatchStarted = new Promise((resolve) => {
    markFirstPatchStarted = resolve;
  });

  installOpaqueStorageEnvironment(t, async (_url, init) => {
    if (!init?.method) {
      return Response.json({ entries: { ...persisted } });
    }
    const patch = JSON.parse(init.body);
    patches.push(patch);
    if (patches.length === 1) {
      markFirstPatchStarted();
      await firstPatchReleased;
    }
    if (patch.value === null) delete persisted[patch.key];
    else persisted[patch.key] = patch.value;
    return new Response(null, { status: 204 });
  });

  const oldFrameStorage = await storageModule("queued-old-frame");
  await oldFrameStorage.initializeTaskboardStorage();
  oldFrameStorage.taskboardStorage.setItem("taskboard.comment-draft.issue-2", "排队旧值");
  await firstPatchStarted;
  oldFrameStorage.taskboardStorage.setItem("taskboard.comment-draft.issue-2", "排队最新值");

  const flushed = oldFrameStorage.flushTaskboardStorage();
  releaseFirstPatch();
  await flushed;

  const reloadedStorage = await storageModule("queued-new-frame");
  await reloadedStorage.initializeTaskboardStorage();
  assert.equal(
    reloadedStorage.taskboardStorage.getItem("taskboard.comment-draft.issue-2"),
    "排队最新值",
  );
  assert.deepEqual(patches.map((patch) => patch.value), ["排队旧值", "排队最新值"]);
});

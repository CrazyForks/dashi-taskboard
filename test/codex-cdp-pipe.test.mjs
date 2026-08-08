import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

import {
  CdpPipeBrowser,
  validatedLoopbackCdpWebSocketUrl,
} from "../scripts/codex-cdp-pipe.mjs";

test("the development TCP bridge accepts only its exact loopback page endpoint", () => {
  assert.equal(
    validatedLoopbackCdpWebSocketUrl(
      "ws://127.0.0.1:9231/devtools/page/target-id",
      9231,
    ),
    "ws://127.0.0.1:9231/devtools/page/target-id",
  );
  assert.throws(
    () => validatedLoopbackCdpWebSocketUrl(
      "ws://127.0.0.1:9232/devtools/page/target-id",
      9231,
    ),
    /Rejected unexpected Codex CDP target URL/,
  );
  assert.throws(
    () => validatedLoopbackCdpWebSocketUrl(
      "ws://example.com:9231/devtools/page/target-id",
      9231,
    ),
    /Rejected unexpected Codex CDP target URL/,
  );
});

test("the private browser transport exchanges NUL-delimited CDP messages over inherited pipes", async () => {
  const child = new EventEmitter();
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()];
  const browser = new CdpPipeBrowser(child);
  const requests = [];
  child.stdio[3].on("data", (chunk) => {
    for (const source of chunk.toString("utf8").split("\0").filter(Boolean)) {
      const request = JSON.parse(source);
      requests.push(request);
      child.stdio[4].write(`${JSON.stringify({ id: request.id, result: {} })}\0`);
    }
  });

  await browser.open();
  assert.deepEqual(
    requests.map((request) => request.method),
    ["Browser.getVersion", "Target.setDiscoverTargets"],
  );
  assert.equal(requests.some((request) => "url" in request), false);
  browser.close();
});

test("private pipe failures share one unhealthy transport state", async () => {
  const createChild = (input = new PassThrough(), output = new PassThrough()) => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdio = [null, null, null, input, output];
    return child;
  };

  const eofChild = createChild();
  const eofBrowser = new CdpPipeBrowser(eofChild);
  eofChild.stdio[4].end();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eofBrowser.closed, true);
  assert.equal(eofChild.exitCode, null);

  const errorChild = createChild();
  const errorBrowser = new CdpPipeBrowser(errorChild);
  errorChild.emit("error", new Error("spawn failed"));
  assert.equal(errorBrowser.closed, true);

  const exitChild = createChild();
  const exitBrowser = new CdpPipeBrowser(exitChild);
  exitChild.emit("exit", 1, null);
  assert.equal(exitBrowser.closed, true);

  const failedInput = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("transport write failed"));
    },
  });
  const sendBrowser = new CdpPipeBrowser(createChild(failedInput));
  await assert.rejects(sendBrowser.send("Browser.getVersion"), /transport write failed/);
  assert.equal(sendBrowser.closed, true);
});

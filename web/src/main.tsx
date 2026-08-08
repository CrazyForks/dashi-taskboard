import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { postEmbeddedHostMessage } from "./embeddedHost.mjs";
import {
  flushTaskboardStorage,
  flushTaskboardStorageForUnload,
  initializeTaskboardStorage,
} from "./storage";
import "./styles.css";

async function main() {
  await initializeTaskboardStorage();
  window.addEventListener("pagehide", () => {
    flushTaskboardStorageForUnload();
  });
  const root = createRoot(document.getElementById("root")!);
  function stopForStorageFlush(requestId: string) {
    root.unmount();
    void flushTaskboardStorage().then(() => {
      postEmbeddedHostMessage({
        type: "taskboard:storage-flushed",
        payload: { requestId },
      });
    });
  }
  root.render(
    <StrictMode>
      <App onStorageFlush={stopForStorageFlush} />
    </StrictMode>,
  );
}

void main();

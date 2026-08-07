const { invoke } = window.__TAURI__.core;

const version = document.querySelector("#version");
const statusDot = document.querySelector("#status-dot");
const launcherMessage = document.querySelector("#launcher-message");
const updateMessage = document.querySelector("#update-message");
const restartButton = document.querySelector("#restart-button");
const checkButton = document.querySelector("#check-button");

function render(snapshot) {
  version.textContent = `版本 ${snapshot.version}`;
  statusDot.className = `status-dot ${snapshot.phase}`;
  launcherMessage.textContent = snapshot.message;
  updateMessage.textContent = snapshot.updateMessage;
}

async function refresh() {
  try {
    render(await invoke("launcher_status"));
  } catch (error) {
    launcherMessage.textContent = `无法读取启动状态：${error}`;
    statusDot.className = "status-dot error";
  }
}

async function run(button, command) {
  button.disabled = true;
  try {
    render(await invoke(command));
  } catch (error) {
    updateMessage.textContent = `操作失败：${error}`;
  } finally {
    button.disabled = false;
    await refresh();
  }
}

restartButton.addEventListener("click", () => run(restartButton, "restart_launcher"));
checkButton.addEventListener("click", () => run(checkButton, "check_for_updates"));

refresh();
setInterval(refresh, 1_000);

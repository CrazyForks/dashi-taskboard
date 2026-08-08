#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command as StdCommand,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{ActivationPolicy, AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tauri_plugin_updater::{Update, UpdaterExt};

const LAUNCHER_PORT: &str = "9231";
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherSnapshot {
    phase: String,
    message: String,
    update_message: String,
    update_available: bool,
    version: String,
    app_path: Option<String>,
    child_pid: Option<u32>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPidRecord {
    pid: u32,
    node_path: PathBuf,
    injector_path: PathBuf,
}

struct LauncherState {
    child: Mutex<Option<tauri_plugin_shell::process::CommandChild>>,
    snapshot: Mutex<LauncherSnapshot>,
    intentional_stop: AtomicBool,
    data_directory: PathBuf,
    log_path: PathBuf,
    pid_record_path: PathBuf,
}

impl LauncherState {
    fn new(data_directory: PathBuf, log_directory: PathBuf, version: String) -> Self {
        Self {
            child: Mutex::new(None),
            snapshot: Mutex::new(LauncherSnapshot {
                phase: "starting".into(),
                message: "正在启动任务面板…".into(),
                update_message: "启动后将自动检查更新。".into(),
                update_available: false,
                version,
                app_path: None,
                child_pid: None,
            }),
            intentional_stop: AtomicBool::new(false),
            pid_record_path: data_directory.join("launcher-child.json"),
            data_directory,
            log_path: log_directory.join("codex-taskboard-launcher.log"),
        }
    }
}

fn update_snapshot(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    update: impl FnOnce(&mut LauncherSnapshot),
) -> LauncherSnapshot {
    let snapshot = {
        let mut snapshot = state.snapshot.lock().unwrap();
        update(&mut snapshot);
        snapshot.clone()
    };
    let _ = app.emit("launcher-status", snapshot.clone());
    snapshot
}

fn append_log(state: &LauncherState, line: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.log_path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn find_codex_app(home_directory: &Path) -> Option<PathBuf> {
    [
        PathBuf::from("/Applications/ChatGPT.app"),
        home_directory.join("Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
        home_directory.join("Applications/Codex.app"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_dir())
}

fn process_is_running(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn send_sigterm(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

fn send_sigkill(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    !process_is_running(pid)
}

fn process_matches_record(record: &LauncherPidRecord) -> bool {
    let output = StdCommand::new("/bin/ps")
        .args(["-p", &record.pid.to_string(), "-o", "command="])
        .output();
    let Ok(output) = output else {
        return false;
    };
    let command = String::from_utf8_lossy(&output.stdout);
    command.contains(&*record.node_path.to_string_lossy())
        && command.contains(&*record.injector_path.to_string_lossy())
}

fn stop_stale_processes(state: &LauncherState) {
    let process_list = StdCommand::new("/bin/ps")
        .args(["-axo", "pid=,command="])
        .output();
    let Ok(process_list) = process_list else {
        return;
    };

    for line in String::from_utf8_lossy(&process_list.stdout).lines() {
        let Some((pid, command)) = line.trim().split_once(char::is_whitespace) else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else {
            continue;
        };
        let is_launcher = command
            .contains("/Codex Taskboard.app/Contents/Resources/app/scripts/codex-injector.mjs")
            && command.contains(" --launch ")
            && command.contains(" --watch ")
            && command.contains(" --open ")
            && command.contains(" --port 9231");
        let is_service =
            command.contains("/Codex Taskboard.app/Contents/Resources/app/server/index.mjs");
        if is_launcher || is_service {
            append_log(state, &format!("Stopping stale taskboard process {pid}"));
            send_sigterm(pid);
            if !wait_for_process_exit(pid, STOP_TIMEOUT) {
                append_log(
                    state,
                    &format!("Force stopping stale taskboard process {pid}"),
                );
                send_sigkill(pid);
                let _ = wait_for_process_exit(pid, Duration::from_secs(1));
            }
        }
    }
}

fn stop_recorded_child(state: &LauncherState) {
    let record = fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok());
    if let Some(record) = record {
        if process_matches_record(&record) {
            send_sigterm(record.pid);
            if !wait_for_process_exit(record.pid, STOP_TIMEOUT) && process_matches_record(&record) {
                send_sigkill(record.pid);
                let _ = wait_for_process_exit(record.pid, Duration::from_secs(1));
            }
        }
    }
    let _ = fs::remove_file(&state.pid_record_path);
}

fn write_pid_record(
    state: &LauncherState,
    pid: u32,
    node_path: PathBuf,
    injector_path: PathBuf,
) -> Result<(), String> {
    let record = LauncherPidRecord {
        pid,
        node_path,
        injector_path,
    };
    let content = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    fs::write(&state.pid_record_path, content).map_err(|error| error.to_string())
}

fn clear_pid_record(state: &LauncherState, pid: u32) {
    let matches = fs::read_to_string(&state.pid_record_path)
        .ok()
        .and_then(|content| serde_json::from_str::<LauncherPidRecord>(&content).ok())
        .is_some_and(|record| record.pid == pid);
    if matches {
        let _ = fs::remove_file(&state.pid_record_path);
    }
}

fn stop_managed_child(app: &AppHandle, state: &Arc<LauncherState>) {
    state.intentional_stop.store(true, Ordering::SeqCst);
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        let pid = child.pid();
        append_log(state, &format!("Stopping launcher child {pid}"));
        send_sigterm(pid);
        if !wait_for_process_exit(pid, STOP_TIMEOUT) {
            let _ = child.kill();
            let _ = wait_for_process_exit(pid, Duration::from_secs(1));
        }
        clear_pid_record(state, pid);
    }
    stop_stale_processes(state);
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "stopped".into();
        snapshot.message = "任务面板已停止。".into();
        snapshot.child_pid = None;
    });
}

fn start_launcher(app: &AppHandle, state: &Arc<LauncherState>) -> Result<LauncherSnapshot, String> {
    if state.snapshot.lock().unwrap().child_pid.is_some() {
        return Ok(state.snapshot.lock().unwrap().clone());
    }

    let home_directory = app.path().home_dir().map_err(|error| error.to_string())?;
    let codex_app = find_codex_app(&home_directory).ok_or_else(|| {
        "未找到官方 ChatGPT.app 或 Codex.app。请先安装到 Applications 文件夹。".to_string()
    })?;
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let app_root = resource_directory.join("app");
    let injector_path = app_root.join("scripts/codex-injector.mjs");
    let node_path = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or_else(|| "无法定位 App 可执行文件目录".to_string())?
        .join("node");
    stop_stale_processes(state);
    stop_recorded_child(state);
    state.intentional_stop.store(false, Ordering::SeqCst);
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "starting".into();
        snapshot.message = "正在启动任务面板服务…".into();
        snapshot.app_path = Some(codex_app.display().to_string());
    });

    let path_value = format!(
        "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        resource_directory.join("bin").display()
    );
    let arguments = vec![
        injector_path.as_os_str().to_owned(),
        OsString::from("--launch"),
        OsString::from("--watch"),
        OsString::from("--open"),
        OsString::from("--port"),
        OsString::from(LAUNCHER_PORT),
        OsString::from("--app-path"),
        codex_app.as_os_str().to_owned(),
    ];
    let (mut receiver, child) = app
        .shell()
        .sidecar("node")
        .map_err(|error| error.to_string())?
        .args(arguments)
        .env("CODEX_TASKBOARD_DATA_DIR", &state.data_directory)
        .env("CODEX_TASKBOARD_HOST", "127.0.0.1")
        .env("HOST", "127.0.0.1")
        .env("PATH", path_value)
        .current_dir(&app_root)
        .spawn()
        .map_err(|error| error.to_string())?;
    let pid = child.pid();
    if let Err(error) = write_pid_record(state, pid, node_path, injector_path) {
        let _ = child.kill();
        return Err(error);
    }
    *state.child.lock().unwrap() = Some(child);
    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.child_pid = Some(pid);
    });
    append_log(state, &format!("Started launcher child {pid}"));

    let event_app = app.clone();
    let event_state = state.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    append_log(&event_state, &line);
                    if line.contains("Codex Taskboard listening") {
                        update_snapshot(&event_app, &event_state, |snapshot| {
                            snapshot.phase = "starting".into();
                            snapshot.message = "任务面板服务已启动，正在注入 Codex…".into();
                        });
                    } else if line.contains("\"injected\"") {
                        update_snapshot(&event_app, &event_state, |snapshot| {
                            snapshot.phase = "running".into();
                            snapshot.message = "任务面板已在 Codex 客户端中打开。".into();
                        });
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    append_log(&event_state, &line);
                    if line.contains("Waiting for Codex") {
                        update_snapshot(&event_app, &event_state, |snapshot| {
                            snapshot.message = "正在等待 Codex 窗口…".into();
                        });
                    }
                }
                CommandEvent::Error(error) => {
                    append_log(&event_state, &format!("Launcher process error: {error}"));
                    update_snapshot(&event_app, &event_state, |snapshot| {
                        snapshot.phase = "error".into();
                        snapshot.message = format!("任务面板进程出错：{error}");
                    });
                }
                CommandEvent::Terminated(payload) => {
                    append_log(
                        &event_state,
                        &format!(
                            "Launcher child {pid} exited: code={:?}, signal={:?}",
                            payload.code, payload.signal
                        ),
                    );
                    let current_pid = event_state.snapshot.lock().unwrap().child_pid;
                    if current_pid == Some(pid) {
                        event_state.child.lock().unwrap().take();
                        clear_pid_record(&event_state, pid);
                        let intentional = event_state.intentional_stop.load(Ordering::SeqCst);
                        update_snapshot(&event_app, &event_state, |snapshot| {
                            snapshot.child_pid = None;
                            if !intentional {
                                snapshot.phase = "error".into();
                                snapshot.message = "任务面板进程已退出，可重新启动。".into();
                            }
                        });
                    }
                }
                _ => {}
            }
        }
    });
    Ok(snapshot)
}

async fn check_for_startup_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<Option<Update>, String> {
    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = "正在检查更新…".into();
        snapshot.update_available = false;
    });
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    match &update {
        Some(update) => {
            append_log(state, &format!("Update {} is available", update.version));
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message =
                    format!("发现新版本 {}，可以下载并安装。", update.version);
                snapshot.update_available = true;
            });
        }
        None => {
            append_log(state, "No update is available");
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = "当前已是最新版本。".into();
                snapshot.update_available = false;
            });
        }
    }
    Ok(update)
}

async fn install_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    update: Update,
) -> Result<(), String> {
    let update_version = update.version.clone();
    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = format!("正在下载版本 {update_version}…");
        snapshot.update_available = false;
    });
    let progress_app = app.clone();
    let progress_state = Arc::clone(state);
    let progress_version = update_version.clone();
    let finish_app = app.clone();
    let finish_state = Arc::clone(state);
    let mut downloaded = 0_u64;
    let bytes = match update
        .download(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                update_snapshot(&progress_app, &progress_state, |snapshot| {
                    snapshot.update_message = match content_length.filter(|total| *total > 0) {
                        Some(total) => format!(
                            "正在下载版本 {progress_version}：{}%",
                            downloaded
                                .saturating_mul(100)
                                .saturating_div(total)
                                .min(100)
                        ),
                        None => format!("正在下载版本 {progress_version}…"),
                    };
                });
            },
            move || {
                update_snapshot(&finish_app, &finish_state, |snapshot| {
                    snapshot.update_message = "下载完成，正在验证更新签名…".into();
                });
            },
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            append_log(&state, &format!("Update download failed: {error}"));
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = format!("更新下载或签名验证失败：{error}");
                snapshot.update_available = true;
            });
            return Err(error.to_string());
        }
    };

    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = "更新签名验证通过，正在安装…".into();
    });
    stop_managed_child(app, state);
    if let Err(error) = update.install(&bytes) {
        append_log(&state, &format!("Update installation failed: {error}"));
        let restart_error = start_launcher(app, state).err();
        if let Some(restart_error) = &restart_error {
            append_log(
                &state,
                &format!("Taskboard restart after update failure failed: {restart_error}"),
            );
        } else {
            append_log(
                &state,
                "Taskboard restarted after update installation failure",
            );
        }
        update_snapshot(app, state, |snapshot| {
            snapshot.update_message = format!("更新安装失败：{error}");
            snapshot.update_available = true;
            if let Some(restart_error) = &restart_error {
                snapshot.phase = "error".into();
                snapshot.message = format!("任务面板恢复失败：{restart_error}");
            }
        });
        return Err(error.to_string());
    }

    append_log(
        &state,
        &format!("Installed update {update_version}; restarting"),
    );
    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = format!("版本 {update_version} 已安装，正在重启…");
    });
    app.restart()
}

async fn offer_startup_update(app: &AppHandle, state: &Arc<LauncherState>) {
    let update = match check_for_startup_update(app, state).await {
        Ok(update) => update,
        Err(error) => {
            append_log(state, &format!("Startup update check failed: {error}"));
            return;
        }
    };
    let Some(update) = update else {
        return;
    };

    let version = update.version.clone();
    append_log(state, &format!("Showing update prompt for {version}"));
    let install_now = app
        .dialog()
        .message(format!(
            "发现 Codex Taskboard {version}。是否现在下载、安装并重启？"
        ))
        .title("Codex Taskboard 更新")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "立即更新".into(),
            "稍后".into(),
        ))
        .blocking_show();
    if !install_now {
        append_log(state, &format!("Update {version} deferred by user"));
        return;
    }
    append_log(state, &format!("Update {version} accepted by user"));
    if let Err(error) = install_update(app, state, update).await {
        append_log(
            state,
            &format!("Startup update installation failed: {error}"),
        );
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.set_activation_policy(ActivationPolicy::Accessory);
            let home_directory = app.path().home_dir()?;
            let data_directory = home_directory.join("Library/Application Support/Codex Taskboard");
            let log_directory = home_directory.join("Library/Logs/Codex Taskboard");
            fs::create_dir_all(&data_directory)?;
            fs::create_dir_all(&log_directory)?;
            let version = app.package_info().version.to_string();
            let state = Arc::new(LauncherState::new(data_directory, log_directory, version));
            app.manage(state.clone());

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start_launcher(&app_handle, &state) {
                    append_log(&state, &format!("Launcher startup failed: {error}"));
                    update_snapshot(&app_handle, &state, |snapshot| {
                        snapshot.phase = "error".into();
                        snapshot.message = error;
                    });
                }
                offer_startup_update(&app_handle, &state).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Codex Taskboard");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            let state = app_handle.state::<Arc<LauncherState>>();
            stop_managed_child(app_handle, &state);
        }
    });
}

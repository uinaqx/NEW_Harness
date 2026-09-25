#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Harness desktop shell.
//!
//! Responsibilities (see OPENCODE-IMPLEMENTATION-PLAN.md phase 4):
//!   * own the backend process and put it in a Windows Job Object so the whole
//!     process tree (backend -> OpenCode engine -> tools) dies with the app;
//!   * wait for the backend's startup handshake and verify its *identity*
//!     (`/health` must report the instance id the handshake file claims) before
//!     handing the endpoint to the webview;
//!   * inject that endpoint into the webview, so no port or token is hard-coded;
//!   * exit when the window closes (no hide-to-tray daemon behaviour);
//!   * log startup stages and exit codes to a redacted log file.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Used to decide whether the embedded backend payload is stale.
const BACKEND_VERSION: &str = env!("CARGO_PKG_VERSION");
/// The compiled Bun backend, embedded at build time.
const BACKEND_BYTES: &[u8] = include_bytes!("../bin/harness-backend.exe");

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);

struct ShellState {
    process: Mutex<Option<Child>>,
    shutting_down: AtomicBool,
    log_path: PathBuf,
}

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW
    command.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

fn data_dir() -> PathBuf {
    // HARNESS_DATA_DIR lets a portable run (and the automated lifecycle check) use
    // an isolated data directory. The backend child inherits the variable, so both
    // halves of the startup handshake agree on where runtime.json lives.
    if let Some(override_dir) = std::env::var_os("HARNESS_DATA_DIR") {
        if !override_dir.is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir);
    base.join("Harness").join("data")
}

fn log_line(log_path: &Path, message: &str) {
    let line = format!("{} {}\n", timestamp(), message);
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Seconds since the Unix epoch, formatted without pulling in a date crate.
fn timestamp() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    format!("[{}s]", now.as_secs())
}

/* ------------------------------------------------------------------ */
/* Minimal Win32 job object binding                                    */
/* ------------------------------------------------------------------ */

#[cfg(windows)]
mod job {
    use std::ffi::c_void;

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_TERMINATE: u32 = 0x0001;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(job: *mut c_void, class: i32, info: *mut c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    /// A job object whose handle is kept for the whole process lifetime: when the
    /// shell exits (or is killed) the last handle closes and Windows terminates
    /// every process still in the job, so no backend or engine can survive us.
    pub struct JobGuard {
        handle: *mut c_void,
    }

    unsafe impl Send for JobGuard {}
    unsafe impl Sync for JobGuard {}

    impl JobGuard {
        pub fn create() -> Option<JobGuard> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let mut info = ExtendedLimitInformation {
                    basic: BasicLimitInformation {
                        per_process_user_time_limit: 0,
                        per_job_user_time_limit: 0,
                        limit_flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                        minimum_working_set_size: 0,
                        maximum_working_set_size: 0,
                        active_process_limit: 0,
                        affinity: 0,
                        priority_class: 0,
                        scheduling_class: 0,
                    },
                    io: IoCounters {
                        read_operation_count: 0,
                        write_operation_count: 0,
                        other_operation_count: 0,
                        read_transfer_count: 0,
                        write_transfer_count: 0,
                        other_transfer_count: 0,
                    },
                    process_memory_limit: 0,
                    job_memory_limit: 0,
                    peak_process_memory_used: 0,
                    peak_job_memory_used: 0,
                };
                let ok = SetInformationJobObject(
                    handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<ExtendedLimitInformation>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(JobGuard { handle })
            }
        }

        pub fn assign(&self, pid: u32) -> bool {
            unsafe {
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return false;
                }
                let ok = AssignProcessToJobObject(self.handle, process);
                CloseHandle(process);
                ok != 0
            }
        }
    }
}

#[cfg(not(windows))]
mod job {
    pub struct JobGuard;
    impl JobGuard {
        pub fn create() -> Option<JobGuard> {
            Some(JobGuard)
        }
        pub fn assign(&self, _pid: u32) -> bool {
            false
        }
    }
}

/* ------------------------------------------------------------------ */
/* Backend materialisation                                             */
/* ------------------------------------------------------------------ */

fn runtime_dir() -> PathBuf {
    data_dir().join("runtime")
}

mod payload;

fn materialize_backend(log_path: &Path) -> Option<PathBuf> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    match payload::stage(&runtime_dir(), BACKEND_BYTES, extension) {
        Ok(path) => {
            log_line(log_path, &format!("backend SHA-256 verified: {}", path.display()));
            Some(path)
        }
        Err(error) => {
            log_line(log_path, &format!("backend staging failed: {error}"));
            None
        }
    }
}

fn resolve_backend_path(log_path: &Path) -> Option<PathBuf> {
    materialize_backend(log_path)
}

/* ------------------------------------------------------------------ */
/* Startup handshake                                                   */
/* ------------------------------------------------------------------ */

#[derive(serde::Deserialize, Clone)]
struct Handshake {
    pid: u32,
    port: u16,
    path: String,
    token: String,
    #[serde(rename = "instanceId")]
    instance_id: String,
    #[serde(rename = "appVersion")]
    app_version: String,
}

fn read_handshake() -> Option<Handshake> {
    let text = fs::read_to_string(data_dir().join("runtime.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// HTTP GET with a tiny hand-rolled client: the shell must not depend on the
/// backend being able to answer anything more than `/health`.
fn http_get(port: u16, path: &str) -> Option<String> {
    let address = format!("127.0.0.1:{port}");
    let socket = address.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&socket, Duration::from_millis(900)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(2000))).ok()?;
    write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").ok()?;
    let mut buffer = String::new();
    stream.read_to_string(&mut buffer).ok()?;
    Some(buffer)
}

/// Wait for the backend to publish a handshake *and* prove it is the process we
/// started: the port must answer `/health` with the same instance id and version.
fn await_backend(log_path: &Path, started: Instant) -> Option<Handshake> {
    let mut last_reason = String::from("no handshake yet");
    while started.elapsed() < HANDSHAKE_TIMEOUT {
        if let Some(handshake) = read_handshake() {
            let verified = http_get(handshake.port, "/health")
                .map(|body| body.contains(&handshake.instance_id) && body.contains(&handshake.app_version))
                .unwrap_or(false);
            if verified {
                log_line(
                    log_path,
                    &format!(
                        "handshake verified: instance={} port={} appVersion={}",
                        handshake.instance_id, handshake.port, handshake.app_version
                    ),
                );
                return Some(handshake);
            }
            last_reason = format!(
                "handshake file claims port {} but /health did not confirm instance {}",
                handshake.port, handshake.instance_id
            );
        }
        thread::sleep(Duration::from_millis(220));
    }
    log_line(log_path, &format!("startup timed out: {last_reason}"));
    None
}

/* ------------------------------------------------------------------ */
/* Backend process                                                     */
/* ------------------------------------------------------------------ */

/// Locate the engine that ships with the app (next to the shell or under resources).
///
/// The backend runs from the data directory, so it cannot find the packaged
/// engine by relative path; the shell resolves it and hands the path over.
fn resolve_engine_path() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    let parent = current.parent()?;
    for candidate in [
        parent.join("opencode").join("opencode.exe"),
        parent.join("resources").join("opencode").join("opencode.exe"),
        parent.join("..").join("resources").join("opencode").join("opencode.exe"),
        parent.join("..").join("..").join("vendor").join("opencode").join("bin").join("opencode.exe"),
    ] {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_skills_path() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    let parent = current.parent()?;
    for candidate in [
        parent.join("skills"),
        parent.join("resources").join("skills"),
        parent.join("..").join("resources").join("skills"),
        parent.join("..").join("..").join("vendor").join("skills"),
    ] {
        if candidate.join("MANIFEST.json").exists() { return Some(candidate); }
    }
    None
}

fn spawn_backend(state: &Arc<ShellState>, job: &Option<Arc<job::JobGuard>>) -> bool {
    let log_path = state.log_path.clone();
    let Some(binary) = resolve_backend_path(&log_path) else {
        log_line(&log_path, "startup failed: backend binary unavailable");
        return false;
    };
    let work_dir = binary.parent().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let mut command = Command::new(&binary);
    command
        .current_dir(&work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(engine) = resolve_engine_path() {
        command.env("HARNESS_OPENCODE_BIN", &engine);
        log_line(&log_path, &format!("engine for the backend: {}", engine.display()));
    } else {
        log_line(&log_path, "WARNING: no engine binary found next to the shell; rely on the backend search order");
    }
    if let Some(skills) = resolve_skills_path() {
        command.env("HARNESS_SKILLS_DIR", skills);
    }
    hide_console(&mut command);
    match command.spawn() {
        Ok(mut child) => {
            log_line(&log_path, &format!("backend spawned pid={} from {}", child.id(), binary.display()));
            if let Some(guard) = job {
                // Assigning immediately after spawn keeps the engine (which the
                // backend starts later) inside the same job.
                if guard.assign(child.id()) {
                    log_line(&log_path, "backend assigned to the kill-on-close job object");
                } else {
                    log_line(&log_path, "WARNING: could not assign the backend to the job object");
                }
            }
            if let Some(stdout) = child.stdout.take() {
                drain(stdout);
            }
            if let Some(stderr) = child.stderr.take() {
                drain(stderr);
            }
            *state.process.lock().unwrap() = Some(child);
            true
        }
        Err(error) => {
            log_line(&log_path, &format!("startup failed: {error}"));
            false
        }
    }
}

/// Stop a process tree by PID (never a name-based sweep, so an independently
/// installed OpenCode belonging to the user is left alone).
#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .status();
}

fn drain<R: Read + Send + 'static>(mut reader: R) {
    thread::spawn(move || {
        let mut buffer = [0u8; 2048];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
        }
    });
}

/// Stop only the process we started, and its tree.
fn stop_backend(state: &Arc<ShellState>) {
    state.shutting_down.store(true, Ordering::Release);
    let guard = state.process.lock().unwrap().take();
    if let Some(mut child) = guard {
        let pid = child.id();
        log_line(&state.log_path, &format!("stopping backend pid={pid}"));
        #[cfg(windows)]
        {
            kill_process_tree(pid);
        }
        #[cfg(not(windows))]
        {
            let _ = child.kill();
        }
        match child.wait() {
            Ok(status) => log_line(&state.log_path, &format!("backend exited with {status}")),
            Err(error) => log_line(&state.log_path, &format!("backend wait failed: {error}")),
        }
    }
    let _ = fs::remove_file(data_dir().join("runtime.json"));
}

/// Restart the backend if it died while the app is still open.
///
/// Bounded on purpose: the plan forbids an endless restart loop, so after
/// `MAX_BACKEND_RESTARTS` consecutive failures the shell stops trying and says so
/// in the log (the UI shows its own "cannot reach the backend" panel).
fn watchdog(state: Arc<ShellState>, job: Option<Arc<job::JobGuard>>, app: tauri::AppHandle) {
    const MAX_BACKEND_RESTARTS: u32 = 5;
    let mut restarts: u32 = 0;
    loop {
        thread::sleep(Duration::from_secs(3));
        if state.shutting_down.load(Ordering::Acquire) {
            break;
        }
        let dead = {
            let mut guard = state.process.lock().unwrap();
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => Some(format!("backend exited unexpectedly: {status}")),
                    Ok(None) => None,
                    Err(error) => Some(format!("backend status error: {error}")),
                },
                None => Some("backend process missing".to_string()),
            }
        };
        match dead {
            None => restarts = 0,
            Some(reason) => {
                if restarts >= MAX_BACKEND_RESTARTS {
                    log_line(
                        &state.log_path,
                        &format!("{reason}; giving up after {restarts} restarts (no endless restart loop)"),
                    );
                    // Park the watchdog: keep the process alive but stop respawning.
                    while !state.shutting_down.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_secs(2));
                    }
                    break;
                }
                restarts += 1;
                log_line(&state.log_path, &format!("{reason}; restart attempt {restarts}/{MAX_BACKEND_RESTARTS}"));
                if spawn_backend(&state, &job) {
                    if let Some(handle) = await_backend(&state.log_path, Instant::now()) {
                        if let Some(window) = app.get_webview_window("main") {
                            let endpoint = serde_json::json!({"port":handle.port,"host":"127.0.0.1","path":handle.path,"token":handle.token,"instanceId":handle.instance_id});
                            let _ = window.eval(&format!("window.__HARNESS__ = {endpoint}; window.dispatchEvent(new Event('harness-endpoint-changed'));"));
                        }
                    }
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

fn main() {
    let log_path = data_dir().join("logs").join("shell.log");
    log_line(&log_path, &format!("shell starting v{BACKEND_VERSION}"));
    let job = job::JobGuard::create().map(Arc::new);
    if job.is_none() {
        log_line(
            &log_path,
            "WARNING: job object unavailable; falling back to explicit taskkill on exit",
        );
    }
    let state = Arc::new(ShellState {
        process: Mutex::new(None),
        shutting_down: AtomicBool::new(false),
        log_path: log_path.clone(),
    });

    let state_for_setup = state.clone();
    let state_for_run = state.clone();
    let job_for_setup = job.clone();
    let job_for_watchdog = job.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second launch: focus the existing window instead of starting again.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(state.clone())
        .setup(move |app| {
            let log = state_for_setup.log_path.clone();
            if !spawn_backend(&state_for_setup, &job_for_setup) {
                log_line(&log, "backend did not start; the UI will show the diagnostics entry point");
            }
            let started = Instant::now();
            let handshake = await_backend(&log, started);
            let headless = std::env::var_os("HARNESS_HEADLESS").is_some();

            // Inject the verified endpoint so nothing is hard-coded in the UI.
            let script = match &handshake {
                Some(handle) => {
                    let token = serde_json::to_string(&handle.token).unwrap_or_else(|_| "\"\"".into());
                    let instance = serde_json::to_string(&handle.instance_id).unwrap_or_else(|_| "\"\"".into());
                    format!(
                        "window.__HARNESS__ = {{ port: {}, host: \"127.0.0.1\", path: \"{}\", token: {}, instanceId: {} }};",
                        handle.port, handle.path, token, instance
                    )
                }
                None => "window.__HARNESS__ = { unavailable: true };".to_string(),
            };

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("某科学的Agent")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .resizable(true)
                // Headless mode keeps the window (and therefore the app) alive without
                // showing anything: used by the automated lifecycle check.
                .visible(!headless)
                .initialization_script(&script)
                .build()?;

            let watchdog_state = state_for_setup.clone();
            let watchdog_app = app.handle().clone();
            thread::spawn(move || watchdog(watchdog_state, job_for_watchdog, watchdog_app));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Harness shell");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            stop_backend(&state_for_run);
        }
    });
}

#[allow(dead_code)]
fn assert_handshake_fields_used(handshake: &Handshake) -> u32 {
    // Keeps the `pid` field meaningful for diagnostics even though the shell now
    // tracks the child handle directly.
    handshake.pid
}

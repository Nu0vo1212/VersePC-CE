//! FRP **本地隧道**：直接在本机运行内置的 `frpc.exe`（Windows），
//! 连到云端已部署好的 `frps`，把「本地端口」映射为「云端端口」。
//!
//! 与 [`super::frp`] 的分工：
//! - `frp.rs` 负责**远端**（SSH 部署 frps / 放行端口 / 卸载）；
//! - 本模块负责**本机**（把 frpc.exe 拉起来当子进程跑，并看住它）。
//!
//! ## 为什么用 `std::process` 而不是 `tokio::process`
//! 子进程需要「随时可查存活 / 随时可杀」，而 tokio 的 `Child::try_wait` 是 `async`，
//! 在 watchdog 里就得持锁跨 `await`，很容易踩 Send/死锁的坑。
//! 用标准库的同步 `Child`：`try_wait()`/`kill()` 全是同步，状态用 `std::sync::Mutex` 即可，
//! 读日志交给独立线程，简单且不会阻塞 UI。
//!
//! ## 心跳（keepalive）
//! 桌面端在 NAT 后面，链路被静默丢弃时 frpc 往往"看起来还在跑"。
//! 这里做两层保障：
//! 1. **协议层**：生成的配置显式写入 `transport.heartbeatInterval` / `heartbeatTimeout`，
//!    让 frpc 与 frps 之间按时互发心跳、及时感知断链并自愈重连；
//! 2. **进程层**：独立 watchdog 线程每 3 秒 `try_wait()` 一次，进程若真的退出，
//!    在 `autoRestart` 打开时自动拉起，并把退出原因推到界面。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// 日志环形缓冲上限（超出丢弃最旧的）
const MAX_LOCAL_LOGS: usize = 1000;
/// watchdog 巡检间隔
const WATCH_INTERVAL: Duration = Duration::from_secs(3);
/// 自动重连前的等待（给云端一点恢复时间）
const RESTART_DELAY: Duration = Duration::from_secs(2);
/// 运行不足这个秒数就退出，视为「启动即失败」（多半是配置 / 令牌 / 网络问题）
const RAPID_EXIT_SECS: u64 = 15;
/// 连续「启动即失败」达到这个次数就停止自动重连，避免无限重启刷屏
const MAX_AUTO_RESTARTS: u32 = 5;
/// Windows `CREATE_NO_WINDOW`：避免拉起 frpc.exe 时闪出黑色控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn d_server_port() -> u16 {
    3221
}
fn d_proxy_type() -> String {
    "tcp".to_string()
}
fn d_proxy_name() -> String {
    "default".to_string()
}
fn d_local_ip() -> String {
    "127.0.0.1".to_string()
}
fn d_hb_interval() -> u64 {
    10
}
fn d_hb_timeout() -> u64 {
    30
}
fn d_true() -> bool {
    true
}

/// 本地隧道参数（前端 camelCase 传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTunnelOptions {
    /// frps 地址（云端服务器 IP / 域名）
    pub server_addr: String,
    #[serde(default = "d_server_port")]
    pub server_port: u16,
    /// 与 frps 一致的连接令牌
    #[serde(default)]
    pub token: String,
    #[serde(default = "d_proxy_name")]
    pub proxy_name: String,
    #[serde(default = "d_proxy_type")]
    pub proxy_type: String,
    /// 被映射的本地地址（一般 127.0.0.1）
    #[serde(default = "d_local_ip")]
    pub local_ip: String,
    /// 被映射的本地端口
    pub local_port: u16,
    /// 云端映射端口（0 = 未指定，由云端流程自动分配）
    #[serde(default)]
    pub remote_port: u16,
    /// 心跳间隔（秒）
    #[serde(default = "d_hb_interval")]
    pub heartbeat_interval: u64,
    /// 心跳超时（秒），必须大于间隔
    #[serde(default = "d_hb_timeout")]
    pub heartbeat_timeout: u64,
    /// 进程异常退出后自动重连
    #[serde(default = "d_true")]
    pub auto_restart: bool,
    /// 自定义 frpc.exe 路径（留空用内置）
    #[serde(default)]
    pub binary_path: Option<String>,
}

/// 单条本地日志
#[derive(Debug, Clone, Serialize)]
pub struct LocalLogLine {
    pub level: String,
    pub message: String,
}

/// 本地隧道运行状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    pub running: bool,
    pub pid: Option<u32>,
    /// 已运行秒数（未运行时为 0）
    pub uptime_secs: u64,
    pub config_path: Option<String>,
    pub binary_path: Option<String>,
    /// 因异常退出而自动重连的次数
    pub restarts: u32,
    /// 最近一次退出原因
    pub last_exit: Option<String>,
}

/// 进程运行期状态（受一把 std 互斥锁保护）
#[derive(Default)]
struct TunnelRuntime {
    child: Option<Child>,
    pid: Option<u32>,
    started_at: Option<Instant>,
    config_path: Option<PathBuf>,
    binary_path: Option<PathBuf>,
    options: Option<LocalTunnelOptions>,
    /// 用户主动停止中，不应触发自动重连
    stopping: bool,
    restart_count: u32,
    /// 连续「启动即失败」次数（运行够久则清零）
    consecutive_failures: u32,
    last_exit: Option<String>,
    logs: VecDeque<LocalLogLine>,
    /// 每次 spawn 自增；watchdog 用它判断自己是否已过期（防止新旧 watchdog 并存）
    generation: u64,
}

/// 由 Tauri 托管的全局状态
#[derive(Default)]
pub struct TunnelHandle {
    inner: Arc<Mutex<TunnelRuntime>>,
}

// ============================================================
// 工具
// ============================================================

/// 生成 TOML 字符串字面量（转义 `\` 与 `"`）
fn toml_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 从 frpc 日志行里粗略判断级别，用于前端着色
fn detect_level(line: &str) -> &'static str {
    let up = line.to_ascii_uppercase();
    if up.contains("[E]") || up.contains("ERROR") || up.contains("FAIL") {
        "error"
    } else if up.contains("[W]") || up.contains("WARN") {
        "warn"
    } else if up.contains("SUCCESS") || up.contains("成功") {
        "ok"
    } else {
        "info"
    }
}

/// 写一条日志：进环形缓冲 + 推事件到前端
fn push_log(
    app: &AppHandle,
    state: &Arc<Mutex<TunnelRuntime>>,
    level: &str,
    message: impl Into<String>,
) {
    let line = LocalLogLine {
        level: level.to_string(),
        message: message.into(),
    };
    if let Ok(mut g) = state.lock() {
        g.logs.push_back(line.clone());
        while g.logs.len() > MAX_LOCAL_LOGS {
            g.logs.pop_front();
        }
    }
    let _ = app.emit("frp-local-log", &line);
}

/// 按当前状态拼装对外状态对象
fn status_of(state: &Arc<Mutex<TunnelRuntime>>) -> LocalStatus {
    let g = match state.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    LocalStatus {
        running: g.child.is_some(),
        pid: g.pid,
        uptime_secs: g.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0),
        config_path: g.config_path.as_ref().map(|p| p.display().to_string()),
        binary_path: g.binary_path.as_ref().map(|p| p.display().to_string()),
        restarts: g.restart_count,
        last_exit: g.last_exit.clone(),
    }
}

/// 内置 `frpc.exe` 的候选路径
fn frpc_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let file = "frpc.exe";
    let mut v: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        v.push(dir.join("frp").join(file));
        v.push(dir.join("resources").join("frp").join(file));
        v.push(dir.join(file));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            v.push(d.join("frp").join(file));
            v.push(d.join("resources").join("frp").join(file));
            v.push(d.join(file));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        v.push(cwd.join("src-tauri").join("resources").join("frp").join(file));
        v.push(cwd.join("resources").join("frp").join(file));
    }
    if let Ok(dir) = std::env::var("VERSEPC_FRP_DIR") {
        v.push(PathBuf::from(dir).join(file));
    }
    v
}

/// 定位要用的 frpc.exe
pub fn resolve_frpc(app: &AppHandle, override_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = override_path.map(str::trim).filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
        return Err(format!("指定的 frpc.exe 不存在：{}", pb.display()));
    }
    let cands = frpc_candidates(app);
    if let Some(p) = cands.iter().find(|p| p.is_file()) {
        return Ok(p.clone());
    }
    // 所有外部候选都没有：把编译期内嵌的 frpc.exe 解压到资源目录再用
    if let Some(p) = super::ensure_bundled_frpc(app) {
        return Ok(p);
    }
    Err(format!(
        "未找到内置 frpc.exe。\n已尝试以下位置：\n{}",
        cands
            .iter()
            .map(|p| format!("  - {}", p.display()))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

/// 本地配置文件路径（放应用配置目录，避免污染安装目录）
fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法获取应用配置目录：{}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败：{}", e))?;
    Ok(dir.join("frpc.local.toml"))
}

/// 生成 frpc（本地隧道）配置文本
fn build_local_config(o: &LocalTunnelOptions) -> String {
    let mut s = String::new();
    s.push_str(&format!(
        "serverAddr = \"{}\"\n",
        toml_str(o.server_addr.trim())
    ));
    s.push_str(&format!("serverPort = {}\n", o.server_port));
    if !o.token.trim().is_empty() {
        s.push_str("auth.method = \"token\"\n");
        s.push_str(&format!("auth.token = \"{}\"\n", toml_str(o.token.trim())));
    }

    // 心跳：显式写入，保证 NAT 后长连接被及时保活 / 断链可自愈
    let interval = o.heartbeat_interval.max(1);
    let timeout = o.heartbeat_timeout.max(interval + 1);
    s.push('\n');
    s.push_str(&format!("transport.heartbeatInterval = {}\n", interval));
    s.push_str(&format!("transport.heartbeatTimeout = {}\n", timeout));

    s.push('\n');
    s.push_str("[[proxies]]\n");
    s.push_str(&format!("name = \"{}\"\n", toml_str(o.proxy_name.trim())));
    s.push_str(&format!("type = \"{}\"\n", toml_str(o.proxy_type.trim())));
    s.push_str(&format!("localIP = \"{}\"\n", toml_str(o.local_ip.trim())));
    s.push_str(&format!("localPort = {}\n", o.local_port));
    if o.remote_port > 0 {
        s.push_str(&format!("remotePort = {}\n", o.remote_port));
    }
    s
}

/// 起两个读取线程，把子进程的 stdout/stderr 逐行转成日志事件
fn spawn_readers<R1, R2>(
    app: AppHandle,
    state: Arc<Mutex<TunnelRuntime>>,
    stdout: Option<R1>,
    stderr: Option<R2>,
) where
    R1: std::io::Read + Send + 'static,
    R2: std::io::Read + Send + 'static,
{
    if let Some(out) = stdout {
        let app = app.clone();
        let st = state.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let lv = detect_level(&line);
                push_log(&app, &st, lv, line);
            }
        });
    }
    if let Some(err) = stderr {
        let app = app.clone();
        let st = state.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let lv = detect_level(&line);
                push_log(&app, &st, lv, line);
            }
        });
    }
}

/// 本进程启动一个 watchdog 线程看住当前这一代子进程
fn spawn_watchdog(app: AppHandle, state: Arc<Mutex<TunnelRuntime>>, generation: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_INTERVAL);

        let mut exit_note: Option<String> = None;
        let mut do_restart: Option<LocalTunnelOptions> = None;
        let mut give_up: Option<u32> = None;
        let mut expired = false;

        {
            let mut g = match state.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            // 已被停止 / 已被更新的一代接管 → 本 watchdog 退休
            if g.generation != generation || g.child.is_none() {
                expired = true;
            } else if let Some(c) = g.child.as_mut() {
                match c.try_wait() {
                    Ok(Some(st)) => {
                        let ran = g.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0);
                        g.child = None;
                        g.pid = None;
                        g.started_at = None;
                        let note = format!("frpc 进程已退出（{}），本次运行 {} 秒", st, ran);
                        g.last_exit = Some(note.clone());
                        exit_note = Some(note);
                        // 跑够久才退 = 连上过又掉线（正常抖动）→ 清零失败计数；
                        // 秒退 = 启动即失败（地址/端口/令牌不对）→ 累计，防止无限重启
                        if ran >= RAPID_EXIT_SECS {
                            g.consecutive_failures = 0;
                        } else {
                            g.consecutive_failures += 1;
                        }
                        let auto = !g.stopping
                            && g.options.as_ref().map(|o| o.auto_restart).unwrap_or(false);
                        if auto && g.consecutive_failures <= MAX_AUTO_RESTARTS {
                            g.restart_count += 1;
                            do_restart = g.options.clone();
                        } else if auto {
                            g.stopping = true;
                            give_up = Some(g.consecutive_failures);
                        }
                    }
                    Ok(None) => {} // 仍在运行
                    Err(e) => {
                        exit_note = Some(format!("检测 frpc 进程状态失败：{}", e));
                        g.child = None;
                        g.pid = None;
                    }
                }
            }
        }

        if expired {
            break;
        }
        if let Some(note) = exit_note {
            push_log(&app, &state, "error", note);
        }
        if let Some(n) = give_up {
            push_log(
                &app,
                &state,
                "error",
                format!(
                    "已连续 {} 次启动失败，停止自动重连。请检查服务端地址 / 端口 / 令牌，或云端 frps 是否在线",
                    n
                ),
            );
        }
        if let Some(opts) = do_restart {
            push_log(
                &app,
                &state,
                "warn",
                format!("隧道已断开，{} 秒后自动重连 ...", RESTART_DELAY.as_secs()),
            );
            std::thread::sleep(RESTART_DELAY);
            match spawn_process(&app, &state, &opts) {
                Ok(_) => push_log(&app, &state, "ok", "隧道已自动重连"),
                Err(e) => push_log(&app, &state, "error", format!("自动重连失败：{}", e)),
            }
        } else if state.lock().map(|g| g.child.is_none()).unwrap_or(true) {
            break;
        }
    });
}

/// 真正把 frpc.exe 拉起来：写配置 → spawn → 接线读取 → 起 watchdog
fn spawn_process(
    app: &AppHandle,
    state: &Arc<Mutex<TunnelRuntime>>,
    opts: &LocalTunnelOptions,
) -> Result<(), String> {
    if opts.server_addr.trim().is_empty() {
        return Err("请填写 FRP 服务端地址".to_string());
    }
    if opts.local_port == 0 {
        return Err("本地端口必须大于 0".to_string());
    }

    let exe = resolve_frpc(app, opts.binary_path.as_deref())?;
    let cfg_text = build_local_config(opts);
    let cfg = config_path(app)?;
    std::fs::write(&cfg, cfg_text.as_bytes())
        .map_err(|e| format!("写入本地配置失败 {}：{}", cfg.display(), e))?;

    let mut cmd = Command::new(&exe);
    cmd.arg("-c")
        .arg(&cfg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 frpc.exe 失败（{}）：{}", exe.display(), e))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let generation = {
        let mut g = match state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.generation = g.generation.wrapping_add(1);
        let generation_id = g.generation;
        g.child = Some(child);
        g.pid = Some(pid);
        g.started_at = Some(Instant::now());
        g.config_path = Some(cfg.clone());
        g.binary_path = Some(exe.clone());
        g.options = Some(opts.clone());
        g.stopping = false;
        g.last_exit = None;
        generation_id
    };

    spawn_readers(app.clone(), state.clone(), stdout, stderr);
    spawn_watchdog(app.clone(), state.clone(), generation);

    push_log(
        app,
        state,
        "ok",
        format!(
            "隧道已启动（PID {}）· {}:{} → {}:{}",
            pid,
            opts.server_addr.trim(),
            opts.remote_port,
            opts.local_ip.trim(),
            opts.local_port
        ),
    );
    Ok(())
}

// ============================================================
// Tauri 命令
// ============================================================

/// 启动本地隧道（已在运行时会先停掉旧的再起新的）
#[tauri::command]
pub fn frp_local_start(
    app: AppHandle,
    state: State<'_, TunnelHandle>,
    options: LocalTunnelOptions,
) -> Result<LocalStatus, String> {
    let inner = state.inner.clone();
    // 先停旧进程，保证同一时刻只有一个隧道
    {
        let mut g = match inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.stopping = true;
        if let Some(mut c) = g.child.take() {
            let _ = c.kill();
        }
        g.pid = None;
        g.started_at = None;
        g.consecutive_failures = 0; // 用户手动启动：重置失败计数
        g.generation = g.generation.wrapping_add(1);
    }

    spawn_process(&app, &inner, &options)?;
    Ok(status_of(&inner))
}

/// 停止本地隧道
#[tauri::command]
pub fn frp_local_stop(app: AppHandle, state: State<'_, TunnelHandle>) -> Result<LocalStatus, String> {
    let inner = state.inner.clone();
    let was_running = {
        let mut g = match inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.stopping = true;
        g.generation = g.generation.wrapping_add(1); // 让在跑的 watchdog 退休
        let had = g.child.is_some();
        if let Some(mut c) = g.child.take() {
            let _ = c.kill();
        }
        g.pid = None;
        g.started_at = None;
        had
    };
    if was_running {
        push_log(&app, &inner, "warn", "隧道已停止");
    }
    Ok(status_of(&inner))
}

/// 查询本地隧道状态（轻量，不含日志，供轮询）
#[tauri::command]
pub fn frp_local_status(state: State<'_, TunnelHandle>) -> Result<LocalStatus, String> {
    Ok(status_of(&state.inner))
}

/// 取本地日志快照（切换面板回来时用，之后靠 `frp-local-log` 事件增量）
#[tauri::command]
pub fn frp_local_logs(state: State<'_, TunnelHandle>) -> Result<Vec<LocalLogLine>, String> {
    let g = match state.inner.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    Ok(g.logs.iter().cloned().collect())
}

/// 清空本地日志缓冲
#[tauri::command]
pub fn frp_local_clear_logs(state: State<'_, TunnelHandle>) -> Result<(), String> {
    if let Ok(mut g) = state.inner.lock() {
        g.logs.clear();
    }
    Ok(())
}

/// 内置 frpc.exe 的路径与大小（供前端展示"内置客户端"）
#[tauri::command]
pub fn frp_local_frpc_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let found = frpc_candidates(&app).into_iter().find(|p| p.is_file());
    let size_mb = found
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| ((m.len() as f64 / 1048576.0) * 10.0).round() / 10.0)
        .unwrap_or(0.0);
    Ok(serde_json::json!({
        "path": found.as_ref().map(|p| p.display().to_string()),
        "sizeMb": size_mb,
        "exists": found.is_some(),
    }))
}

/// 应用退出时收尾：杀掉子进程，避免留下孤儿 frpc
pub fn shutdown(app: &AppHandle) {
    let handle = app.state::<TunnelHandle>();
    let mut g = match handle.inner.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.stopping = true;
    g.generation = g.generation.wrapping_add(1);
    if let Some(mut c) = g.child.take() {
        let _ = c.kill();
    }
    g.pid = None;
}

// ============================================================
// 单元测试：只覆盖纯函数（进程相关无法在无云端环境单测）
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> LocalTunnelOptions {
        LocalTunnelOptions {
            server_addr: "frp.example.com".into(),
            server_port: 3221,
            token: "tk".into(),
            proxy_name: "local-ssh".into(),
            proxy_type: "tcp".into(),
            local_ip: "127.0.0.1".into(),
            local_port: 22,
            remote_port: 3223,
            heartbeat_interval: 10,
            heartbeat_timeout: 30,
            auto_restart: true,
            binary_path: None,
        }
    }

    #[test]
    fn config_contains_proxy_and_heartbeat() {
        let cfg = build_local_config(&base());
        assert!(cfg.contains("serverAddr = \"frp.example.com\""));
        assert!(cfg.contains("serverPort = 3221"));
        assert!(cfg.contains("auth.method = \"token\""));
        assert!(cfg.contains("auth.token = \"tk\""));
        // 心跳必须显式写入
        assert!(cfg.contains("transport.heartbeatInterval = 10"));
        assert!(cfg.contains("transport.heartbeatTimeout = 30"));
        assert!(cfg.contains("[[proxies]]"));
        assert!(cfg.contains("localPort = 22"));
        assert!(cfg.contains("remotePort = 3223"));
    }

    #[test]
    fn heartbeat_timeout_is_forced_above_interval() {
        let mut o = base();
        o.heartbeat_interval = 60;
        o.heartbeat_timeout = 30; // 非法：超时不能小于间隔
        let cfg = build_local_config(&o);
        assert!(cfg.contains("transport.heartbeatInterval = 60"));
        assert!(
            cfg.contains("transport.heartbeatTimeout = 61"),
            "超时应被抬到间隔之上：\n{}",
            cfg
        );
    }

    #[test]
    fn token_absent_means_no_auth_section() {
        let mut o = base();
        o.token = "   ".into();
        let cfg = build_local_config(&o);
        assert!(!cfg.contains("auth."));
    }

    #[test]
    fn remote_port_zero_is_omitted() {
        let mut o = base();
        o.remote_port = 0;
        assert!(!build_local_config(&o).contains("remotePort"));
    }

    #[test]
    fn toml_escaping() {
        assert_eq!(toml_str("a\"b"), "a\\\"b");
        assert_eq!(toml_str("a\\b"), "a\\\\b");
    }

    #[test]
    fn level_detection() {
        assert_eq!(detect_level("[E] login to server failed"), "error");
        assert_eq!(detect_level("[W] reconnect"), "warn");
        assert_eq!(detect_level("[I] start proxy success"), "ok");
        assert_eq!(detect_level("[I] try to connect to server"), "info");
    }
}

//! SakuraFrp（樱花内网穿透）接入
//!
//! 官方 API v4：`https://api.natfrp.com/v4`
//! 文档：<https://api.natfrp.com/docs>
//!
//! 与 LoliaFRP 模块**相互独立**：凭据、状态、进程表、日志事件全是本模块自己的，
//! 只复用 `frp_local::resolve_frpc`（定位 frpc.exe）这一个工具函数。
//!
//! 鉴权方式（樱花与 Lolia 不同）：
//! - GET：访问密钥放在 query `?token=xxx`
//! - POST：query 带 token **并且** 额外带 `Authorization: Bearer xxx`
//!   （官方 Gin 实现两处都认，参考实现也是双写，这里保持一致）
//!
//! 隧道配置由云端下发：`POST /tunnel/config` 传 `query`（隧道 ID 或 `n`+节点 ID）
//! 与 `frpc`（目标 frpc 版本），返回可被 frpc 直接加载的 ini 或 toml 文本。
//! **版本必须协商**：传 `0.51.0-sakura-14` 拿到 ini，传 `0.71.0` 这类上游新版
//! 才会拿到 toml —— 而内置 frpc 是新版、只认 toml，所以启动时要把本地真实版本
//! 报给云端，否则会拿到跑不起来的 ini。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::frp_local::resolve_frpc;

// ============================================================
// 常量
// ============================================================

const API_BASE: &str = "https://api.natfrp.com/v4";

/// 拿不到本地 frpc 版本时的兜底（樱花官方分发的 frpc 版本）
const FALLBACK_FRPC_VER: &str = "0.51.0-sakura-14";

/// frp 从 0.52 起弃用 ini，内置的新版 frpc 只认 toml
const INI_LAST_MINOR: u32 = 51;

const MAX_LOGS: usize = 800;
const WATCH_INTERVAL: Duration = Duration::from_secs(3);
const RESTART_DELAY: Duration = Duration::from_secs(2);
const RAPID_EXIT_SECS: u64 = 15;
const MAX_AUTO_RESTARTS: u32 = 5;
const START_VERIFY_DELAY: Duration = Duration::from_millis(1200);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ============================================================
// 数据
// ============================================================

/// 落盘的凭据（只在本机配置目录，绝不进源码）
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Persisted {
    token: String,
    username: String,
}

#[derive(Debug, Default)]
struct Store {
    token: String,
    username: String,
    config_dir: PathBuf,
}

/// 对外暴露的登录状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub username: Option<String>,
    /// 只给前后各 4 位，避免整串密钥在界面上飘
    pub token_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub tunnel: String,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatus {
    pub tunnel: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub uptime_secs: u64,
    pub restarts: u32,
    pub config_path: String,
    pub last_exit: Option<String>,
}

#[derive(Default)]
struct TunnelRun {
    child: Option<Child>,
    pid: Option<u32>,
    started_at: Option<Instant>,
    config_path: PathBuf,
    auto_restart: bool,
    stopping: bool,
    restarts: u32,
    consecutive_failures: u32,
    last_exit: Option<String>,
    logs: VecDeque<LogLine>,
}

#[derive(Default)]
pub struct SakuraHandle {
    store: Arc<Mutex<Store>>,
    runs: Arc<Mutex<HashMap<String, TunnelRun>>>,
}

// ============================================================
// 小工具
// ============================================================

fn truncate(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        format!("{}…", t)
    } else {
        t
    }
}

fn safe_file_name(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() {
        "tunnel".to_string()
    } else {
        out
    }
}

fn detect_level(line: &str) -> &'static str {
    let l = line.to_ascii_lowercase();
    if l.contains("error") || l.contains("failed") || l.contains("错误") {
        "error"
    } else if l.contains("warn") || l.contains("警告") {
        "warn"
    } else if l.contains("login to server success")
        || l.contains("start proxy success")
        || l.contains("started successfully")
    {
        "ok"
    } else {
        "info"
    }
}

/// 密钥打码：日志里绝不出现完整 token
fn mask_token(t: &str) -> String {
    let n = t.chars().count();
    if n <= 8 {
        return "****".to_string();
    }
    let head: String = t.chars().take(4).collect();
    let tail: String = t.chars().skip(n - 4).collect();
    format!("{}****{}", head, tail)
}

/// 从 `frpc -v` 的输出里抠出版本号，如 `0.71.0` / `0.51.0-sakura-14`
pub fn parse_frpc_version(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_alphanumeric()
                    || bytes[i] == b'.'
                    || bytes[i] == b'-'
                    || bytes[i] == b'_')
            {
                i += 1;
            }
            let cand = &text[start..i];
            let parts: Vec<&str> = cand.split('.').collect();
            if parts.len() >= 3
                && parts[0].chars().all(|c| c.is_ascii_digit())
                && parts[1].chars().all(|c| c.is_ascii_digit())
            {
                return Some(cand.to_string());
            }
        } else {
            i += 1;
        }
    }
    None
}

/// 解析 `主版本.次版本`，用于判断这个 frpc 还认不认 ini
pub fn parse_ver_minor(ver: &str) -> Option<(u32, u32)> {
    let parts: Vec<&str> = ver.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let major = parts[0].parse::<u32>().ok()?;
    let minor = parts[1].parse::<u32>().ok()?;
    Some((major, minor))
}

/// 云端下发的配置是 ini 还是 toml
pub fn config_kind(text: &str) -> &'static str {
    let t = text.trim_start();
    if t.starts_with('[') || t.contains("\n[common]") {
        "ini"
    } else {
        "toml"
    }
}

// ============================================================
// HTTP
// ============================================================

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .user_agent("NetTool/0.1 (SakuraFrp integration)")
            .build()
            .unwrap_or_default()
    })
}

/// 把 HTTP 错误整理成人话。樱花出错时 body 可能是 JSON 也可能是纯文本。
fn err_from_body(status: u16, text: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        let msg = v
            .get("msg")
            .and_then(|m| m.as_str())
            .or_else(|| v.get("message").and_then(|m| m.as_str()))
            .or_else(|| v.get("error").and_then(|m| m.as_str()))
            .unwrap_or("");
        if !msg.is_empty() {
            let code = v.get("code").and_then(|c| c.as_i64());
            return match code {
                Some(c) => format!("{}（code {}）", msg, c),
                None => format!("{}（HTTP {}）", msg, status),
            };
        }
    }
    let plain = text.trim();
    if plain.is_empty() {
        format!("请求失败（HTTP {}）", status)
    } else {
        format!("请求失败（HTTP {}）：{}", status, truncate(plain, 200))
    }
}

fn err_from_req(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "请求超时：樱花 API 未响应，请检查网络后重试".to_string()
    } else if e.is_connect() {
        format!("无法连接樱花 API（{}）：请检查网络或代理设置", e)
    } else {
        format!("请求失败：{}", e)
    }
}

/// 查询参数百分号编码（RFC 3986 unreserved 之外全部转义）
///
/// 本项目的 reqwest 没开 `.query()` 那套，URL 一律手拼，所以得自己编码 ——
/// 访问密钥里出现 `+` `/` `=` 之类的字符时不编码就会被服务端截断。
pub fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", *b)),
        }
    }
    out
}

/// 拼出带访问密钥的接口地址
fn url_with_token(path: &str, token: &str) -> String {
    format!("{}{}?token={}", API_BASE, path, pct(token))
}

/// JSON 接口：自动带 token（query + Bearer），返回结果本身
async fn api_json(
    token: &str,
    method: reqwest::Method,
    path: &str,
    form: Option<&[(String, String)]>,
) -> Result<serde_json::Value, String> {
    let url = url_with_token(path, token);
    let mut rb = http().request(method.clone(), &url);
    if method == reqwest::Method::POST {
        rb = rb.bearer_auth(token);
    }
    if let Some(f) = form {
        rb = rb.form(f);
    }

    let resp = rb.send().await.map_err(err_from_req)?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{}", e))?;

    if !(200..300).contains(&status) {
        return Err(err_from_body(status, &text));
    }
    serde_json::from_str(&text).map_err(|_| {
        format!(
            "响应不是合法 JSON（HTTP {}）：{}",
            status,
            truncate(&text, 200)
        )
    })
}

/// 文本接口（`/tunnel/config` 返回 ini/toml 原文）
async fn api_text(
    token: &str,
    path: &str,
    form: &[(String, String)],
) -> Result<String, String> {
    let url = url_with_token(path, token);
    let resp = http()
        .post(&url)
        .bearer_auth(token)
        .form(form)
        .send()
        .await
        .map_err(err_from_req)?;

    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&status) {
        return Err(err_from_body(status, &text));
    }
    Ok(text)
}

/// 无需鉴权的接口（预留；当前 sakura 隧道流程未用到）
#[allow(dead_code)]
async fn api_public(path: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", API_BASE, path);
    let resp = http().get(&url).send().await.map_err(err_from_req)?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&status) {
        return Err(err_from_body(status, &text));
    }
    serde_json::from_str(&text).map_err(|_| format!("响应不是合法 JSON：{}", truncate(&text, 200)))
}

// ============================================================
// 凭据
// ============================================================

fn runs_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = base.join("sakura");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn persist(g: &Store) {
    let p = Persisted {
        token: g.token.clone(),
        username: g.username.clone(),
    };
    let file = g.config_dir.join("sakura.json");
    match serde_json::to_string_pretty(&p) {
        Ok(s) => {
            if let Err(e) = std::fs::write(&file, s) {
                super::log_warn(
                    "sakura",
                    format!("保存凭据失败 {}: {}", file.display(), e),
                );
            }
        }
        Err(e) => super::log_warn("sakura", format!("序列化凭据失败：{}", e)),
    }
}

pub fn init(app: &AppHandle) {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let file = dir.join("sakura.json");
    let loaded: Persisted = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    if let Ok(mut g) = app.state::<SakuraHandle>().store.lock() {
        g.token = loaded.token.clone();
        g.username = loaded.username;
        g.config_dir = dir.clone();
    }
    super::log_info(
        "sakura",
        format!(
            "SakuraFrp 模块已就绪 · 已保存的访问密钥：{}",
            if loaded.token.is_empty() {
                "无".to_string()
            } else {
                mask_token(&loaded.token)
            }
        ),
    );
}

fn take_token(state: &SakuraHandle) -> Result<String, String> {
    let g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
    if g.token.trim().is_empty() {
        return Err("尚未填写 SakuraFrp 访问密钥。请到 natfrp.com → 用户信息 → 访问密钥 复制后填入".to_string());
    }
    Ok(g.token.clone())
}

// ============================================================
// 账号 / 查询类命令
// ============================================================

#[tauri::command]
pub fn sakura_auth_status(state: State<'_, SakuraHandle>) -> Result<AuthStatus, String> {
    let g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
    let has = !g.token.trim().is_empty();
    Ok(AuthStatus {
        logged_in: has,
        username: if g.username.is_empty() {
            None
        } else {
            Some(g.username.clone())
        },
        token_preview: if has {
            Some(mask_token(&g.token))
        } else {
            None
        },
    })
}

/// 保存访问密钥并顺手校验（调一次 /user/info）
#[tauri::command]
pub async fn sakura_login(
    state: State<'_, SakuraHandle>,
    token: String,
) -> Result<AuthStatus, String> {
    let tok = token.trim().to_string();
    if tok.is_empty() {
        return Err("请填写访问密钥".to_string());
    }
    let info = api_json(&tok, reqwest::Method::GET, "/user/info", None)
        .await
        .map_err(|e| format!("访问密钥校验失败：{}", e))?;

    let name = info
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    {
        let mut g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
        g.token = tok.clone();
        g.username = name.clone();
        persist(&g);
    }
    super::log_info("sakura", format!("已保存访问密钥 {}", mask_token(&tok)));

    Ok(AuthStatus {
        logged_in: true,
        username: if name.is_empty() { None } else { Some(name) },
        token_preview: Some(mask_token(&tok)),
    })
}

#[tauri::command]
pub fn sakura_logout(state: State<'_, SakuraHandle>) -> Result<(), String> {
    {
        let mut g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
        g.token.clear();
        g.username.clear();
        persist(&g);
    }
    super::log_info("sakura", "已清除访问密钥");
    Ok(())
}

#[tauri::command]
pub async fn sakura_user_info(
    state: State<'_, SakuraHandle>,
) -> Result<serde_json::Value, String> {
    let token = take_token(&state)?;
    let info = api_json(&token, reqwest::Method::GET, "/user/info", None).await?;
    // 顺手把用户名记下来，界面上就不用再单独问一次
    if let Some(n) = info.get("name").and_then(|v| v.as_str()) {
        let mut g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
        if g.username != n {
            g.username = n.to_string();
            persist(&g);
        }
    }
    Ok(info)
}

/// 节点列表。樱花返回的是 **以节点 ID 为 key 的对象**（不是数组）
#[tauri::command]
pub async fn sakura_nodes(state: State<'_, SakuraHandle>) -> Result<serde_json::Value, String> {
    let token = take_token(&state)?;
    api_json(&token, reqwest::Method::GET, "/nodes", None).await
}

#[tauri::command]
pub async fn sakura_tunnel_list(
    state: State<'_, SakuraHandle>,
) -> Result<serde_json::Value, String> {
    let token = take_token(&state)?;
    api_json(&token, reqwest::Method::GET, "/tunnels", None).await
}

#[tauri::command]
pub async fn sakura_tunnel_create(
    state: State<'_, SakuraHandle>,
    name: String,
    tunnel_type: String,
    node: i64,
    local_ip: Option<String>,
    local_port: Option<i64>,
    remote: Option<String>,
    note: Option<String>,
    extra: Option<String>,
) -> Result<serde_json::Value, String> {
    let token = take_token(&state)?;
    if name.trim().is_empty() {
        return Err("请填写隧道名".to_string());
    }
    if node <= 0 {
        return Err("请选择节点".to_string());
    }
    if !matches!(
        tunnel_type.as_str(),
        "tcp" | "udp" | "http" | "https" | "wol" | "etcp" | "eudp"
    ) {
        return Err(format!("不支持的隧道类型：{}", tunnel_type));
    }
    if (tunnel_type == "http" || tunnel_type == "https")
        && remote.as_deref().unwrap_or("").trim().is_empty()
    {
        return Err("http / https 隧道必须填写 remote（绑定域名）".to_string());
    }

    let mut form: Vec<(String, String)> = vec![
        ("name".to_string(), name.trim().to_string()),
        ("type".to_string(), tunnel_type.clone()),
        ("node".to_string(), node.to_string()),
    ];
    if let Some(v) = local_ip {
        form.push(("local_ip".to_string(), v));
    }
    if let Some(v) = local_port {
        form.push(("local_port".to_string(), v.to_string()));
    }
    if let Some(v) = remote {
        if !v.trim().is_empty() {
            form.push(("remote".to_string(), v.trim().to_string()));
        }
    }
    if let Some(v) = note {
        form.push(("note".to_string(), v));
    }
    if let Some(v) = extra {
        form.push(("extra".to_string(), v));
    }

    let r = api_json(
        &token,
        reqwest::Method::POST,
        "/tunnels",
        Some(&form),
    )
    .await?;
    super::log_info("sakura", format!("已创建隧道 {}", name.trim()));
    Ok(r)
}

#[tauri::command]
pub async fn sakura_tunnel_edit(
    state: State<'_, SakuraHandle>,
    id: i64,
    note: Option<String>,
    local_ip: Option<String>,
    local_port: Option<i64>,
    extra: Option<String>,
) -> Result<serde_json::Value, String> {
    let token = take_token(&state)?;
    if id <= 0 {
        return Err("隧道 ID 无效".to_string());
    }
    let mut form: Vec<(String, String)> = vec![("id".to_string(), id.to_string())];
    if let Some(v) = note {
        form.push(("note".to_string(), v));
    }
    if let Some(v) = local_ip {
        form.push(("local_ip".to_string(), v));
    }
    if let Some(v) = local_port {
        form.push(("local_port".to_string(), v.to_string()));
    }
    if let Some(v) = extra {
        form.push(("extra".to_string(), v));
    }
    api_json(&token, reqwest::Method::POST, "/tunnel/edit", Some(&form)).await
}

/// 删除隧道，`ids` 支持逗号分隔批量
#[tauri::command]
pub async fn sakura_tunnel_delete(
    state: State<'_, SakuraHandle>,
    ids: String,
) -> Result<serde_json::Value, String> {
    let token = take_token(&state)?;
    let ids = ids.trim().to_string();
    if ids.is_empty() {
        return Err("请先选择要删除的隧道".to_string());
    }
    let form = vec![("ids".to_string(), ids.clone())];
    let r = api_json(
        &token,
        reqwest::Method::POST,
        "/tunnel/delete",
        Some(&form),
    )
    .await?;
    super::log_info("sakura", format!("已删除隧道 {}", ids));
    Ok(r)
}

/// 取云端下发的 frpc 配置原文（不启动，供界面预览 / 排错）
#[tauri::command]
pub async fn sakura_tunnel_config(
    app: AppHandle,
    state: State<'_, SakuraHandle>,
    query: String,
) -> Result<String, String> {
    let token = take_token(&state)?;
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("请先选择隧道".to_string());
    }
    let (exe, ver) = frpc_with_version(&app);
    let form = vec![
        ("query".to_string(), q.clone()),
        ("frpc".to_string(), ver.clone()),
    ];
    let text = api_text(&token, "/tunnel/config", &form).await?;
    super::log_info(
        "sakura",
        format!(
            "已获取配置 query={} frpc={} 格式={}",
            q,
            ver,
            config_kind(&text)
        ),
    );
    let _ = exe;
    Ok(text)
}

// ============================================================
// 本地 frpc
// ============================================================

/// 专用 frpc 的存放位置（若用户手动放置了樱花官方 frpc 会自动优先使用）
fn sakura_frpc_file(app: &AppHandle) -> PathBuf {
    super::frp_resource_dir(app).join("frpc-sakura.exe")
}

/// 选择要用的 frpc：优先「已下载的樱花专用 frpc」，否则用内置/用户指定的
fn pick_frpc(app: &AppHandle) -> Result<PathBuf, String> {
    let special = sakura_frpc_file(app);
    if special.exists() {
        return Ok(special);
    }
    resolve_frpc(app, None)
}

/// frpc 路径 + 版本字符串
fn frpc_with_version(app: &AppHandle) -> (PathBuf, String) {
    match pick_frpc(app) {
        Ok(exe) => {
            let ver = detect_frpc_version(&exe).unwrap_or_else(|| FALLBACK_FRPC_VER.to_string());
            (exe, ver)
        }
        Err(_) => (PathBuf::new(), FALLBACK_FRPC_VER.to_string()),
    }
}

/// 跑 `frpc -v` 拿真实版本（决定向云端要 ini 还是 toml）
fn detect_frpc_version(exe: &Path) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg("-v")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    parse_frpc_version(&text)
}

#[tauri::command]
pub fn sakura_frpc_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let (exe, ver) = frpc_with_version(&app);
    let is_sakura = exe
        .file_name()
        .map(|n| n.to_string_lossy().contains("sakura"))
        .unwrap_or(false);
    Ok(serde_json::json!({
        "path": exe.display().to_string(),
        "version": ver,
        "isSakura": is_sakura,
        "exists": exe.exists(),
        "hasDedicated": sakura_frpc_file(&app).exists(),
    }))
}

/// 删掉专用 frpc，回到内置客户端
#[tauri::command]
pub fn sakura_frpc_remove(app: AppHandle) -> Result<(), String> {
    let f = sakura_frpc_file(&app);
    if f.exists() {
        std::fs::remove_file(&f).map_err(|e| format!("删除失败：{}", e))?;
    }
    Ok(())
}

// ============================================================
// 本地隧道运行
// ============================================================

fn push_log(
    app: &AppHandle,
    runs: &Arc<Mutex<HashMap<String, TunnelRun>>>,
    key: &str,
    level: &str,
    msg: impl Into<String>,
) {
    let line = LogLine {
        tunnel: key.to_string(),
        level: level.to_string(),
        message: msg.into(),
    };
    if let Ok(mut g) = runs.lock() {
        if let Some(r) = g.get_mut(key) {
            r.logs.push_back(line.clone());
            while r.logs.len() > MAX_LOGS {
                r.logs.pop_front();
            }
        }
    }
    let _ = app.emit("sakura-log", &line);
}

fn run_status_of(key: &str, r: &TunnelRun) -> RunStatus {
    RunStatus {
        tunnel: key.to_string(),
        running: r.child.is_some(),
        pid: r.pid,
        uptime_secs: r.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0),
        restarts: r.restarts,
        config_path: r.config_path.display().to_string(),
        last_exit: r.last_exit.clone(),
    }
}

fn spawn_child(
    app: &AppHandle,
    runs: &Arc<Mutex<HashMap<String, TunnelRun>>>,
    key: &str,
    exe: &Path,
    cfg: &Path,
) -> Result<u32, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("-c")
        .arg(cfg)
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
        .map_err(|e| format!("启动 frpc 失败（{}）：{}", exe.display(), e))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut g = runs.lock().map_err(|_| "状态锁异常".to_string())?;
        let r = g.entry(key.to_string()).or_default();
        r.child = Some(child);
        r.pid = Some(pid);
        r.started_at = Some(Instant::now());
        r.stopping = false;
        r.last_exit = None;
    }

    let (a1, r1, k1) = (app.clone(), runs.clone(), key.to_string());
    if let Some(out) = stdout {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let lv = detect_level(&line);
                push_log(&a1, &r1, &k1, lv, line);
            }
        });
    }
    let (a2, r2, k2) = (app.clone(), runs.clone(), key.to_string());
    if let Some(err) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let lv = detect_level(&line);
                push_log(&a2, &r2, &k2, lv, line);
            }
        });
    }

    ensure_watchdog(app.clone(), runs.clone());
    Ok(pid)
}

/// 全局 watchdog：巡检所有隧道，处理退出与自动重连
fn ensure_watchdog(app: AppHandle, runs: Arc<Mutex<HashMap<String, TunnelRun>>>) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_INTERVAL);

        let mut exited: Vec<(String, String)> = Vec::new();
        let mut restart: Vec<(String, PathBuf)> = Vec::new();
        let mut gave_up: Vec<(String, u32)> = Vec::new();

        {
            let mut g = match runs.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            for (key, r) in g.iter_mut() {
                let child = match r.child.as_mut() {
                    Some(c) => c,
                    None => continue,
                };
                match child.try_wait() {
                    Ok(Some(st)) => {
                        let ran = r.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0);
                        r.child = None;
                        r.pid = None;
                        r.started_at = None;
                        let note = format!("frpc 进程已退出（{}），本次运行 {} 秒", st, ran);
                        r.last_exit = Some(note.clone());
                        exited.push((key.clone(), note));
                        if ran >= RAPID_EXIT_SECS {
                            r.consecutive_failures = 0;
                        } else {
                            r.consecutive_failures += 1;
                        }
                        if r.auto_restart && !r.stopping {
                            if r.consecutive_failures <= MAX_AUTO_RESTARTS {
                                r.restarts += 1;
                                restart.push((key.clone(), r.config_path.clone()));
                            } else {
                                r.stopping = true;
                                gave_up.push((key.clone(), r.consecutive_failures));
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        r.child = None;
                        r.pid = None;
                        exited.push((key.clone(), format!("检测进程状态失败：{}", e)));
                    }
                }
            }
        }

        if exited.is_empty() && restart.is_empty() && gave_up.is_empty() {
            continue;
        }
        for (key, note) in &exited {
            push_log(&app, &runs, key, "error", note.clone());
        }
        for (key, n) in &gave_up {
            push_log(
                &app,
                &runs,
                key,
                "error",
                format!(
                    "已连续 {} 次启动失败，停止自动重连。请检查隧道配置 / 节点是否在线",
                    n
                ),
            );
        }
        if !restart.is_empty() {
            std::thread::sleep(RESTART_DELAY);
        }
        for (key, cfg) in restart {
            let exe = match pick_frpc(&app) {
                Ok(e) => e,
                Err(e) => {
                    push_log(&app, &runs, &key, "error", format!("自动重连失败：{}", e));
                    continue;
                }
            };
            push_log(&app, &runs, &key, "warn", "隧道已断开，正在自动重连 …");
            match spawn_child(&app, &runs, &key, &exe, &cfg) {
                Ok(pid) => {
                    push_log(&app, &runs, &key, "ok", format!("隧道已自动重连（PID {}）", pid))
                }
                Err(e) => push_log(&app, &runs, &key, "error", format!("自动重连失败：{}", e)),
            }
        }
    });
}

/// 写入配置并启动
fn start_with_config(
    app: &AppHandle,
    runs: &Arc<Mutex<HashMap<String, TunnelRun>>>,
    key: &str,
    cfg_text: &str,
    auto_restart: bool,
) -> Result<RunStatus, String> {
    if cfg_text.trim().is_empty() {
        return Err("云端返回的 frpc 配置为空，无法启动隧道".to_string());
    }

    let exe = pick_frpc(app)?;
    let kind = config_kind(cfg_text);

    // 版本协商失败的兜底提示：新版 frpc 拿到 ini 会秒退，与其让用户看不懂的
    // 「exit code: 1」，不如在这里把原因和解法说清楚。
    if kind == "ini" {
        if let Some(ver) = detect_frpc_version(&exe) {
            if let Some((major, minor)) = parse_ver_minor(&ver) {
                if major == 0 && minor > INI_LAST_MINOR {
                    return Err(format!(
                        "云端下发了旧版 INI 配置，但当前 frpc 是 {}（只支持 TOML）。\n\
                        解决办法：点「下载樱花专用 frpc」，下载完成后重新启动隧道即可。",
                        ver
                    ));
                }
            }
        }
    }

    let ext = if kind == "ini" { "ini" } else { "toml" };
    let cfg = runs_dir(app).join(format!("{}.{}", safe_file_name(key), ext));
    std::fs::write(&cfg, cfg_text.as_bytes())
        .map_err(|e| format!("写入配置失败 {}：{}", cfg.display(), e))?;

    {
        let mut g = runs.lock().map_err(|_| "状态锁异常".to_string())?;
        let r = g.entry(key.to_string()).or_default();
        r.stopping = true;
        if let Some(mut c) = r.child.take() {
            let _ = c.kill();
        }
        r.pid = None;
        r.started_at = None;
        r.config_path = cfg.clone();
        r.auto_restart = auto_restart;
        r.stopping = false;
        r.consecutive_failures = 0;
        r.last_exit = None;
    }

    let pid = spawn_child(app, runs, key, &exe, &cfg)?;
    push_log(app, runs, key, "ok", format!("隧道已启动（PID {}）", pid));

    let g = runs.lock().map_err(|_| "状态锁异常".to_string())?;
    Ok(g.get(key)
        .map(|r| run_status_of(key, r))
        .unwrap_or(RunStatus {
            tunnel: key.to_string(),
            running: true,
            pid: Some(pid),
            uptime_secs: 0,
            restarts: 0,
            config_path: cfg.display().to_string(),
            last_exit: None,
        }))
}

/// 启动后确认 frpc 真的活着（frpc 配置不合法会毫秒级退出）
async fn verify_started(
    app: &AppHandle,
    runs: &Arc<Mutex<HashMap<String, TunnelRun>>>,
    key: &str,
) -> Result<(), String> {
    tokio::time::sleep(START_VERIFY_DELAY).await;

    let mut fail: Option<String> = None;
    let mut tail: Vec<String> = Vec::new();
    {
        let mut g = match runs.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(r) = g.get_mut(key) {
            if let Some(c) = r.child.as_mut() {
                match c.try_wait() {
                    Ok(Some(st)) => {
                        fail = Some(format!("frpc 启动后立即退出（{}）", st));
                        r.child = None;
                        r.pid = None;
                        r.started_at = None;
                    }
                    Ok(None) => {}
                    Err(e) => fail = Some(format!("检测 frpc 状态失败：{}", e)),
                }
            } else {
                fail = Some("frpc 进程已不存在".to_string());
            }
            tail = r.logs.iter().rev().take(5).map(|l| l.message.clone()).collect();
        }
    }

    match fail {
        None => Ok(()),
        Some(reason) => {
            let detail = tail
                .into_iter()
                .rev()
                .filter(|m| !m.trim().is_empty())
                .collect::<Vec<_>>()
                .join(" / ");
            let msg = if detail.is_empty() {
                reason
            } else {
                format!("{}｜frpc 输出：{}", reason, detail)
            };
            push_log(app, runs, key, "error", format!("启动校验未通过：{}", msg));
            Err(format!("隧道启动失败：{}", msg))
        }
    }
}

/// 启动隧道。`query` 是启动目标：隧道 ID（如 `114514`）或 `n`+节点 ID（如 `n233`）
#[tauri::command]
pub async fn sakura_tunnel_start(
    app: AppHandle,
    state: State<'_, SakuraHandle>,
    query: String,
    auto_restart: Option<bool>,
) -> Result<RunStatus, String> {
    let token = take_token(&state)?;
    let q = query.trim().to_string();
    if q.is_empty() {
        return Err("请先选择要启动的隧道".to_string());
    }

    let (_, ver) = frpc_with_version(&app);
    let form = vec![
        ("query".to_string(), q.clone()),
        ("frpc".to_string(), ver.clone()),
    ];
    let cfg_text = api_text(&token, "/tunnel/config", &form).await?;

    let st = start_with_config(
        &app,
        &state.runs,
        &q,
        &cfg_text,
        auto_restart.unwrap_or(true),
    )?;
    verify_started(&app, &state.runs, &q).await?;
    Ok(st)
}

#[tauri::command]
pub fn sakura_tunnel_stop(
    app: AppHandle,
    state: State<'_, SakuraHandle>,
    query: String,
) -> Result<RunStatus, String> {
    let key = query.trim().to_string();
    let mut g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    let r = g.entry(key.clone()).or_default();
    r.stopping = true;
    let had = r.child.is_some();
    if let Some(mut c) = r.child.take() {
        let _ = c.kill();
    }
    r.pid = None;
    r.started_at = None;
    let st = run_status_of(&key, r);
    drop(g);
    if had {
        push_log(&app, &state.runs, &key, "warn", "隧道已停止");
    }
    Ok(st)
}

#[tauri::command]
pub fn sakura_run_status(state: State<'_, SakuraHandle>) -> Result<Vec<RunStatus>, String> {
    let g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    let mut v: Vec<RunStatus> = g.iter().map(|(k, r)| run_status_of(k, r)).collect();
    v.sort_by(|a, b| a.tunnel.cmp(&b.tunnel));
    Ok(v)
}

#[tauri::command]
pub fn sakura_tunnel_logs(
    state: State<'_, SakuraHandle>,
    query: String,
) -> Result<Vec<LogLine>, String> {
    let key = query.trim().to_string();
    let g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    Ok(g.get(&key)
        .map(|r| r.logs.iter().cloned().collect())
        .unwrap_or_default())
}

#[tauri::command]
pub fn sakura_tunnel_clear_logs(
    state: State<'_, SakuraHandle>,
    query: String,
) -> Result<(), String> {
    let key = query.trim().to_string();
    let mut g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    if let Some(r) = g.get_mut(&key) {
        r.logs.clear();
    }
    Ok(())
}

/// 退出时杀掉所有 frpc 子进程，避免留下孤儿
pub fn shutdown(app: &AppHandle) {
    if let Some(handle) = app.try_state::<SakuraHandle>() {
        if let Ok(mut g) = handle.runs.lock() {
            for r in g.values_mut() {
                r.stopping = true;
                if let Some(mut c) = r.child.take() {
                    let _ = c.kill();
                }
                r.pid = None;
            }
        }
    }
}

// ============================================================
// 单元测试
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frpc_version() {
        assert_eq!(parse_frpc_version("0.71.0\n").as_deref(), Some("0.71.0"));
        assert_eq!(
            parse_frpc_version("frpc version 0.51.0-sakura-14").as_deref(),
            Some("0.51.0-sakura-14")
        );
        assert_eq!(parse_frpc_version("no version here"), None);
    }

    #[test]
    fn parses_ver_minor() {
        assert_eq!(parse_ver_minor("0.71.0"), Some((0, 71)));
        assert_eq!(parse_ver_minor("0.51.0-sakura-14"), Some((0, 51)));
        assert_eq!(parse_ver_minor("garbage"), None);
    }

    #[test]
    fn detects_config_kind() {
        assert_eq!(config_kind("[common]\nserver_addr = x"), "ini");
        assert_eq!(config_kind("serverAddr = \"x\"\n"), "toml");
    }

    #[test]
    fn masks_token() {
        assert_eq!(mask_token("abc"), "****");
        let m = mask_token("abcdefghij");
        assert!(m.starts_with("abcd") && m.ends_with("ghij") && m.contains("****"));
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_file_name("114514"), "114514");
        assert_eq!(safe_file_name("n233"), "n233");
        assert_eq!(safe_file_name("a/b\\c"), "a_b_c");
    }
}

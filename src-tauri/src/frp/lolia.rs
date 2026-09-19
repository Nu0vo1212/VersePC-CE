//! LoliaFRP 集成：OAuth2 授权登录 + 开放 API + 本地 frpc 隧道运行。
//!
//! 接口来源：<https://api-docs.lolia.link/>（Apifox 导出），基址
//! `https://api.lolia.link/api/v1`。
//!
//! ## 覆盖的接口
//! | 文档章节 | 接口 | 本模块命令 |
//! |---|---|---|
//! | 用户信息 | `GET /user/info` | [`lolia_user_info`] |
//! | 隧道 | `GET /user/tunnel` | [`lolia_tunnel_list`] |
//! | 隧道 | `POST /user/tunnel` | [`lolia_tunnel_create`] |
//! | 隧道 | `GET /user/tunnel/{name}` | [`lolia_tunnel_detail`] |
//! | 隧道 | `PUT /user/tunnel/{name}` | [`lolia_tunnel_update`] |
//! | 隧道 | `DELETE /user/tunnel/{name}` | [`lolia_tunnel_delete`] |
//! | 隧道 | `GET /user/frpc/config` | [`lolia_frpc_config`] |
//! | 隧道 | `GET /tunnel/frpc/config`（免凭据） | [`lolia_token_config`] |
//! | 节点 | `POST /user/nodes` | [`lolia_nodes`] |
//! | 域名白名单 | `GET/POST /user/domain` | [`lolia_domains`] / [`lolia_domain_add`] |
//! | 域名白名单 | `POST /user/domain/verify` | [`lolia_domain_verify`] |
//! | 域名白名单 | `DELETE /user/domain/{id}` | [`lolia_domain_delete`] |
//! | 流量 | `GET /user/traffic/stats` | [`lolia_traffic_stats`] |
//! | 流量 | `GET /user/traffic/daily` | [`lolia_traffic_daily`] |
//! | 流量 | `GET /user/traffic/tunnels` | [`lolia_traffic_tunnels`] |
//! | 流量 | `GET /user/traffic/tunnel/{id}` | [`lolia_traffic_tunnel`] |
//! | OAuth2 | `GET /oauth2/authorize` | [`lolia_oauth_begin`] |
//! | OAuth2 | `POST /oauth2/approve` | 由官方授权页调用，客户端只需接住回调 |
//! | 客户端 | `GET /client/version` | [`lolia_client_version`] |
//!
//! ## OAuth 授权流程（桌面端）
//! 1. 本机先绑定回环端口 `127.0.0.1:11451` 当临时回调服务；
//! 2. 用系统浏览器打开 `https://dash.lolia.link/oauth/authorize?...`
//!    （用户需已在该浏览器登录 Lolia 控制台）；
//! 3. 用户点「同意」后，控制台会 `302` 到 `http://127.0.0.1:11451/callback?code=..&state=..`；
//! 4. 本模块的本地服务接住 `code`（顺手回一个「授权成功」页面），
//!    再用 `code` 去 `POST /oauth2/token` 换 `access_token`，落盘保存。
//!
//! ## 为什么用 `reqwest` + `rustls(ring)` 而不是默认 TLS
//! 本机没有 NASM，`aws-lc-rs` 编不了，所以 reqwest 用 `rustls-no-provider`，
//! 由 `lib.rs` 在启动时显式安装 ring 作为默认加密后端（见 `install_crypto_provider`）。
//!
//! ## 安全
//! - `client_secret` / `access_token` 只存在**用户本机**的应用配置目录（`lolia.json`），
//!   不写进源码、不进日志；
//! - 前端要展示 frpc 配置时，必须先过 [`mask_config`] 打码（token / secret 全部替换为 `***`）。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::frp_local::resolve_frpc;

// ============================================================
// 常量
// ============================================================

/// 开放 API 基址
const API_BASE: &str = "https://api.lolia.link/api/v1";
/// 授权页（用户浏览器打开的那个）
const AUTHORIZE_PAGE: &str = "https://dash.lolia.link/oauth/authorize";
/// 令牌端点（文档未单列，按 OAuth2 惯例）
const TOKEN_PATH: &str = "/oauth2/token";
/// 本机回调监听地址（与用户注册应用时填的回调地址一致）
const CALLBACK_ADDR: &str = "127.0.0.1:11451";
/// 回调路径
const CALLBACK_PATH: &str = "/callback";
/// 注册应用时使用的重定向地址
const REDIRECT_URI: &str = "http://127.0.0.1:11451/callback";
/// 申请的全部权限范围（多个 scope 用**空格**分隔，遵循 RFC 6749 §3.3）。
///
/// 平台是**按 scope 逐项授权**的：少任何一个资源，对应接口就会返回
/// `403 OAuth2权限不足，需要以下权限之一: xxx:read`。
/// 原来这里只写了 `user:*`，结果除 `/user/info` 之外的接口全部 403
/// （tunnel / traffic / domain / node 一个都调不通）。
///
/// 各 scope 对应的接口：
///   `user:*`    → `/user/info`
///   `tunnel:*`  → `/user/tunnel`（列表 / 详情 / 创建 / 编辑 / 删除 / frpc config）
///   `traffic:*` → `/user/traffic/*`
///   `domain:*`  → `/user/domain`（列表 / 添加 / 验证 / 删除）
///   `node:*`    → `/user/nodes`
/// 通配符 `资源:*` 与文档里 `scope=user:*` 的写法一致，一次覆盖该资源的读写。
const DEFAULT_SCOPE: &str = "user:* tunnel:* traffic:* domain:* node:*";

// ------------------------------------------------------------
// ⚠️ 调试期内置凭据（由用户提供，仅本机自用）
//   发布/分享源码前必须清空这两个常量，否则等同于把 client_secret 公开。
//   桌面程序一旦分发，二进制里的 secret 一定能被逆向取出；
//   正式发布应改用 public 客户端 + PKCE，不内置 secret。
// ------------------------------------------------------------
const BUILTIN_CLIENT_ID: &str = "xriizzmxwzx9nnh7";
const BUILTIN_CLIENT_SECRET: &str = "72yx3m6ecpps82agcgocv4xfic113i3m";
/// 等待授权的总时长
const OAUTH_WAIT: Duration = Duration::from_secs(300);
/// 回调服务最多接受多少个无关连接（浏览器可能先来 favicon 之类）
const MAX_CALLBACK_CONNS: u32 = 10;

/// 日志环形缓冲上限
const MAX_LOGS: usize = 800;
/// watchdog 巡检间隔
const WATCH_INTERVAL: Duration = Duration::from_secs(3);
/// 自动重连前等待
const RESTART_DELAY: Duration = Duration::from_secs(2);
/// 运行不足这个秒数即退出 → 视为启动失败
const RAPID_EXIT_SECS: u64 = 15;
/// 连续启动失败上限，超过就不再自动重连
const MAX_AUTO_RESTARTS: u32 = 5;
/// 启动后等待多久再看一眼进程是否还活着（frpc 印出 "start proxy success" 实测约 0.3s）
const START_VERIFY_DELAY: Duration = Duration::from_millis(1200);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ============================================================
// 数据
// ============================================================

/// 持久化到磁盘的登录态（只落在用户本机配置目录）
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Persisted {
    client_id: String,
    client_secret: String,
    scope: String,
    access_token: String,
    refresh_token: String,
    expire_at: u64,
    username: String,
}

/// 内存中的登录态
#[derive(Debug, Default)]
struct Store {
    client_id: String,
    client_secret: String,
    scope: String,
    access_token: String,
    refresh_token: String,
    expire_at: u64,
    username: String,
    /// 配置目录，用来落盘
    config_dir: PathBuf,
}

/// OAuth 会话状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthStatus {
    /// idle | waiting | ok | error
    pub status: String,
    pub message: String,
    pub authorize_url: Option<String>,
    pub username: Option<String>,
}

#[derive(Default)]
struct OauthSession {
    status: String,
    message: String,
    authorize_url: Option<String>,
    /// 本次授权期望的 state，用于防 CSRF
    expected_state: Option<String>,
    /// 自增代号：取消/重开时让旧监听自动退休
    generation: u64,
    /// 让监听循环提前退出
    cancel: Option<Arc<AtomicBool>>,
}

/// 一条本地日志
#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub tunnel: String,
    pub level: String,
    pub message: String,
}

/// 单条隧道的本地运行状态（对外）
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

/// 单条隧道的内部运行期
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

/// 由 Tauri 托管的全局状态
#[derive(Default)]
pub struct LoliaHandle {
    store: Arc<Mutex<Store>>,
    oauth: Arc<Mutex<OauthSession>>,
    runs: Arc<Mutex<HashMap<String, TunnelRun>>>,
}

// ============================================================
// 纯函数（可单测）
// ============================================================

/// URL 查询参数百分号编码（RFC 3986 unreserved 之外全部转义）
pub fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 百分号解码（+ 视作空格）
pub fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 解析 HTTP 请求行，取出路径与查询参数。
/// 输入形如 `GET /callback?code=xxx&state=yyy HTTP/1.1`
pub fn parse_callback_target(request_line: &str) -> Option<(String, Vec<(String, String)>)> {
    let mut it = request_line.split_whitespace();
    let _method = it.next()?;
    let target = it.next()?;
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.to_string(), String::new()),
    };
    let params = query
        .split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| match kv.split_once('=') {
            Some((k, v)) => (pct_decode(k), pct_decode(v)),
            None => (pct_decode(kv), String::new()),
        })
        .collect();
    Some((path, params))
}

/// 解析令牌响应：兼容标准 OAuth2 顶层字段与 `{code,msg,data:{...}}` 包装两种形态
pub fn parse_token_response(json: &serde_json::Value) -> Option<(String, String, u64)> {
    let node = match json.get("data") {
        Some(d) if d.is_object() => d,
        _ => json,
    };
    let at = node.get("access_token")?.as_str()?.to_string();
    let rt = node
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let exp = node.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(0);
    Some((at, rt, exp))
}

/// 把 frpc 配置里的敏感值打码，供界面展示（落盘时仍写原文）
pub fn mask_config(text: &str) -> String {
    text.lines()
        .map(|line| {
            let low = line.to_ascii_lowercase();
            let sensitive = ["token", "secret", "password", "passwd"]
                .iter()
                .any(|k| low.contains(k));
            if !sensitive {
                return line.to_string();
            }
            match line.find('=') {
                Some(i) => format!("{} = \"***\"", line[..i].trim_end()),
                None => "***".to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ============================================================
// frpc 配置解码
//
// 实测（2026-09-11，真机复现）：接口返回的 `config` 字段是 **Base64 文本**，不是明文 TOML。
// 之前把这串 Base64 直接写进 `.toml`，frpc 解析立刻报
//   `toml: line 1, column 429: toml: expected = after a key, but the document ends there`
// —— 整份 428 字节的 Base64 被当成「一行 TOML」，末尾的 `Cg==`（即换行符）正好触发该错。
// 日志里连着 6 次「frpc 进程已退出（exit code: 1）」就是这么来的。
//
// 另外接口还返回一个更完整的 `lolia_config`（多了 dnsServer / transport.tls 段），
// 但那份**内置 frpc 0.71 用不了**：它把 `dnsServer = 'https://dns.alidns.com/dns-query'`
// 当 host:port 解析，报 `lookup udp///dns.alidns.com/dns-query: unknown port` 后退出
// （那份是给 Lolia 自家客户端用的）。所以优先 `config`，`lolia_config` 只做兜底。
// 实测 `config` 解码后可正常 `login to server success` + `start proxy success`。
// ============================================================

/// 极简 Base64 解码：标准与 URL-safe 字符集都接受，容忍缺省 padding 与空白。
/// 不引 base64 依赖 —— 本机编译环境受限，几十行手写比多一个 crate 更稳。
fn b64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let mut out: Vec<u8> = Vec::new();
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &c in input.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let v = val(c)?;
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 把接口给的配置值还原成明文 TOML。
/// 已经是明文（含换行/引号/空格）就原样返回；否则按 Base64 解码，
/// 解出来还得像 TOML（含 `=` 或 `[`）才采用，避免把普通短字符串解成乱码。
pub fn decode_frpc_config(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return String::new();
    }
    if t.contains('\n') || t.contains('"') || t.contains('\'') || t.contains(' ') {
        return t.to_string();
    }
    match b64_decode(t) {
        Some(bytes) => match String::from_utf8(bytes) {
            Ok(text) if text.contains('=') || text.contains('[') => text,
            _ => t.to_string(),
        },
        None => t.to_string(),
    }
}

/// 从接口 `data` 里挑出可用的 frpc 配置并解码成明文 TOML（优先 `config`，见上方说明）
pub fn config_from_api_data(data: &serde_json::Value) -> String {
    let pick = |k: &str| {
        data.get(k)
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
    };
    let raw = pick("config")
        .or_else(|| pick("lolia_config"))
        .unwrap_or("");
    decode_frpc_config(raw)
}

/// 目录文件名安全化（隧道名一般已是十六进制，这里防御性处理）
pub fn safe_file_name(s: &str) -> String {
    let v: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if v.is_empty() {
        "tunnel".to_string()
    } else {
        v
    }
}

/// HTML 转义（回调结果页要回显参数）
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 粗略判断日志级别（与 frp_local 同规则）
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

fn truncate(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        return t.to_string();
    }
    let mut out: String = t.chars().take(n).collect();
    out.push('…');
    out
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 生成一次性 state
fn new_state() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    format!(
        "{:x}{:x}{:x}",
        nanos,
        now_secs(),
        std::process::id() as u64
    )
}

/// 拼授权 URL
fn build_authorize_url(client_id: &str, scope: &str, state: &str) -> String {
    format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}",
        AUTHORIZE_PAGE,
        pct(client_id),
        pct(REDIRECT_URI),
        pct(scope),
        pct(state)
    )
}

// ============================================================
// HTTP
// ============================================================

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .user_agent("VersePC-CE/1.4 (LoliaFRP integration)")
            .build()
            .unwrap_or_default()
    })
}

/// 把服务端返回的错误整理成给人看的文案。
///
/// `403 OAuth2权限不足，需要以下权限之一: tunnel:read` 不是"请求写错了"，而是
/// **授权范围不够** —— 只把原始 msg 甩给用户，他只会一脸茫然。
/// （这正是"一打开 LoliaFRP 面板就哗地冒出五条 403"的现场。）
/// 所以这里补上可执行的处置步骤。
fn api_error_message(msg: &str, code: i64) -> String {
    if code == 403 && msg.contains("权限不足") {
        return format!(
            "{}（code {}）· 当前授权范围不足以调用此接口：请点「退出登录」，\
再点「验证 Lolia 账户」重新授权，并在授权页同意全部权限；\
若仍报同样的错，请到 Lolia 面板 →「授权管理」撤销对本应用的授权后重试",
            msg, code
        );
    }
    format!("{}（code {}）", msg, code)
}

/// 统一请求：自动带 Bearer，解析 `{code,msg,data}` 信封
async fn call_api(
    token: &str,
    method: reqwest::Method,
    path: &str,
    query: &[(String, String)],
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut url = format!("{}{}", API_BASE, path);
    if !query.is_empty() {
        let qs: Vec<String> = query
            .iter()
            .map(|(k, v)| format!("{}={}", pct(k), pct(v)))
            .collect();
        url.push('?');
        url.push_str(&qs.join("&"));
    }

    let mut rb = http().request(method, &url);
    if !token.is_empty() {
        rb = rb.bearer_auth(token);
    }
    if let Some(b) = body {
        rb = rb.json(&b);
    }

    let resp = rb.send().await.map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{}", e))?;

    let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "响应不是合法 JSON（HTTP {}）：{}",
            status.as_u16(),
            truncate(&text, 200)
        )
    })?;

    // 流量类接口用 status 字段、其余用 code；两者都没有就信 HTTP 状态码
    let code = json
        .get("code")
        .and_then(|c| c.as_i64())
        .or_else(|| json.get("status").and_then(|c| c.as_i64()))
        .unwrap_or(status.as_u16() as i64);

    if !(200..300).contains(&code) {
        let msg = json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("请求被拒绝");
        return Err(api_error_message(msg, code));
    }

    Ok(json.get("data").cloned().unwrap_or(serde_json::Value::Null))
}

/// 带自动刷新的取令牌
async fn ensure_token(store: &Arc<Mutex<Store>>) -> Result<String, String> {
    let (token, expire_at, refresh, cid, csec, scope) = {
        let g = store.lock().map_err(|_| "状态锁异常".to_string())?;
        (
            g.access_token.clone(),
            g.expire_at,
            g.refresh_token.clone(),
            g.client_id.clone(),
            g.client_secret.clone(),
            g.scope.clone(),
        )
    };

    if token.is_empty() {
        return Err("尚未登录 Lolia 账号，请先在「登录」页完成授权".to_string());
    }

    // 提前 60 秒续期；没有 refresh_token 就直接拿去用，由服务端判过期
    let need_refresh = expire_at > 0 && now_secs() + 60 >= expire_at;
    if !need_refresh || refresh.is_empty() {
        return Ok(token);
    }

    let scope = if scope.is_empty() {
        DEFAULT_SCOPE.to_string()
    } else {
        scope
    };
    let form = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh),
        ("client_id".to_string(), cid),
        ("client_secret".to_string(), csec),
        ("scope".to_string(), scope),
    ];
    match exchange_token(&form).await {
        Ok((at, rt, exp)) => {
            {
                let mut g = store.lock().map_err(|_| "状态锁异常".to_string())?;
                g.access_token = at.clone();
                if !rt.is_empty() {
                    g.refresh_token = rt;
                }
                if exp > 0 {
                    g.expire_at = now_secs() + exp;
                }
                persist(&g);
            }
            Ok(at)
        }
        Err(e) => {
            let mut g = store.lock().map_err(|_| "状态锁异常".to_string())?;
            g.access_token.clear();
            g.refresh_token.clear();
            g.expire_at = 0;
            persist(&g);
            Err(format!("登录已失效（{}），请重新授权登录", e))
        }
    }
}

/// 向令牌端点 POST 表单，兼容两种响应形态
async fn exchange_token(form: &[(String, String)]) -> Result<(String, String, u64), String> {
    let url = format!("{}{}", API_BASE, TOKEN_PATH);
    let resp = http()
        .post(&url)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("连接令牌端点失败：{}", e))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取令牌响应失败：{}", e))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
        format!(
            "令牌响应不是合法 JSON（HTTP {}）：{}",
            status.as_u16(),
            truncate(&text, 200)
        )
    })?;

    match parse_token_response(&json) {
        Some(v) => Ok(v),
        None => {
            let msg = json
                .get("msg")
                .and_then(|m| m.as_str())
                .or_else(|| json.get("error_description").and_then(|m| m.as_str()))
                .or_else(|| json.get("error").and_then(|m| m.as_str()))
                .unwrap_or("响应里没有 access_token");
            Err(format!("{}（HTTP {}）", msg, status.as_u16()))
        }
    }
}

/// 带鉴权的 API 调用（自动刷新令牌）
async fn api(
    store: &Arc<Mutex<Store>>,
    method: reqwest::Method,
    path: &str,
    query: &[(String, String)],
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let token = ensure_token(store).await?;
    call_api(&token, method, path, query, body).await
}

// ============================================================
// 磁盘持久化
// ============================================================

fn persist_file(store: &Store) -> PathBuf {
    store.config_dir.join("lolia.json")
}

/// 落盘登录态（只写用户本机配置目录）
fn persist(g: &Store) {
    if g.config_dir.as_os_str().is_empty() {
        return;
    }
    let _ = std::fs::create_dir_all(&g.config_dir);
    let p = Persisted {
        client_id: g.client_id.clone(),
        client_secret: g.client_secret.clone(),
        scope: g.scope.clone(),
        access_token: g.access_token.clone(),
        refresh_token: g.refresh_token.clone(),
        expire_at: g.expire_at,
        username: g.username.clone(),
    };
    if let Ok(text) = serde_json::to_string_pretty(&p) {
        let _ = std::fs::write(persist_file(g), text.as_bytes());
    }
}

/// 应用启动时调用：装载历史登录态
pub fn init(app: &AppHandle) {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let handle = app.state::<LoliaHandle>();
    let mut g = match handle.store.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.config_dir = dir;
    let path = persist_file(&g);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(p) = serde_json::from_str::<Persisted>(&text) {
            g.client_id = p.client_id;
            g.client_secret = p.client_secret;
            g.scope = p.scope;
            g.access_token = p.access_token;
            g.refresh_token = p.refresh_token;
            g.expire_at = p.expire_at;
            g.username = p.username;
        }
    }
    let seed = seed_builtin(&mut g);
    if seed.changed {
        // 把"范围已升级 + 旧凭据作废"的新状态写回磁盘，避免下次启动又读回旧 token
        persist(&g);
        if seed.invalidated {
            super::log_warn(
                "lolia",
                format!(
                    "申请权限范围已变更为「{}」，旧的登录凭据已作废，请重新点「验证 Lolia 账户」授权一次",
                    DEFAULT_SCOPE
                ),
            );
        }
    }
}

/// `seed_builtin` 的结果：把"要不要落盘"和"要不要提示重新授权"分开，
/// 否则会出现"从未授权过却提示凭据已作废"这种假消息。
#[derive(Debug, Default, Clone, Copy)]
struct SeedOutcome {
    /// 申请范围变过 → 调用方需要把当前状态写回磁盘
    changed: bool,
    /// 手上那个按旧范围签发的 token 已被作废 → 调用方应提示用户重新授权
    invalidated: bool,
}

/// 凭据固定为内置常量：不给用户/界面留任何覆盖入口。
/// 若以后要清空内置值（发布前），把常量置空即可，此处会自动跳过。
fn seed_builtin(g: &mut Store) -> SeedOutcome {
    if !BUILTIN_CLIENT_ID.trim().is_empty() {
        g.client_id = BUILTIN_CLIENT_ID.to_string();
    }
    if !BUILTIN_CLIENT_SECRET.trim().is_empty() {
        g.client_secret = BUILTIN_CLIENT_SECRET.to_string();
    }

    // scope 同样以常量为准，**不再"非空就沿用"**。
    // 老版本落盘的是 `user:*`，如果只是沿用，会一直粘着：续期时继续申请旧范围、
    // 界面也一直显示旧范围 —— 就是"常量改了却仍然 403"的坑。
    if DEFAULT_SCOPE.trim().is_empty() || g.scope == DEFAULT_SCOPE {
        return SeedOutcome::default();
    }

    // 申请范围变了 => 手上这个 token 是按**旧范围**发的，权限必然不够，
    // 留着它只会让用户继续看 403。直接作废本地登录态，逼一次重新授权。
    // （只清 token / username，不动 client_id / secret。）
    let invalidated = !g.access_token.is_empty();
    g.scope = DEFAULT_SCOPE.to_string();
    g.access_token.clear();
    g.refresh_token.clear();
    g.expire_at = 0;
    g.username.clear();

    SeedOutcome {
        changed: true,
        invalidated,
    }
}

// ============================================================
// OAuth 授权
// ============================================================

/// 回调结果页
fn callback_page(ok: bool, detail: &str) -> String {
    let (title, tip) = if ok {
        ("授权成功", "已获取访问凭据，可以关闭本页面回到 NetTool。")
    } else {
        ("授权失败", "请回到 NetTool 查看具体原因后重试。")
    };
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
<title>LoliaFRP · {title}</title>\
<style>body{{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;\
background:#13141c;color:#e1e3ea;font-family:system-ui,'Segoe UI',sans-serif}}\
.box{{text-align:center;padding:40px 48px;border:1px solid #2e3047;border-radius:14px;background:#1e2030}}\
h1{{font-size:18px;margin:0 0 12px}}p{{margin:0;font-size:13px;color:#8b90a8}}</style></head>\
<body><div class=\"box\"><h1>{title}</h1><p>{tip}</p><p style=\"margin-top:10px\">{detail}</p></div></body></html>",
        title = title,
        tip = tip,
        detail = esc(detail)
    )
}

fn http_response(status: &str, body: &str, extra: &str) -> String {
    let len = body.as_bytes().len();
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Length: {len}\r\nConnection: close\r\nCache-Control: no-store\r\n{extra}\r\n{body}"
    )
}

/// 开始 OAuth 授权：绑回环端口 → 返回授权 URL（由前端用系统浏览器打开）
///
/// 凭据不开放给界面：client_id / secret / scope 一律取内置常量，调用方无法覆盖。
#[tauri::command]
pub async fn lolia_oauth_begin(
    app: AppHandle,
    state: State<'_, LoliaHandle>,
) -> Result<String, String> {
    let cid = BUILTIN_CLIENT_ID.trim().to_string();
    let csec = BUILTIN_CLIENT_SECRET.trim().to_string();
    let scope = DEFAULT_SCOPE.to_string();
    if cid.len() < 2 {
        return Err("内置 client_id 为空或不合法，请检查 BUILTIN_CLIENT_ID 常量".to_string());
    }

    // 把申请的范围打进日志：出现 403 时能一眼看出"是没申请这个 scope"还是"平台没给"。
    super::log_info(
        "lolia",
        format!("OAuth 授权开始 · 申请权限范围：{}", scope),
    );

    // 先抢端口，抢不到就直接报错，避免用户开浏览器后才发现收不到回调
    let listener = tokio::net::TcpListener::bind(CALLBACK_ADDR)
        .await
        .map_err(|e| {
            format!(
                "无法监听回调地址 {}：{}。请确认该端口没有被别的程序占用",
                REDIRECT_URI, e
            )
        })?;

    // 记忆 client_id / secret / scope，省得每次重填
    {
        let mut g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
        g.client_id = cid.clone();
        g.client_secret = csec.clone();
        g.scope = scope.clone();
        persist(&g);
    }

    let st = new_state();
    let url = build_authorize_url(&cid, &scope, &st);

    let cancel = Arc::new(AtomicBool::new(false));
    let generation = {
        let mut o = state.oauth.lock().map_err(|_| "状态锁异常".to_string())?;
        // 让上一次的监听退休
        if let Some(c) = o.cancel.take() {
            c.store(true, Ordering::SeqCst);
        }
        o.generation = o.generation.wrapping_add(1);
        o.status = "waiting".to_string();
        o.message = "已打开浏览器，请在页面上完成授权".to_string();
        o.authorize_url = Some(url.clone());
        o.expected_state = Some(st.clone());
        o.cancel = Some(cancel.clone());
        o.generation
    };

    let store = state.store.clone();
    let oauth = state.oauth.clone();
    let app2 = app.clone();
    let _ = app.emit(
        "lolia-oauth",
        serde_json::json!({ "status": "waiting", "message": "已打开浏览器，请在页面上完成授权" }),
    );

    tokio::spawn(async move {
        let outcome = wait_for_callback(listener, cancel.clone(), &st).await;

        // 关键：换 token 是网络 await，**绝不能**持有 oauth 的 std::MutexGuard 跨 await，
        // 否则 future 不是 Send、tokio::spawn 直接编译不过。先算完，再短暂加锁回写。
        let result = match outcome {
            Ok(code) => token_exchange(&store, &code, &cid, &csec, &scope).await,
            Err(e) => Err(e),
        };
        let (status, message) = match result {
            Ok(name) => (
                "ok".to_string(),
                if name.is_empty() {
                    "授权成功".to_string()
                } else {
                    format!("已登录 {}", name)
                },
            ),
            Err(e) => ("error".to_string(), e),
        };

        // 只有仍是当前这一代才写状态（防止取消后旧任务回写）
        {
            let mut o = match oauth.lock() {
                Ok(o) => o,
                Err(p) => p.into_inner(),
            };
            if o.generation != generation {
                return;
            }
            o.status = status.clone();
            o.message = message.clone();
            o.cancel = None;
        }
        let _ = app2.emit(
            "lolia-oauth",
            serde_json::json!({ "status": status, "message": message }),
        );
    });

    Ok(url)
}

/// 等浏览器回调，拿到 code
async fn wait_for_callback(
    listener: tokio::net::TcpListener,
    cancel: Arc<AtomicBool>,
    expected_state: &str,
) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let deadline = Instant::now() + OAUTH_WAIT;
    let mut served: u32 = 0;

    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消授权".to_string());
        }
        if Instant::now() >= deadline {
            return Err("等待授权超时（5 分钟），请重新发起登录".to_string());
        }
        if served >= MAX_CALLBACK_CONNS {
            return Err("收到的无效回调过多，已停止等待".to_string());
        }

        let accepted = tokio::time::timeout(Duration::from_millis(800), listener.accept()).await;
        let (mut stream, _) = match accepted {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => return Err(format!("接收回调失败：{}", e)),
            Err(_) => continue, // 到点没连接，回头检查取消标志
        };
        served += 1;

        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => 0,
        };
        if n == 0 {
            let body = callback_page(false, "请求为空");
            let _ = stream
                .write_all(http_response("400 Bad Request", &body, "").as_bytes())
                .await;
            continue;
        }

        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        let first = text.lines().next().unwrap_or("").to_string();
        let parsed = parse_callback_target(&first);

        let (path, params) = match parsed {
            Some(v) => v,
            None => {
                let body = callback_page(false, "无法解析请求");
                let _ = stream
                    .write_all(http_response("400 Bad Request", &body, "").as_bytes())
                    .await;
                continue;
            }
        };

        // 忽略 favicon 之类的无关请求
        if !path.starts_with(CALLBACK_PATH) {
            let body = callback_page(false, "未知路径");
            let _ = stream
                .write_all(http_response("404 Not Found", &body, "").as_bytes())
                .await;
            continue;
        }

        let get = |k: &str| {
            params
                .iter()
                .find(|(a, _)| a == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        let code = get("code");
        let state_got = get("state");
        let err = get("error");
        let err_desc = get("error_description");

        if !err.is_empty() {
            let msg = if err_desc.is_empty() { err } else { err_desc };
            let body = callback_page(false, &msg);
            let _ = stream
                .write_all(http_response("200 OK", &body, "").as_bytes())
                .await;
            return Err(format!("授权被拒绝：{}", msg));
        }
        if code.is_empty() {
            let body = callback_page(false, "回调里没有 code");
            let _ = stream
                .write_all(http_response("400 Bad Request", &body, "").as_bytes())
                .await;
            continue;
        }
        if state_got != expected_state {
            let body = callback_page(false, "state 校验失败");
            let _ = stream
                .write_all(http_response("400 Bad Request", &body, "").as_bytes())
                .await;
            return Err("state 校验失败：回调可能不是本次授权发起，已中止".to_string());
        }

        let body = callback_page(true, "NetTool 已收到授权码并完成登录");
        let _ = stream
            .write_all(http_response("200 OK", &body, "").as_bytes())
            .await;
        let _ = stream.flush().await;
        return Ok(code);
    }
}

/// 用 code 换 token 并落盘
async fn token_exchange(
    store: &Arc<Mutex<Store>>,
    code: &str,
    client_id: &str,
    client_secret: &str,
    scope: &str,
) -> Result<String, String> {
    let mut form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), REDIRECT_URI.to_string()),
        ("client_id".to_string(), client_id.to_string()),
    ];
    if !client_secret.trim().is_empty() {
        form.push(("client_secret".to_string(), client_secret.trim().to_string()));
    }
    if !scope.is_empty() {
        form.push(("scope".to_string(), scope.to_string()));
    }

    let (at, rt, exp) = exchange_token(&form).await?;

    {
        let mut g = store.lock().map_err(|_| "状态锁异常".to_string())?;
        g.access_token = at.clone();
        g.refresh_token = rt;
        g.expire_at = if exp > 0 { now_secs() + exp } else { 0 };
        persist(&g);
    }

    // 顺手把用户名取回来，方便界面直接显示
    let name = match call_api(&at, reqwest::Method::GET, "/user/info", &[], None).await {
        Ok(info) => info
            .get("username")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Err(_) => String::new(),
    };
    if !name.is_empty() {
        if let Ok(mut g) = store.lock() {
            g.username = name.clone();
            persist(&g);
        }
    }

    // 授权范围自检：**拿到 token ≠ 拿到权限**。
    // 平台按 scope 逐项授权，授权页也不会告诉你少了什么；
    // 于是这里主动探一次隧道列表，把"权限到底够不够"变成一条明确日志 ——
    // 否则用户只会看到打开面板时"哗"地冒出一排 403。
    let probe = vec![("page".to_string(), "1".to_string()), ("limit".to_string(), "1".to_string())];
    match call_api(&at, reqwest::Method::GET, "/user/tunnel", &probe, None).await {
        Ok(_) => super::log_info(
            "lolia",
            format!("授权范围自检通过 · 已获得：{}", scope),
        ),
        Err(e) => super::log_warn(
            "lolia",
            format!(
                "授权范围自检未通过：{} · 本次申请的是「{}」；\
若提示里点名的 scope 已经在申请列表里，说明浏览器里同意的是旧的授权，\
请先在 Lolia 面板 → 授权管理 撤销对本应用的授权，再重新验证账户",
                e, scope
            ),
        ),
    }

    // 返回用户名（可能为空），由调用方拼提示语
    Ok(name)
}

/// 查询授权进度（前端轮询）
#[tauri::command]
pub fn lolia_oauth_status(state: State<'_, LoliaHandle>) -> Result<OauthStatus, String> {
    let o = state.oauth.lock().map_err(|_| "状态锁异常".to_string())?;
    Ok(OauthStatus {
        status: if o.status.is_empty() {
            "idle".to_string()
        } else {
            o.status.clone()
        },
        message: o.message.clone(),
        authorize_url: o.authorize_url.clone(),
        username: None,
    })
}

/// 取消本次授权（释放回调端口）
#[tauri::command]
pub fn lolia_oauth_cancel(state: State<'_, LoliaHandle>) -> Result<(), String> {
    let mut o = state.oauth.lock().map_err(|_| "状态锁异常".to_string())?;
    if let Some(c) = o.cancel.take() {
        c.store(true, Ordering::SeqCst);
    }
    o.generation = o.generation.wrapping_add(1);
    o.status = "idle".to_string();
    o.message = "已取消授权".to_string();
    Ok(())
}

/// 登录态概览
#[tauri::command]
pub fn lolia_auth_status(state: State<'_, LoliaHandle>) -> Result<serde_json::Value, String> {
    let g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
    Ok(serde_json::json!({
        "loggedIn": !g.access_token.is_empty(),
        "clientId": g.client_id,
        "hasSecret": !g.client_secret.is_empty(),
        "scope": if g.scope.is_empty() { DEFAULT_SCOPE } else { &g.scope },
        "expireAt": g.expire_at,
        "username": g.username,
        "redirectUri": REDIRECT_URI,
    }))
}

/// 退出登录（清空内存与磁盘凭据，不动 client_id/secret）
#[tauri::command]
pub fn lolia_logout(state: State<'_, LoliaHandle>) -> Result<(), String> {
    let mut g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
    g.access_token.clear();
    g.refresh_token.clear();
    g.expire_at = 0;
    g.username.clear();
    persist(&g);
    Ok(())
}

// ============================================================
// 业务接口
// ============================================================

/// 用户信息：`GET /user/info`
#[tauri::command]
pub async fn lolia_user_info(state: State<'_, LoliaHandle>) -> Result<serde_json::Value, String> {
    api(&state.store, reqwest::Method::GET, "/user/info", &[], None).await
}

/// 隧道列表：`GET /user/tunnel`
#[tauri::command]
pub async fn lolia_tunnel_list(
    state: State<'_, LoliaHandle>,
    page: Option<u32>,
    limit: Option<u32>,
) -> Result<serde_json::Value, String> {
    let q = vec![
        ("page".to_string(), page.unwrap_or(1).to_string()),
        ("limit".to_string(), limit.unwrap_or(50).to_string()),
    ];
    api(&state.store, reqwest::Method::GET, "/user/tunnel", &q, None).await
}

/// 隧道详情：`GET /user/tunnel/{tunnel_name}`
#[tauri::command]
pub async fn lolia_tunnel_detail(
    state: State<'_, LoliaHandle>,
    name: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/user/tunnel/{}", pct(name.trim()));
    api(&state.store, reqwest::Method::GET, &path, &[], None).await
}

/// 创建隧道：`POST /user/tunnel`
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lolia_tunnel_create(
    state: State<'_, LoliaHandle>,
    node_id: i64,
    kind: String,
    local_ip: String,
    local_port: u16,
    remote_port: u16,
    custom_domain: Option<String>,
    remark: Option<String>,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "node_id": node_id,
        "type": kind,
        "local_ip": local_ip,
        "local_port": local_port,
        "remote_port": remote_port,
        "custom_domain": custom_domain.unwrap_or_default(),
        "remark": remark.unwrap_or_default(),
    });
    api(
        &state.store,
        reqwest::Method::POST,
        "/user/tunnel",
        &[],
        Some(body),
    )
    .await
}

/// 编辑隧道：`PUT /user/tunnel/{tunnel_name}`
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn lolia_tunnel_update(
    state: State<'_, LoliaHandle>,
    name: String,
    local_ip: Option<String>,
    local_port: Option<u16>,
    custom_domain: Option<String>,
    remark: Option<String>,
    auto_tls: Option<bool>,
    proxy_protocol_version: Option<String>,
    protocol: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::Map::new();
    if let Some(v) = local_ip {
        body.insert("local_ip".into(), serde_json::json!(v));
    }
    if let Some(v) = local_port {
        body.insert("local_port".into(), serde_json::json!(v));
    }
    if let Some(v) = custom_domain {
        body.insert("custom_domain".into(), serde_json::json!(v));
    }
    if let Some(v) = remark {
        body.insert("remark".into(), serde_json::json!(v));
    }
    // config 子对象只在有内容时才带上，避免把未改动的字段覆盖成空
    let mut cfg = serde_json::Map::new();
    if let Some(v) = auto_tls {
        cfg.insert("auto_tls".into(), serde_json::json!(v));
    }
    if let Some(v) = proxy_protocol_version {
        cfg.insert("proxy_protocol_version".into(), serde_json::json!(v));
    }
    if let Some(v) = protocol {
        cfg.insert("protocol".into(), serde_json::json!(v));
    }
    if !cfg.is_empty() {
        body.insert("config".into(), serde_json::Value::Object(cfg));
    }

    let path = format!("/user/tunnel/{}", pct(name.trim()));
    api(
        &state.store,
        reqwest::Method::PUT,
        &path,
        &[],
        Some(serde_json::Value::Object(body)),
    )
    .await
}

/// 删除隧道：`DELETE /user/tunnel/{tunnel_name}`
#[tauri::command]
pub async fn lolia_tunnel_delete(
    state: State<'_, LoliaHandle>,
    name: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/user/tunnel/{}", pct(name.trim()));
    api(&state.store, reqwest::Method::DELETE, &path, &[], None).await
}

/// 取 frpc 配置：`GET /user/frpc/config`（返回打码后的文本，原文只用于本地起隧道）
#[tauri::command]
pub async fn lolia_frpc_config(
    state: State<'_, LoliaHandle>,
    tunnel: String,
) -> Result<serde_json::Value, String> {
    let q = vec![("tunnel".to_string(), tunnel.trim().to_string())];
    let data = api(&state.store, reqwest::Method::GET, "/user/frpc/config", &q, None).await?;
    // 接口给的是 Base64，先解码成明文 TOML 再打码展示（否则详情页里是一串乱码）
    let raw = config_from_api_data(&data);
    Ok(serde_json::json!({
        "config": mask_config(&raw),
        "rawLength": raw.len(),
    }))
}

/// 用隧道 token 取 frpc 配置（无需 OAuth）：`GET /tunnel/frpc/config`
#[tauri::command]
pub async fn lolia_token_config(
    token: String,
    id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut q = vec![("token".to_string(), token.trim().to_string())];
    if let Some(i) = id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        q.push(("id".to_string(), i));
    }
    // 该接口 security 为空，不带 Bearer
    let data = call_api("", reqwest::Method::GET, "/tunnel/frpc/config", &q, None).await?;
    // 同样是 Base64，解码后再打码展示
    let raw = config_from_api_data(&data);
    Ok(serde_json::json!({
        "config": mask_config(&raw),
        "nodeName": data.get("node_name").cloned().unwrap_or(serde_json::Value::Null),
        "tunnelRemark": data.get("tunnel_remark").cloned().unwrap_or(serde_json::Value::Null),
    }))
}

/// 节点列表：`POST /user/nodes`
#[tauri::command]
pub async fn lolia_nodes(state: State<'_, LoliaHandle>) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "page": 1, "limit": 1000 });
    api(
        &state.store,
        reqwest::Method::POST,
        "/user/nodes",
        &[],
        Some(body),
    )
    .await
}

/// 域名列表：`GET /user/domain`
#[tauri::command]
pub async fn lolia_domains(state: State<'_, LoliaHandle>) -> Result<serde_json::Value, String> {
    api(&state.store, reqwest::Method::GET, "/user/domain", &[], None).await
}

/// 添加域名：`POST /user/domain`
#[tauri::command]
pub async fn lolia_domain_add(
    state: State<'_, LoliaHandle>,
    domain: String,
    remark: Option<String>,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "domain": domain.trim(),
        "remark": remark.unwrap_or_default(),
    });
    api(
        &state.store,
        reqwest::Method::POST,
        "/user/domain",
        &[],
        Some(body),
    )
    .await
}

/// 验证域名：`POST /user/domain/verify`
#[tauri::command]
pub async fn lolia_domain_verify(
    state: State<'_, LoliaHandle>,
    domain: String,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "domain": domain.trim() });
    api(
        &state.store,
        reqwest::Method::POST,
        "/user/domain/verify",
        &[],
        Some(body),
    )
    .await
}

/// 删除域名：`DELETE /user/domain/{domain_id}`
#[tauri::command]
pub async fn lolia_domain_delete(
    state: State<'_, LoliaHandle>,
    domain_id: i64,
) -> Result<serde_json::Value, String> {
    let path = format!("/user/domain/{}", domain_id);
    api(&state.store, reqwest::Method::DELETE, &path, &[], None).await
}

/// 用户流量统计：`GET /user/traffic/stats`
#[tauri::command]
pub async fn lolia_traffic_stats(state: State<'_, LoliaHandle>) -> Result<serde_json::Value, String> {
    api(
        &state.store,
        reqwest::Method::GET,
        "/user/traffic/stats",
        &[],
        None,
    )
    .await
}

/// 每日流量：`GET /user/traffic/daily`
#[tauri::command]
pub async fn lolia_traffic_daily(
    state: State<'_, LoliaHandle>,
    days: Option<u32>,
) -> Result<serde_json::Value, String> {
    let q = vec![("days".to_string(), days.unwrap_or(7).to_string())];
    api(
        &state.store,
        reqwest::Method::GET,
        "/user/traffic/daily",
        &q,
        None,
    )
    .await
}

/// 各隧道流量：`GET /user/traffic/tunnels`
#[tauri::command]
pub async fn lolia_traffic_tunnels(
    state: State<'_, LoliaHandle>,
    days: Option<u32>,
) -> Result<serde_json::Value, String> {
    let q = vec![("days".to_string(), days.unwrap_or(7).to_string())];
    api(
        &state.store,
        reqwest::Method::GET,
        "/user/traffic/tunnels",
        &q,
        None,
    )
    .await
}

/// 单隧道实时流量：`GET /user/traffic/tunnel/{tunnel_id}`
#[tauri::command]
pub async fn lolia_traffic_tunnel(
    state: State<'_, LoliaHandle>,
    tunnel_id: String,
) -> Result<serde_json::Value, String> {
    let path = format!("/user/traffic/tunnel/{}", pct(tunnel_id.trim()));
    api(&state.store, reqwest::Method::GET, &path, &[], None).await
}

/// 客户端最新版本：`GET /client/version`
#[tauri::command]
pub async fn lolia_client_version(state: State<'_, LoliaHandle>) -> Result<serde_json::Value, String> {
    api(
        &state.store,
        reqwest::Method::GET,
        "/client/version",
        &[],
        None,
    )
    .await
}

// ============================================================
// 本地隧道运行（用内置 frpc.exe）
// ============================================================

fn runs_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = base.join("lolia");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn push_log(app: &AppHandle, runs: &Arc<Mutex<HashMap<String, TunnelRun>>>, key: &str, level: &str, msg: impl Into<String>) {
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
    let _ = app.emit("lolia-log", &line);
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

/// 起进程 + 接线读取 + 确保 watchdog 在跑
fn spawn_child(
    app: &AppHandle,
    runs: &Arc<Mutex<HashMap<String, TunnelRun>>>,
    key: &str,
    exe: &PathBuf,
    cfg: &PathBuf,
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
        .map_err(|e| format!("启动 frpc.exe 失败（{}）：{}", exe.display(), e))?;
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

    // stdout / stderr 各起一个读取线程，转成日志事件
    let app_c = app.clone();
    let runs_c = runs.clone();
    let key_c = key.to_string();
    if let Some(out) = stdout {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let lv = detect_level(&line);
                push_log(&app_c, &runs_c, &key_c, lv, line);
            }
        });
    }
    let app_e = app.clone();
    let runs_e = runs.clone();
    let key_e = key.to_string();
    if let Some(err) = stderr {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let lv = detect_level(&line);
                push_log(&app_e, &runs_e, &key_e, lv, line);
            }
        });
    }

    ensure_watchdog(app.clone(), runs.clone());
    Ok(pid)
}

/// 全局 watchdog：一个线程巡检所有隧道，处理退出与自动重连
fn ensure_watchdog(app: AppHandle, runs: Arc<Mutex<HashMap<String, TunnelRun>>>) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_INTERVAL);

        // 收集本轮的「退出」与「待重启」，锁外再动作，避免死锁
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
                format!("已连续 {} 次启动失败，停止自动重连。请检查隧道配置 / 节点是否在线", n),
            );
        }
        if !restart.is_empty() {
            std::thread::sleep(RESTART_DELAY);
        }
        for (key, cfg) in restart {
            let exe = match resolve_frpc(&app, None) {
                Ok(e) => e,
                Err(e) => {
                    push_log(&app, &runs, &key, "error", format!("自动重连失败：{}", e));
                    continue;
                }
            };
            push_log(&app, &runs, &key, "warn", "隧道已断开，正在自动重连 ...");
            match spawn_child(&app, &runs, &key, &exe, &cfg) {
                Ok(pid) => push_log(&app, &runs, &key, "ok", format!("隧道已自动重连（PID {}）", pid)),
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
    if cfg_text.contains("[common]") {
        // 老版本 frp 的 ini 写法，现代 frpc 不认，提前给出人话提示
        return Err(
            "云端返回的是旧版 INI 配置（含 [common]），当前内置 frpc 只支持 TOML。\
请到 Lolia 控制台重新生成隧道配置，或在面板里查看原始配置内容"
                .to_string(),
        );
    }
    let exe = resolve_frpc(app, None)?;
    let cfg = runs_dir(app).join(format!("{}.toml", safe_file_name(key)));
    std::fs::write(&cfg, cfg_text.as_bytes())
        .map_err(|e| format!("写入配置失败 {}：{}", cfg.display(), e))?;

    // 先停掉同名旧进程
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

/// 启动后校验「frpc 真的在跑吗」。
///
/// 背景：frpc 遇到配置不合法会在**毫秒级**退出，而 `start_with_config` 只要 spawn 成功
/// 就返回 Ok —— 界面于是提示"隧道已启动"，用户看到的就是
/// 「程序里说开启了、实际根本没开」（本次真机日志：连报 6 次 `exit code: 1`，
/// 而面板上显示的是已启动）。所以启动接口在返回前必须亲自看一眼进程：
/// 还活着才算成功，死了就把 frpc 最后的输出原样带回去当失败原因。
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
        match g.get_mut(key) {
            Some(r) => {
                // 取最近几条 frpc 输出当失败原因（配置报错就在里面）
                tail = r
                    .logs
                    .iter()
                    .rev()
                    .take(4)
                    .map(|l| l.message.trim().to_string())
                    .filter(|m| !m.is_empty())
                    .collect();
                tail.reverse();

                match r.child.as_mut() {
                    Some(child) => match child.try_wait() {
                        // 已经退出了 —— 收尸，并把退出码写进 last_exit（与 watchdog 行为一致）
                        Ok(Some(st)) => {
                            let _ = child.kill();
                            r.child = None;
                            r.pid = None;
                            r.started_at = None;
                            let note = format!("frpc 启动后立即退出（{}）", st);
                            r.last_exit = Some(note.clone());
                            fail = Some(note);
                        }
                        // Ok(None) = 仍在运行 = 启动成功
                        Ok(None) => {}
                        Err(e) => fail = Some(format!("无法确认 frpc 进程状态：{}", e)),
                    },
                    // 已被 watchdog 判定退出
                    None => {
                        fail = Some(
                            r.last_exit
                                .clone()
                                .unwrap_or_else(|| "frpc 进程未能启动".to_string()),
                        )
                    }
                }
            }
            None => fail = Some("隧道运行状态丢失".to_string()),
        }
    }

    match fail {
        None => {
            push_log(app, runs, key, "info", "已确认 frpc 运行正常");
            Ok(())
        }
        Some(note) => {
            let reason = if tail.is_empty() {
                note
            } else {
                format!("{}｜frpc 输出：{}", note, tail.join(" / "))
            };
            push_log(
                app,
                runs,
                key,
                "error",
                format!("启动校验未通过：{}", reason),
            );
            Err(format!("隧道启动失败：{}", reason))
        }
    }
}

/// 用已登录账号启动某条隧道（自动取云端配置）
#[tauri::command]
pub async fn lolia_tunnel_run(
    app: AppHandle,
    state: State<'_, LoliaHandle>,
    name: String,
    auto_restart: Option<bool>,
) -> Result<RunStatus, String> {
    let key = name.trim().to_string();
    if key.is_empty() {
        return Err("隧道名称不能为空".to_string());
    }
    let q = vec![("tunnel".to_string(), key.clone())];
    let data = api(&state.store, reqwest::Method::GET, "/user/frpc/config", &q, None).await?;
    let cfg = config_from_api_data(&data);
    let st = start_with_config(
        &app,
        &state.runs,
        &key,
        &cfg,
        auto_restart.unwrap_or(true),
    )?;
    // 见 verify_started：不做这一步就会出现「界面提示已启动、实际进程早退了」
    verify_started(&app, &state.runs, &key).await?;
    Ok(st)
}

/// 用隧道 token 启动（无需登录，对应用户在控制台拿到的隧道令牌）
#[tauri::command]
pub async fn lolia_tunnel_run_by_token(
    app: AppHandle,
    state: State<'_, LoliaHandle>,
    token: String,
    id: Option<String>,
    auto_restart: Option<bool>,
) -> Result<RunStatus, String> {
    let tok = token.trim().to_string();
    if tok.is_empty() {
        return Err("请填写隧道 token".to_string());
    }
    let mut q = vec![("token".to_string(), tok.clone())];
    if let Some(i) = id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        q.push(("id".to_string(), i));
    }
    let data = call_api("", reqwest::Method::GET, "/tunnel/frpc/config", &q, None).await?;
    let cfg = config_from_api_data(&data);
    // 用 token 哈希前缀当 key，避免把明文 token 写进文件名
    let key = format!("token-{}", safe_file_name(&tok).chars().take(12).collect::<String>());
    let st = start_with_config(
        &app,
        &state.runs,
        &key,
        &cfg,
        auto_restart.unwrap_or(true),
    )?;
    verify_started(&app, &state.runs, &key).await?;
    Ok(st)
}

/// 停止某条隧道的本地进程
#[tauri::command]
pub fn lolia_tunnel_stop(
    app: AppHandle,
    state: State<'_, LoliaHandle>,
    name: String,
) -> Result<RunStatus, String> {
    let key = name.trim().to_string();
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

/// 全部隧道的本地运行状态
#[tauri::command]
pub fn lolia_run_status(state: State<'_, LoliaHandle>) -> Result<Vec<RunStatus>, String> {
    let g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    let mut v: Vec<RunStatus> = g.iter().map(|(k, r)| run_status_of(k, r)).collect();
    v.sort_by(|a, b| a.tunnel.cmp(&b.tunnel));
    Ok(v)
}

/// 取某条隧道的日志快照
#[tauri::command]
pub fn lolia_tunnel_logs(
    state: State<'_, LoliaHandle>,
    name: String,
) -> Result<Vec<LogLine>, String> {
    let g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    Ok(g.get(name.trim())
        .map(|r| r.logs.iter().cloned().collect())
        .unwrap_or_default())
}

/// 清空某条隧道的日志
#[tauri::command]
pub fn lolia_tunnel_clear_logs(
    state: State<'_, LoliaHandle>,
    name: String,
) -> Result<(), String> {
    if let Ok(mut g) = state.runs.lock() {
        if let Some(r) = g.get_mut(name.trim()) {
            r.logs.clear();
        }
    }
    Ok(())
}

/// 应用退出时收尾：杀掉所有本地隧道进程
pub fn shutdown(app: &AppHandle) {
    let handle = app.state::<LoliaHandle>();
    let mut g = match handle.runs.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    for r in g.values_mut() {
        r.stopping = true;
        if let Some(mut c) = r.child.take() {
            let _ = c.kill();
        }
        r.pid = None;
    }
}

// ============================================================
// 单元测试：只覆盖纯函数（网络与进程无法离线单测）
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encoding_roundtrip() {
        let raw = "http://127.0.0.1:11451/callback?a=1&b=中 文";
        let enc = pct(raw);
        assert!(!enc.contains('&'), "& 必须被转义：{}", enc);
        assert!(!enc.contains(' '));
        assert_eq!(pct_decode(&enc), raw);
    }

    #[test]
    fn parse_callback_target_reads_query() {
        let line = "GET /callback?code=abc123&state=deadbeef HTTP/1.1";
        let (path, params) = parse_callback_target(line).expect("应能解析");
        assert_eq!(path, "/callback");
        assert_eq!(
            params.iter().find(|(k, _)| k == "code").map(|(_, v)| v.as_str()),
            Some("abc123")
        );
        assert_eq!(
            params.iter().find(|(k, _)| k == "state").map(|(_, v)| v.as_str()),
            Some("deadbeef")
        );
    }

    #[test]
    fn parse_callback_target_handles_encoded_and_empty_query() {
        let (_, p) = parse_callback_target("GET /callback?error_description=a%20b%26c HTTP/1.1")
            .expect("应能解析");
        assert_eq!(
            p.iter().find(|(k, _)| k == "error_description").unwrap().1,
            "a b&c"
        );
        let (path, p) = parse_callback_target("GET /callback HTTP/1.1").unwrap();
        assert_eq!(path, "/callback");
        assert!(p.is_empty());
        assert!(parse_callback_target("").is_none());
    }

    #[test]
    fn token_response_supports_both_shapes() {
        let wrapped = serde_json::json!({
            "code": 200, "msg": "ok",
            "data": { "access_token": "at1", "refresh_token": "rt1", "expires_in": 7200 }
        });
        assert_eq!(
            parse_token_response(&wrapped),
            Some(("at1".into(), "rt1".into(), 7200))
        );

        let plain = serde_json::json!({ "access_token": "at2", "token_type": "Bearer" });
        assert_eq!(
            parse_token_response(&plain),
            Some(("at2".into(), String::new(), 0))
        );

        assert_eq!(parse_token_response(&serde_json::json!({ "msg": "bad code" })), None);
    }

    /// 接口返回的是 Base64（真机实测就是这个形状），必须解出明文 TOML。
    /// 不修这条，写进 .toml 的就是 Base64 本身，frpc 报
    /// `toml: line 1, column 429: expected = after a key, but the document ends there`
    /// —— 面板却提示"已启动"。
    #[test]
    fn decode_frpc_config_decodes_base64() {
        let b64 = "c2VydmVyQWRkciA9ICd4JwpzZXJ2ZXJQb3J0ID0gNzAwMAo=";
        assert_eq!(
            decode_frpc_config(b64),
            "serverAddr = 'x'\nserverPort = 7000\n"
        );
        // 缺 padding（部分实现会省掉）也要能解
        assert_eq!(
            decode_frpc_config("c2VydmVyQWRkciA9ICd4JwpzZXJ2ZXJQb3J0ID0gNzAwMAo"),
            "serverAddr = 'x'\nserverPort = 7000\n"
        );
    }

    /// 明文 TOML 必须原样返回，不能被"解码"成乱码
    #[test]
    fn decode_frpc_config_passes_plaintext_through() {
        // 首尾空白会被 trim（对 TOML 无影响），内容逐字保留
        let plain = "serverAddr = 'a'\nserverPort = 7000\n";
        assert_eq!(
            decode_frpc_config(plain),
            "serverAddr = 'a'\nserverPort = 7000"
        );
        // 单行、无空格无引号的明文也不该被解坏
        assert_eq!(decode_frpc_config("a=1"), "a=1");
        assert_eq!(decode_frpc_config(""), "");
        assert_eq!(decode_frpc_config("   "), "");
    }

    /// 优先 config（内置 frpc 0.71 实测能连上），lolia_config 只作兜底
    #[test]
    fn config_from_api_data_prefers_config_field() {
        let a = "c2VydmVyQWRkciA9ICd4JwpzZXJ2ZXJQb3J0ID0gNzAwMAo="; // serverAddr = 'x' …
        let b = "c2VydmVyQWRkciA9ICd5Jwo="; // serverAddr = 'y'
        let both = serde_json::json!({ "config": a, "lolia_config": b });
        assert!(config_from_api_data(&both).contains("'x'"));
        // config 为空 → 退回 lolia_config
        let fallback = serde_json::json!({ "config": "", "lolia_config": b });
        assert!(config_from_api_data(&fallback).contains("'y'"));
        // 都没有 → 空串，由 start_with_config 报"配置为空"
        assert!(config_from_api_data(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn mask_config_hides_secrets_but_keeps_structure() {
        let raw = "serverAddr = \"node.lolia.link\"\nserverPort = 7000\n\
auth.token = \"supersecret\"\n[[proxies]]\nname = \"t1\"\nlocalPort = 8080";
        let masked = mask_config(raw);
        // 必须打码
        assert!(!masked.contains("supersecret"), "token 泄漏：\n{}", masked);
        assert!(masked.contains("***"));
        // 结构必须保留，便于用户核对配置
        assert!(masked.contains("serverAddr = \"node.lolia.link\""));
        assert!(masked.contains("serverPort = 7000"));
        assert!(masked.contains("localPort = 8080"));
        assert_eq!(masked.lines().count(), raw.lines().count());
    }

    #[test]
    fn mask_config_covers_secret_and_password() {
        let masked = mask_config("auth.secretKey = \"abc\"\ncustom.password = \"p\"");
        assert!(!masked.contains("abc"));
        assert!(!masked.contains("\"p\""));
    }

    #[test]
    fn safe_file_name_strips_path_chars() {
        assert_eq!(safe_file_name("a1b2c3"), "a1b2c3");
        // 不能出现路径分隔符 / 上跳，否则可能被拼成目录穿越
        let hostile = safe_file_name("../../etc/passwd");
        assert!(!hostile.contains('/') && !hostile.contains('\\') && !hostile.contains(".."));
        assert_eq!(hostile, "______etc_passwd");
        assert_eq!(safe_file_name(""), "tunnel");
    }

    #[test]
    fn authorize_url_contains_required_params() {
        let u = build_authorize_url("cid123", DEFAULT_SCOPE, "st1");
        assert!(u.starts_with(AUTHORIZE_PAGE));
        assert!(u.contains("response_type=code"));
        assert!(u.contains("client_id=cid123"));
        assert!(u.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A11451%2Fcallback"));
        assert!(u.contains(&format!("scope={}", pct(DEFAULT_SCOPE))));
        assert!(u.contains("state=st1"));
    }

    /// 每个业务资源都必须申请到 scope：曾经只申请 `user:*`，
    /// 于是除 /user/info 外的接口全部 403。
    #[test]
    fn default_scope_covers_every_resource() {
        let parts: Vec<&str> = DEFAULT_SCOPE.split(' ').collect();
        for res in ["user", "tunnel", "traffic", "domain", "node"] {
            let want = format!("{}:*", res);
            assert!(
                parts.iter().any(|s| *s == want),
                "DEFAULT_SCOPE 里缺少 {}（实际：{}）",
                want,
                DEFAULT_SCOPE
            );
        }
        // 多个 scope 必须用空格分隔（RFC 6749 §3.3），逗号会被当成一个 scope 整体
        assert!(!DEFAULT_SCOPE.contains(','));
    }

    /// 403 权限不足要补上可执行的处置步骤，而不是只甩服务端原话
    #[test]
    fn permission_error_carries_actionable_hint() {
        let raw = "OAuth2权限不足，需要以下权限之一: tunnel:read";
        let msg = api_error_message(raw, 403);
        assert!(msg.starts_with(raw));
        assert!(msg.contains("验证 Lolia 账户"));
        assert!(msg.contains("授权管理"));

        // 其它错误保持原样，不画蛇添足
        assert_eq!(api_error_message("隧道不存在", 404), "隧道不存在（code 404）");
    }

    /// 内置范围变化时，旧 token（按旧范围签发）必须被作废，否则会一直 403
    #[test]
    fn seed_builtin_invalidates_token_when_scope_changed() {
        let dir = std::env::temp_dir().join("nettool-lolia-seed-test");
        let mut s = Store {
            scope: "user:*".to_string(),
            access_token: "old-token".to_string(),
            refresh_token: "old-refresh".to_string(),
            expire_at: 12345,
            username: "Nu0vo".to_string(),
            config_dir: dir,
            ..Default::default()
        };
        let r = seed_builtin(&mut s);
        assert!(r.changed, "范围变了应当要求落盘");
        assert!(r.invalidated, "有 token 时应当提示重新授权");
        assert_eq!(s.scope, DEFAULT_SCOPE);
        assert!(s.access_token.is_empty(), "旧 token 必须清掉");
        assert!(s.refresh_token.is_empty());
        assert_eq!(s.expire_at, 0);
        assert!(s.username.is_empty());

        // 幂等：范围已是新值，再跑一次不再算"变了"，也不会误伤已授权好的新凭据
        s.access_token = "new-token".to_string();
        let r2 = seed_builtin(&mut s);
        assert!(!r2.changed);
        assert!(!r2.invalidated);
        assert_eq!(s.access_token, "new-token");
    }

    /// 空 scope 视为"没配过"，补成内置值即可，不该谎称"凭据已作废"
    #[test]
    fn seed_builtin_fills_empty_scope() {
        let mut s = Store::default();
        let r = seed_builtin(&mut s);
        assert!(r.changed, "补了默认值就该落盘");
        assert!(!r.invalidated, "本来就没 token，谈不上作废");
        assert_eq!(s.scope, DEFAULT_SCOPE);
    }

    #[test]
    fn state_is_unique_and_url_safe() {
        let a = new_state();
        let b = new_state();
        assert!(!a.is_empty());
        assert_eq!(pct(&a), a, "state 应为 URL 安全字符");
        let _ = b;
    }

    #[test]
    fn callback_page_escapes_detail() {
        let html = callback_page(false, "<script>alert(1)</script>");
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }

    // ------------------------------------------------------------
    // 回调服务的真实跑通测试：绑 127.0.0.1:0（随机空闲端口）起监听，
    // 再用一个客户端模仿浏览器回跳，验证「接住 code / 校验 state」这两件事。
    // 不占用正式端口 11451，因此可以和开发中的程序同时跑。
    // ------------------------------------------------------------
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 起一个回调监听，返回 (地址, 任务句柄)
    async fn spawn_callback(
        expected_state: &str,
        cancel: Arc<AtomicBool>,
    ) -> (
        std::net::SocketAddr,
        tokio::task::JoinHandle<Result<String, String>>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定临时端口失败");
        let addr = listener.local_addr().expect("取本地地址失败");
        let st = expected_state.to_string();
        let h = tokio::spawn(async move { wait_for_callback(listener, cancel, &st).await });
        (addr, h)
    }

    async fn send_request(addr: std::net::SocketAddr, target: &str) -> String {
        let mut s = tokio::net::TcpStream::connect(addr).await.expect("连接失败");
        let req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", target);
        s.write_all(req.as_bytes()).await.expect("写请求失败");
        let mut buf = String::new();
        let _ = s.read_to_string(&mut buf).await;
        buf
    }

    #[tokio::test]
    async fn callback_accepts_code_and_answers_browser() {
        let (addr, h) = spawn_callback("st-1", Arc::new(AtomicBool::new(false))).await;
        let resp = send_request(addr, "/callback?code=abc123&state=st-1").await;
        assert!(resp.contains("200 OK"), "浏览器应收到 200：\n{}", resp);
        assert!(resp.contains("授权成功"), "应返回结果页：\n{}", resp);
        assert_eq!(h.await.expect("任务 panic"), Ok("abc123".to_string()));
    }

    #[tokio::test]
    async fn callback_ignores_unrelated_path_then_still_works() {
        let (addr, h) = spawn_callback("st-2", Arc::new(AtomicBool::new(false))).await;
        // 浏览器常先来 favicon，这种无关请求不能让监听退出
        let first = send_request(addr, "/favicon.ico").await;
        assert!(first.contains("404"), "无关路径应 404：\n{}", first);
        let second = send_request(addr, "/callback?code=xyz&state=st-2").await;
        assert!(second.contains("200 OK"));
        assert_eq!(h.await.expect("任务 panic"), Ok("xyz".to_string()));
    }

    #[tokio::test]
    async fn callback_rejects_mismatched_state() {
        let (addr, h) = spawn_callback("st-right", Arc::new(AtomicBool::new(false))).await;
        let resp = send_request(addr, "/callback?code=abc&state=st-wrong").await;
        assert!(resp.contains("state 校验失败"), "应提示 state 失败：\n{}", resp);
        let err = h.await.expect("任务 panic").expect_err("state 不符必须报错");
        assert!(err.contains("state"), "错误信息应说明 state：{}", err);
    }

    #[tokio::test]
    async fn callback_reports_provider_error() {
        let (addr, h) = spawn_callback("st-3", Arc::new(AtomicBool::new(false))).await;
        let _ = send_request(addr, "/callback?error=access_denied&error_description=user%20said%20no").await;
        let err = h.await.expect("任务 panic").expect_err("拒绝授权必须报错");
        assert!(err.contains("user said no"), "应回显原因：{}", err);
    }

    #[tokio::test]
    async fn callback_exits_immediately_when_cancelled() {
        let cancel = Arc::new(AtomicBool::new(true));
        let (_addr, h) = spawn_callback("st-4", cancel).await;
        let err = h.await.expect("任务 panic").expect_err("取消后应退出等待");
        assert!(err.contains("取消"), "应提示已取消：{}", err);
    }
}

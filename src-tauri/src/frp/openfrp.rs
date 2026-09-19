//! OpenFrp 接入
//!
//! 官方 OPENAPI：`https://api.openfrp.net`，文档仓库 <https://github.com/ZGIT-Network/OPENFRP-APIDOC>
//!
//! 与 LoliaFRP / SakuraFrp 模块**相互独立**：凭据、状态、进程表、日志事件全是本模块自己的，
//! 只复用 `frp_local::resolve_frpc`（定位内置 frpc.exe）这一个工具函数。
//!
//! 鉴权方式（Remote Login 远程安全登录，官方推荐的唯一登录手段）：
//! - 客户端生成临时 Curve25519 密钥对，POST 公钥到 `access.openfrp.net/argoAccess/requestLogin`
//!   拿到 `authorization_url` + `request_uuid`；用户浏览器打开授权页确认后，
//!   轮询 `argoAccess/pollLogin`，用服务器公钥 + 本地私钥做 NaCl Box 解密，得到 Authorization 明文。
//! - 解密得到的 Authorization（`OPENFRP` 开头）放进请求 Header `Authorization: OPENFRPxxx`，
//!   业务接口（getUserInfo / getUserProxies / newProxy / editProxy / removeProxy / getNodeList）
//!   全部是 **POST + JSON body**。
//! - 每个请求必须带自定义 UA，否则可能被防火墙拦截。
//! - 旧的「第三方客户端安全登录」（直接复制会话密钥）官方已不再推荐，入口也下架了。
//!
//! 隧道启动走 **简易启动（ez_startup）**：`frpc -u <用户token> -p <隧道ID,隧道ID>`，
//! frpc 自己拉取配置，**无需向云端要配置文件**。`-u -p` 是 OpenFrp 定制 frpc 的参数，
//! 标准上游 frpc 不认识，所以必须使用 OpenFrp 专用 frpc（`/commonQuery/get?key=software`
//! 拿版本号 → 下载 `frpc_windows_amd64.zip` 解压出 exe）。
//!
//! 单位约定（和樱花/Lolia 都不同，别套用）：
//! - `inLimit` / `outLimit`：上下行带宽，单位 **KiB/s**（文档误标为 Kbps，别信；
//!   官网展示 `filesize(v*1024*8, base:1000)`，即 `v×8192/1e6 = Mbps`）。
//! - `traffic`：剩余流量，单位 **MiB**。
//! - `regTime`：注册时间字符串 `2022-04-06 11:39:01`（不是 unix 时间戳）。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crypto_box::aead::{Aead, OsRng};
use crypto_box::{PublicKey, SecretKey, SalsaBox};

// ============================================================
// 常量
// ============================================================

const API_BASE: &str = "https://api.openfrp.net";
/// Remote Login 专用服务（与业务 API 不同源）
const ACCESS_BASE: &str = "https://access.openfrp.net";

/// OpenFrp 官方 frpc 下载源（软路由优先级从前往后）
const FRPC_MIRRORS: [&str; 3] = [
    "https://staticassets.naids.com/client",
    "https://r.zyghit.cn/download/client",
    "https://1dr.zyghit.cn/client",
];

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
    authorization: String,
    username: String,
    /// 用户 token（32 位，启动 frpc 的 -u 参数要用）
    user_token: String,
}

#[derive(Debug, Default)]
struct Store {
    authorization: String,
    username: String,
    user_token: String,
    config_dir: PathBuf,
}

/// Remote Login 流程中的临时状态（不落盘，仅进程内）
struct LoginSession {
    /// 本地临时 Curve25519 私钥（base64url，不落盘）
    secret_key: String,
    /// requestLogin 返回的 request_uuid
    request_uuid: String,
    /// 发起时间，用于超时判断（uuid 5 分钟有效）
    started_at: Instant,
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
    /// 简易启动没有配置文件，这里存 frpc 路径供界面排错
    pub frpc_path: String,
    pub last_exit: Option<String>,
}

#[derive(Default)]
struct TunnelRun {
    child: Option<Child>,
    pid: Option<u32>,
    started_at: Option<Instant>,
    frpc_path: PathBuf,
    auto_restart: bool,
    stopping: bool,
    restarts: u32,
    consecutive_failures: u32,
    last_exit: Option<String>,
    logs: VecDeque<LogLine>,
}

#[derive(Default)]
pub struct OpenfrpHandle {
    store: Arc<Mutex<Store>>,
    runs: Arc<Mutex<HashMap<String, TunnelRun>>>,
    login_session: Arc<Mutex<Option<LoginSession>>>,
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

fn detect_level(line: &str) -> &'static str {
    let l = line.to_ascii_lowercase();
    if l.contains("error") || l.contains("failed") || l.contains("错误") {
        "error"
    } else if l.contains("warn") || l.contains("警告") {
        "warn"
    } else if l.contains("success") || l.contains("start") || l.contains("启动") {
        "ok"
    } else {
        "info"
    }
}

/// 密钥打码：日志里绝不出现完整 Authorization / token
fn mask_token(t: &str) -> String {
    let n = t.chars().count();
    if n <= 8 {
        return "****".to_string();
    }
    let head: String = t.chars().take(4).collect();
    let tail: String = t.chars().skip(n - 4).collect();
    format!("{}****{}", head, tail)
}

// ============================================================
// HTTP 客户端
// ============================================================

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            // OpenFrp 强制要求自定义 UA，否则可能被防火墙拦截
            .user_agent("VersePC-CE/1.4 (OpenFrp integration)")
            .build()
            .unwrap_or_default()
    })
}

fn err_from_body(status: u16, text: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        let msg = v
            .get("msg")
            .and_then(|m| m.as_str())
            .or_else(|| v.get("message").and_then(|m| m.as_str()))
            .unwrap_or("");
        if !msg.is_empty() {
            return format!("{}（HTTP {}）", msg, status);
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
        "请求超时：OpenFrp API 未响应，请检查网络后重试".to_string()
    } else if e.is_connect() {
        format!("无法连接 OpenFrp API（{}）：请检查网络或代理设置", e)
    } else {
        format!("请求失败：{}", e)
    }
}

/// 带 Authorization 的 JSON 接口（业务接口统一 POST + JSON body）
async fn api_json(
    auth: &str,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", API_BASE, path);
    let resp = http()
        .post(&url)
        .header("Authorization", auth)
        .json(body)
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
    serde_json::from_str(&text)
        .map_err(|_| format!("响应不是合法 JSON（HTTP {}）：{}", status, truncate(&text, 200)))
}

/// 无需鉴权的接口（如 /commonQuery/get?key=software）
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
    serde_json::from_str(&text)
        .map_err(|_| format!("响应不是合法 JSON（HTTP {}）：{}", status, truncate(&text, 200)))
}

// ============================================================
// 凭据
// ============================================================

fn persist(g: &Store) {
    let p = Persisted {
        authorization: g.authorization.clone(),
        username: g.username.clone(),
        user_token: g.user_token.clone(),
    };
    let file = g.config_dir.join("openfrp.json");
    match serde_json::to_string_pretty(&p) {
        Ok(s) => {
            if let Err(e) = std::fs::write(&file, s) {
                super::log_warn(
                    "openfrp",
                    format!("保存凭据失败 {}: {}", file.display(), e),
                );
            }
        }
        Err(e) => super::log_warn("openfrp", format!("序列化凭据失败：{}", e)),
    }
}

pub fn init(app: &AppHandle) {
    // TLS 由 reqwest(rustls-tls) 自带，无需手动安装加密后端

    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let file = dir.join("openfrp.json");
    let loaded: Persisted = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    if let Ok(mut g) = app.state::<OpenfrpHandle>().store.lock() {
        g.authorization = loaded.authorization.clone();
        g.username = loaded.username;
        g.user_token = loaded.user_token;
        g.config_dir = dir.clone();
    }
    super::log_info(
        "openfrp",
        format!(
            "OpenFrp 模块已就绪 · 已保存的会话密钥：{}",
            if loaded.authorization.is_empty() {
                "无".to_string()
            } else {
                mask_token(&loaded.authorization)
            }
        ),
    );
}

fn take_auth(state: &OpenfrpHandle) -> Result<String, String> {
    let g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
    if g.authorization.trim().is_empty() {
        return Err(
            "尚未登录。请点击「远程安全登录」，在浏览器中完成授权".to_string(),
        );
    }
    Ok(g.authorization.clone())
}

// ============================================================
// 鉴权 / 账号命令
// ============================================================

#[tauri::command]
pub fn openfrp_auth_status(state: State<'_, OpenfrpHandle>) -> Result<AuthStatus, String> {
    let g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
    let has = !g.authorization.trim().is_empty();
    Ok(AuthStatus {
        logged_in: has,
        username: if g.username.is_empty() {
            None
        } else {
            Some(g.username.clone())
        },
        token_preview: if has {
            Some(mask_token(&g.authorization))
        } else {
            None
        },
    })
}

/// Remote Login 第一步：生成临时 Curve25519 密钥对，POST 公钥拿授权 URL。
/// 返回 `{ authorizationUrl, requestUuid }`，前端拉起浏览器打开授权页。
#[tauri::command]
pub async fn openfrp_login_start(
    state: State<'_, OpenfrpHandle>,
) -> Result<serde_json::Value, String> {
    // 1. 生成临时密钥对（每次登录都全新，绝不落盘）
    let secret = SecretKey::generate(&mut OsRng);
    let public = PublicKey::from(&secret);
    let secret_b64 = base64_url(&secret.to_bytes());
    let public_b64 = base64_url(public.as_bytes());

    // 2. requestLogin：POST 公钥
    let url = format!("{}/argoAccess/requestLogin", ACCESS_BASE);
    let body = serde_json::json!({ "public_key": public_b64 });
    let resp = http()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(err_from_req)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;
    if !(200..300).contains(&status) {
        return Err(err_from_body(status, &text));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("授权响应不是合法 JSON（HTTP {}）", status))?;

    let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
    let auth_url = data
        .get("authorization_url")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "授权响应缺少 authorization_url".to_string())?
        .to_string();
    let uuid = data
        .get("request_uuid")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "授权响应缺少 request_uuid".to_string())?
        .to_string();

    // 3. 暂存会话（5 分钟有效，超时后前端可重新发起）
    {
        let mut sess = state
            .login_session
            .lock()
            .map_err(|_| "状态锁异常".to_string())?;
        *sess = Some(LoginSession {
            secret_key: secret_b64,
            request_uuid: uuid.clone(),
            started_at: Instant::now(),
        });
    }
    super::log_info("openfrp", "已发起远程安全登录，等待浏览器授权");

    Ok(serde_json::json!({
        "authorizationUrl": auth_url,
        "requestUuid": uuid,
    }))
}

/// Remote Login 第二步：轮询授权结果，解密得到 Authorization 并落盘。
/// 返回 `{ done: bool, status: "pending"|"success"|"timeout"|"rejected" }`。
#[tauri::command]
pub async fn openfrp_login_poll(
    state: State<'_, OpenfrpHandle>,
) -> Result<serde_json::Value, String> {
    // 取出会话（连同私钥）
    let (secret_b64, uuid, started_at) = {
        let sess = state
            .login_session
            .lock()
            .map_err(|_| "状态锁异常".to_string())?;
        match sess.as_ref() {
            None => return Err("尚未发起登录，请先点「远程安全登录」".to_string()),
            Some(s) => (s.secret_key.clone(), s.request_uuid.clone(), s.started_at),
        }
    };

    // 5 分钟超时
    if started_at.elapsed() > Duration::from_secs(300) {
        return Ok(serde_json::json!({ "done": true, "status": "timeout" }));
    }

    let url = format!("{}/argoAccess/pollLogin?request_uuid={}", ACCESS_BASE, uuid);
    let resp = http()
        .get(&url)
        .send()
        .await
        .map_err(err_from_req)?;
    let status = resp.status().as_u16();

    // 服务器公钥在响应 header 里
    let server_pub_b64 = resp
        .headers()
        .get("x-request-public-key")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();

    let text = resp.text().await.map_err(|e| format!("读取响应失败：{}", e))?;

    // code 204 = 尚未授权，继续等（此时 body 为空，必须在解析 JSON 之前判断）
    if status == 204 {
        return Ok(serde_json::json!({ "done": false, "status": "pending" }));
    }
    // code 404 = 授权请求不存在（可能已过期）
    if status == 404 {
        return Ok(serde_json::json!({ "done": true, "status": "rejected" }));
    }
    if !(200..300).contains(&status) {
        return Err(err_from_body(status, &text));
    }

    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("轮询响应不是合法 JSON（HTTP {}）", status))?;

    // 某些实现可能在 200 状态码里用 code 字段表示 204/404，一并兼容
    if v.get("code").and_then(|c| c.as_u64()) == Some(204) {
        return Ok(serde_json::json!({ "done": false, "status": "pending" }));
    }
    if v.get("code").and_then(|c| c.as_u64()) == Some(404) {
        return Ok(serde_json::json!({ "done": true, "status": "rejected" }));
    }

    let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
    let enc_b64 = data
        .get("authorization_data")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "授权响应缺少 authorization_data".to_string())?;

    if server_pub_b64.is_empty() {
        return Err("轮询响应缺少 x-request-public-key，无法解密".to_string());
    }

    // 解密：NaCl Box，前 24 字节是 nonce，密文是 base64url
    let authorization = decrypt_authorization(&secret_b64, &server_pub_b64, enc_b64)?;

    // 解密成功，落盘 + 顺手校验一次
    let status = finish_login_with_auth(&state, &authorization).await?;

    // 清理临时会话（私钥用完即弃）
    if let Ok(mut sess) = state.login_session.lock() {
        *sess = None;
    }

    Ok(serde_json::json!({
        "done": true,
        "status": "success",
        "username": status.username,
    }))
}

/// 解密 authorization_data：NaCl Box（前 24 字节 nonce + 密文）。
/// 注意：`authorization_data` 密文用**标准 base64**（`+`/`/`，与 cloudflared 的
/// `base64.StdEncoding` 一致），而密钥（secret/server public key）用 base64url。
fn decrypt_authorization(
    secret_b64: &str,
    server_pub_b64: &str,
    enc_b64: &str,
) -> Result<String, String> {
    let secret_bytes = base64_url_decode(secret_b64)?;
    let server_pub_bytes = base64_url_decode(server_pub_b64)?;
    let enc_bytes = base64_std_decode(enc_b64)?;

    if secret_bytes.len() != 32 {
        return Err("本地私钥长度异常".to_string());
    }
    if server_pub_bytes.len() != 32 {
        return Err("服务器公钥长度异常".to_string());
    }
    if enc_bytes.len() < 24 {
        return Err("授权数据太短，缺少 nonce".to_string());
    }

    let mut sk = [0u8; 32];
    sk.copy_from_slice(&secret_bytes);
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&server_pub_bytes);

    let secret_key = SecretKey::from(sk);
    let server_key = PublicKey::from(pk);
    let nonce = crypto_box::Nonce::from_slice(&enc_bytes[..24]);
    let ciphertext = &enc_bytes[24..];

    let decrypted = SalsaBox::new(&server_key, &secret_key)
        .decrypt(nonce, ciphertext)
        .map_err(|_| "解密授权数据失败：密钥不匹配".to_string())?;

    String::from_utf8(decrypted).map_err(|_| "解密结果不是合法的 UTF-8 文本".to_string())
}

/// 用已解密的 Authorization 落盘 + 调 getUserInfo 校验，返回 AuthStatus
async fn finish_login_with_auth(
    state: &OpenfrpHandle,
    authorization: &str,
) -> Result<AuthStatus, String> {
    let info = api_json(authorization, "/frp/api/getUserInfo", &serde_json::json!({}))
        .await
        .map_err(|e| format!("授权完成但校验失败：{}", e))?;

    if info.get("flag").and_then(|v| v.as_bool()) == Some(false) {
        let msg = info.get("msg").and_then(|m| m.as_str()).unwrap_or("未知错误");
        return Err(format!("登录失败：{}", msg));
    }

    let data = info.get("data").cloned().unwrap_or(serde_json::Value::Null);
    let name = data
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let user_token = data
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    {
        let mut g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
        g.authorization = authorization.to_string();
        g.username = name.clone();
        g.user_token = user_token.clone();
        persist(&g);
    }
    super::log_info(
        "openfrp",
        format!("远程安全登录成功 {}", mask_token(authorization)),
    );

    Ok(AuthStatus {
        logged_in: true,
        username: if name.is_empty() { None } else { Some(name) },
        token_preview: Some(mask_token(authorization)),
    })
}

/// base64url 编码（带 padding，与 cloudflared 的 base64.URLEncoding 一致）。
/// OpenFRP 服务端用 Go 的 `base64.URLEncoding.DecodeString` 解码，要求带 `=` padding，
/// 否则 32 字节公钥（43 字符）会在末尾报 `illegal base64 data`（HTTP 400）。
fn base64_url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    base64_encode_with_table(bytes, TABLE)
}

/// 标准 base64 编码（`+`/`/` 字符集，带 padding），用于测试里模拟服务端加密密文。
#[cfg(test)]
fn base64_std(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    base64_encode_with_table(bytes, TABLE)
}

fn base64_encode_with_table(bytes: &[u8], table: &[u8; 64]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = (bytes[i] as u32) << 16 | (bytes[i + 1] as u32) << 8 | bytes[i + 2] as u32;
        out.push(table[(n >> 18) as usize & 63] as char);
        out.push(table[(n >> 12) as usize & 63] as char);
        out.push(table[(n >> 6) as usize & 63] as char);
        out.push(table[n as usize & 63] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(table[(n >> 18) as usize & 63] as char);
        out.push(table[(n >> 12) as usize & 63] as char);
        out.push_str("==");
    } else if rem == 2 {
        let n = (bytes[i] as u32) << 16 | (bytes[i + 1] as u32) << 8;
        out.push(table[(n >> 18) as usize & 63] as char);
        out.push(table[(n >> 12) as usize & 63] as char);
        out.push(table[(n >> 6) as usize & 63] as char);
        out.push('=');
    }
    out
}

fn base64_url_decode(s: &str) -> Result<Vec<u8>, String> {
    base64_decode_with_table(s, b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
}

/// 标准 base64 解码（`+`/`/` 字符集，带 padding）。
/// OpenFRP 的 `authorization_data` 密文用的是标准 base64 编码（cloudflared 用
/// `base64.StdEncoding.DecodeString` 解码），而不是 base64url —— 混用会导致密文里
/// 的 `+`/`/` 被当成非法字符跳过，解密失败报「密钥不匹配」。
fn base64_std_decode(s: &str) -> Result<Vec<u8>, String> {
    base64_decode_with_table(s, b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
}

fn base64_decode_with_table(s: &str, table: &[u8; 64]) -> Result<Vec<u8>, String> {
    const REV_BASE: [i8; 256] = {
        let mut t = [-1i8; 256];
        let mut i = 0;
        while i < 64 {
            t[i] = i as i8;
            i += 1;
        }
        t
    };
    let mut rev = [-1i8; 256];
    let mut i = 0;
    while i < 64 {
        rev[table[i] as usize] = REV_BASE[i];
        i += 1;
    }
    let bytes: Vec<u8> = s.bytes().collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &b in &bytes {
        let v = rev[b as usize];
        if v < 0 {
            continue; // 忽略非法字符（如 padding 或空白）
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn openfrp_logout(state: State<'_, OpenfrpHandle>) -> Result<(), String> {
    {
        let mut g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
        g.authorization.clear();
        g.username.clear();

        g.user_token.clear();
        persist(&g);
    }
    super::log_info("openfrp", "已清除会话密钥");
    Ok(())
}

#[tauri::command]
pub async fn openfrp_user_info(
    state: State<'_, OpenfrpHandle>,
) -> Result<serde_json::Value, String> {
    let auth = take_auth(&state)?;
    let info = api_json(&auth, "/frp/api/getUserInfo", &serde_json::json!({})).await?;
    // 顺手把用户名与 token 记下来
    if let Some(data) = info.get("data") {
        let name = data.get("username").and_then(|v| v.as_str()).unwrap_or("");
        let tok = data.get("token").and_then(|v| v.as_str()).unwrap_or("");
        let mut g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
        let mut dirty = false;
        if !name.is_empty() && g.username != name {
            g.username = name.to_string();
            dirty = true;
        }
        if !tok.is_empty() && g.user_token != tok {
            g.user_token = tok.to_string();
            dirty = true;
        }
        if dirty {
            persist(&g);
        }
    }
    Ok(info)
}

#[tauri::command]
pub async fn openfrp_nodes(state: State<'_, OpenfrpHandle>) -> Result<serde_json::Value, String> {
    let auth = take_auth(&state)?;
    api_json(&auth, "/frp/api/getNodeList", &serde_json::json!({})).await
}

#[tauri::command]
pub async fn openfrp_tunnel_list(
    state: State<'_, OpenfrpHandle>,
) -> Result<serde_json::Value, String> {
    let auth = take_auth(&state)?;
    api_json(&auth, "/frp/api/getUserProxies", &serde_json::json!({})).await
}

#[tauri::command]
pub async fn openfrp_tunnel_create(
    state: State<'_, OpenfrpHandle>,
    name: String,
    tunnel_type: String,
    node_id: i64,
    local_addr: Option<String>,
    local_port: Option<String>,
    remote_port: Option<i64>,
    domain_bind: Option<String>,
    force_https: Option<bool>,
    data_encrypt: Option<bool>,
    data_gzip: Option<bool>,
    proxy_protocol: Option<bool>,
    custom: Option<String>,
) -> Result<serde_json::Value, String> {
    let auth = take_auth(&state)?;
    if name.trim().is_empty() {
        return Err("请填写隧道名".to_string());
    }
    if node_id <= 0 {
        return Err("请选择节点".to_string());
    }
    if !matches!(
        tunnel_type.as_str(),
        "tcp" | "udp" | "http" | "https" | "stcp" | "xtcp"
    ) {
        return Err(format!("不支持的隧道类型：{}", tunnel_type));
    }

    let mut body = serde_json::json!({
        "name": name.trim(),
        "type": tunnel_type,
        "node_id": node_id,
        "local_addr": local_addr.unwrap_or_else(|| "127.0.0.1".to_string()),
        "local_port": local_port.unwrap_or_else(|| "8080".to_string()),
        "remote_port": remote_port.unwrap_or(0),
        "domain_bind": domain_bind.unwrap_or_default(),
        "forceHttps": force_https.unwrap_or(false),
        "dataEncrypt": data_encrypt.unwrap_or(false),
        "dataGzip": data_gzip.unwrap_or(false),
        "proxyProtocolVersion": proxy_protocol.unwrap_or(false),
        "autoTls": "false",
        "custom": custom.unwrap_or_default(),
    });

    // http/https 隧道远程端口不填
    if tunnel_type == "http" || tunnel_type == "https" {
        body["remote_port"] = serde_json::Value::from(0);
    }

    let r = api_json(&auth, "/frp/api/newProxy", &body).await?;
    if r.get("flag").and_then(|v| v.as_bool()) == Some(false) {
        let msg = r.get("msg").and_then(|m| m.as_str()).unwrap_or("创建失败");
        return Err(format!("创建失败：{}", msg));
    }
    super::log_info("openfrp", format!("已创建隧道 {}", name.trim()));
    Ok(r)
}

#[tauri::command]
pub async fn openfrp_tunnel_edit(
    state: State<'_, OpenfrpHandle>,
    proxy_id: i64,
    name: String,
    tunnel_type: String,
    node_id: i64,
    local_addr: Option<String>,
    local_port: Option<String>,
    remote_port: Option<i64>,
    domain_bind: Option<String>,
    force_https: Option<bool>,
    data_encrypt: Option<bool>,
    data_gzip: Option<bool>,
    proxy_protocol: Option<bool>,
    custom: Option<String>,
) -> Result<serde_json::Value, String> {
    let auth = take_auth(&state)?;
    if proxy_id <= 0 {
        return Err("隧道 ID 无效".to_string());
    }

    let mut body = serde_json::json!({
        "proxy_id": proxy_id,
        "name": name.trim(),
        "type": tunnel_type,
        "node_id": node_id,
        "local_addr": local_addr.unwrap_or_else(|| "127.0.0.1".to_string()),
        "local_port": local_port.unwrap_or_else(|| "8080".to_string()),
        "remote_port": remote_port.unwrap_or(0),
        "domain_bind": domain_bind.unwrap_or_default(),
        "forceHttps": force_https.unwrap_or(false),
        "dataEncrypt": data_encrypt.unwrap_or(false),
        "dataGzip": data_gzip.unwrap_or(false),
        "proxyProtocolVersion": proxy_protocol.unwrap_or(false),
        "autoTls": "false",
        "custom": custom.unwrap_or_default(),
    });
    if tunnel_type == "http" || tunnel_type == "https" {
        body["remote_port"] = serde_json::Value::from(0);
    }

    let r = api_json(&auth, "/frp/api/editProxy", &body).await?;
    if r.get("flag").and_then(|v| v.as_bool()) == Some(false) {
        let msg = r.get("msg").and_then(|m| m.as_str()).unwrap_or("保存失败");
        return Err(format!("保存失败：{}", msg));
    }
    super::log_info("openfrp", format!("已更新隧道 {}", name.trim()));
    Ok(r)
}

#[tauri::command]
pub async fn openfrp_tunnel_delete(
    state: State<'_, OpenfrpHandle>,
    proxy_id: i64,
) -> Result<serde_json::Value, String> {
    let auth = take_auth(&state)?;
    if proxy_id <= 0 {
        return Err("隧道 ID 无效".to_string());
    }
    let r = api_json(&auth, "/frp/api/removeProxy", &serde_json::json!({ "proxy_id": proxy_id }))
        .await?;
    if r.get("flag").and_then(|v| v.as_bool()) == Some(false) {
        let msg = r.get("msg").and_then(|m| m.as_str()).unwrap_or("删除失败");
        return Err(format!("删除失败：{}", msg));
    }
    super::log_info("openfrp", format!("已删除隧道 {}", proxy_id));
    Ok(r)
}

/// 官方 frpc 下载信息（无需鉴权）：latest_full 是版本目录名
#[tauri::command]
pub async fn openfrp_client_info() -> Result<serde_json::Value, String> {
    api_public("/commonQuery/get?key=software").await
}

// ============================================================
// OpenFrp 专用 frpc
// ============================================================

/// 专用 frpc 的存放位置
fn openfrp_frpc_file(app: &AppHandle) -> PathBuf {
    super::frp_resource_dir(app).join("frpc-openfrp.exe")
}

/// 选择要用的 frpc：OpenFrp 隧道**必须**用专用 frpc（简易启动 -u -p 只有它认）
fn pick_frpc(app: &AppHandle) -> Result<PathBuf, String> {
    let special = openfrp_frpc_file(app);
    if special.exists() {
        return Ok(special);
    }
    Err(
        "尚未下载 OpenFrp 专用 frpc。OpenFrp 的简易启动（-u -p）只有官方 frpc 支持，\
         内置的标准 frpc 无法启动 OpenFrp 隧道。请先在「概览 → 本地客户端」下载。"
            .to_string(),
    )
}

/// 跑 `frpc -v` 拿真实版本（用于界面展示）
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
    // OpenFrp frpc -v 输出形如 `OF_0.68.0_37f78258_260326`，原样取第一行
    text.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string())
}

#[tauri::command]
pub fn openfrp_frpc_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let special = openfrp_frpc_file(&app);
    let (version, exists) = if special.exists() {
        (detect_frpc_version(&special), true)
    } else {
        (None, false)
    };
    Ok(serde_json::json!({
        "path": special.display().to_string(),
        "version": version.unwrap_or_else(|| "—".to_string()),
        "exists": exists,
    }))
}

/// OpenFrp 专用 frpc 下载信息（**不实际下载**，由前端转交下载任务）。
///
/// VersePC-CE 的约定：下载一律进「下载任务」让用户看到进度，不做静默下载。
/// 前端拿到 `url` / `fallbackUrls` 后创建下载任务，落到 `savePath`，
/// 下载完成后再调 [`openfrp_frpc_install`] 解压安装。
#[tauri::command]
pub async fn openfrp_frpc_download_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let info = api_public("/commonQuery/get?key=software").await?;
    let latest_full = info
        .get("data")
        .and_then(|d| d.get("latest_full"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "未能从 OpenFrp 接口解析出最新 frpc 版本目录".to_string())?
        .to_string();

    let file_name = "frpc_windows_amd64.zip";
    let urls: Vec<String> = FRPC_MIRRORS
        .iter()
        .map(|m| format!("{}/{}/{}", m, latest_full, file_name))
        .collect();

    // 下载任务的落盘位置：exe 同目录 resources/frp/（便携语义，跟随 exe 移动）。
    // 注意 /api/download-custom 的 savePath 语义是「已存在的目录」，
    // fileName 会拼在目录后面，所以这里返回目录而不是完整文件路径。
    let save_dir = super::frp_resource_dir(&app);

    super::log_info("openfrp", format!("已解析专用 frpc 直链 {}（{}）", urls[0], latest_full));
    Ok(serde_json::json!({
        "version": latest_full,
        "fileName": file_name,
        "url": urls[0],
        "mirrors": urls,
        "savePath": save_dir.display().to_string(),
    }))
}

/// 把下载好的 zip 解压出 frpc exe，安装为 OpenFrp 专用客户端。
/// `zip_path` 可选：默认取 [`openfrp_frpc_download_info`] 约定的落盘文件
/// （openfrp 目录 + frpc_windows_amd64.zip），前端无需自己拼路径。
#[tauri::command]
pub fn openfrp_frpc_install(app: AppHandle, zip_path: Option<String>) -> Result<serde_json::Value, String> {
    let path = match zip_path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => super::frp_resource_dir(&app).join("frpc_windows_amd64.zip"),
    };
    if !path.is_file() {
        return Err(format!("下载文件不存在：{}", path.display()));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取 {} 失败：{}", path.display(), e))?;
    if bytes.is_empty() {
        return Err("下载到的文件是空的".to_string());
    }

    // 从 zip 里找到 frpc exe
    let reader = std::io::Cursor::new(&bytes);
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|e| format!("解压失败（文件不是合法 zip）：{}", e))?;

    let mut exe_bytes: Option<Vec<u8>> = None;
    let mut exe_name = String::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("读取 zip 条目失败：{}", e))?;
        let name = entry.name().to_string();
        if name.ends_with(".exe") {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut buf)
                .map_err(|e| format!("解压 {} 失败：{}", name, e))?;
            exe_bytes = Some(buf);
            exe_name = name;
            break;
        }
    }

    let exe = exe_bytes.ok_or_else(|| "zip 里没有找到 frpc.exe".to_string())?;
    let dest = openfrp_frpc_file(&app);
    std::fs::write(&dest, &exe).map_err(|e| format!("写入 {} 失败：{}", dest.display(), e))?;
    // 清理下载的 zip，不占空间
    let _ = std::fs::remove_file(&path);

    super::log_info(
        "openfrp",
        format!(
            "frpc 已安装到 {}（{} 字节，来自 {}）",
            dest.display(),
            exe.len(),
            exe_name
        ),
    );
    Ok(serde_json::json!({
        "path": dest.display().to_string(),
        "size": exe.len(),
    }))
}

/// 删掉专用 frpc
#[tauri::command]
pub fn openfrp_frpc_remove(app: AppHandle) -> Result<(), String> {
    let f = openfrp_frpc_file(&app);
    if f.exists() {
        std::fs::remove_file(&f).map_err(|e| format!("删除失败：{}", e))?;
    }
    Ok(())
}

// ============================================================
// 本地隧道运行（简易启动）
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
    let _ = app.emit("openfrp-log", &line);
}

fn run_status_of(key: &str, r: &TunnelRun) -> RunStatus {
    RunStatus {
        tunnel: key.to_string(),
        running: r.child.is_some(),
        pid: r.pid,
        uptime_secs: r.started_at.map(|t| t.elapsed().as_secs()).unwrap_or(0),
        restarts: r.restarts,
        frpc_path: r.frpc_path.display().to_string(),
        last_exit: r.last_exit.clone(),
    }
}

/// 启动 frpc（简易启动：`frpc -u <token> -p <隧道ID,隧道ID>`）
fn spawn_child(
    app: &AppHandle,
    runs: &Arc<Mutex<HashMap<String, TunnelRun>>>,
    key: &str,
    exe: &Path,
    user_token: &str,
    proxy_ids: &str,
) -> Result<u32, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("-u")
        .arg(user_token)
        .arg("-p")
        .arg(proxy_ids)
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
        r.frpc_path = exe.to_path_buf();
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
        let mut restart: Vec<String> = Vec::new(); // key 同时就是 proxy_ids
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
                                // key 同时就是 -p 的 proxy_ids（"id1,id2"）
                                restart.push(key.clone());
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
        for ids in restart {
            let exe = match pick_frpc(&app) {
                Ok(e) => e,
                Err(e) => {
                    push_log(&app, &runs, &ids, "error", format!("自动重连失败：{}", e));
                    continue;
                }
            };
            let token = {
                match app.state::<OpenfrpHandle>().store.lock() {
                    Ok(g) => g.user_token.clone(),
                    Err(_) => String::new(),
                }
            };
            if token.is_empty() {
                push_log(&app, &runs, &ids, "error", "自动重连失败：缺少用户 token".to_string());
                continue;
            }
            push_log(&app, &runs, &ids, "warn", "隧道已断开，正在自动重连 …");
            match spawn_child(&app, &runs, &ids, &exe, &token, &ids) {
                Ok(pid) => {
                    push_log(&app, &runs, &ids, "ok", format!("隧道已自动重连（PID {}）", pid))
                }
                Err(e) => push_log(&app, &runs, &ids, "error", format!("自动重连失败：{}", e)),
            }
        }
    });
}

/// 启动后确认 frpc 真的活着（参数非法会毫秒级退出）
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

/// 启动隧道。`ids` 是隧道 ID 列表（逗号分隔，支持多隧道同时启动）
#[tauri::command]
pub async fn openfrp_tunnel_start(
    app: AppHandle,
    state: State<'_, OpenfrpHandle>,
    ids: String,
    auto_restart: Option<bool>,
) -> Result<RunStatus, String> {
    let ids = ids.trim().to_string();
    if ids.is_empty() {
        return Err("请先选择要启动的隧道".to_string());
    }
    let token = {
        let g = state.store.lock().map_err(|_| "状态锁异常".to_string())?;
        if g.user_token.trim().is_empty() {
            return Err("缺少用户 token。请重新「保存并校验」会话密钥以获取用户 token".to_string());
        }
        g.user_token.clone()
    };

    let exe = pick_frpc(&app)?;
    let pid = spawn_child(&app, &state.runs, &ids, &exe, &token, &ids)?;
    push_log(&app, &state.runs, &ids, "ok", format!("隧道已启动（PID {}）", pid));

    let auto = auto_restart.unwrap_or(true);
    if let Ok(mut g) = state.runs.lock() {
        if let Some(r) = g.get_mut(&ids) {
            r.auto_restart = auto;
        }
    }

    verify_started(&app, &state.runs, &ids).await?;

    let g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    Ok(g.get(&ids)
        .map(|r| run_status_of(&ids, r))
        .unwrap_or(RunStatus {
            tunnel: ids.clone(),
            running: true,
            pid: Some(pid),
            uptime_secs: 0,
            restarts: 0,
            frpc_path: exe.display().to_string(),
            last_exit: None,
        }))
}

#[tauri::command]
pub fn openfrp_tunnel_stop(
    app: AppHandle,
    state: State<'_, OpenfrpHandle>,
    ids: String,
) -> Result<RunStatus, String> {
    let key = ids.trim().to_string();
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
pub fn openfrp_run_status(state: State<'_, OpenfrpHandle>) -> Result<Vec<RunStatus>, String> {
    let g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    let mut v: Vec<RunStatus> = g.iter().map(|(k, r)| run_status_of(k, r)).collect();
    v.sort_by(|a, b| a.tunnel.cmp(&b.tunnel));
    Ok(v)
}

#[tauri::command]
pub fn openfrp_tunnel_logs(
    state: State<'_, OpenfrpHandle>,
    ids: String,
) -> Result<Vec<LogLine>, String> {
    let key = ids.trim().to_string();
    let g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    Ok(g.get(&key)
        .map(|r| r.logs.iter().cloned().collect())
        .unwrap_or_default())
}

#[tauri::command]
pub fn openfrp_tunnel_clear_logs(
    state: State<'_, OpenfrpHandle>,
    ids: String,
) -> Result<(), String> {
    let key = ids.trim().to_string();
    let mut g = state.runs.lock().map_err(|_| "状态锁异常".to_string())?;
    if let Some(r) = g.get_mut(&key) {
        r.logs.clear();
    }
    Ok(())
}

/// 退出时杀掉所有 frpc 子进程，避免留下孤儿
pub fn shutdown(app: &AppHandle) {
    if let Some(handle) = app.try_state::<OpenfrpHandle>() {
        if let Ok(mut g) = handle.runs.lock() {
            for (key, r) in g.iter_mut() {
                if let Some(mut c) = r.child.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                    super::log_info("openfrp", format!("已停止隧道 {}", key));
                }
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
    fn masks_token() {
        assert_eq!(mask_token("abc"), "****");
        let m = mask_token("OPENFRPeyJ0eXAiOiJKV1Q");
        assert!(m.starts_with("OPEN") && m.ends_with("V1Q") && m.contains("****"));
    }

    #[test]
    fn detects_levels() {
        assert_eq!(detect_level("login error"), "error");
        assert_eq!(detect_level("warn: xxx"), "warn");
        assert_eq!(detect_level("start proxy success"), "ok");
        assert_eq!(detect_level("some info"), "info");
    }

    #[test]
    fn truncates() {
        assert_eq!(truncate("hello", 3), "hel…");
        assert_eq!(truncate("hi", 3), "hi");
    }

    #[test]
    fn base64_url_roundtrip() {
        // base64url 带 padding，且字符集含 -_
        assert_eq!(base64_url(b"\xfb\xff\xfe"), "-__-"); // 62='-',63='_'，非 +/
        assert_eq!(base64_url(b"\x00"), "AA==");
        assert_eq!(base64_url(b"\x00\x00"), "AAA=");
        assert_eq!(base64_url(b"\x00\x00\x00"), "AAAA");

        let samples: Vec<Vec<u8>> = vec![
            vec![0xde, 0xad, 0xbe, 0xef],
            (0u8..=255).collect(),
            b"OPENFRP authorization plaintext".to_vec(),
            vec![0u8; 32],
        ];
        for s in samples {
            let enc = base64_url(&s);
            assert!(!enc.contains('/') && !enc.contains('+'), "应使用 url 安全字符: {}", enc);
            assert_eq!(base64_url_decode(&enc).unwrap(), s, "解码应还原原文");
        }
    }

    #[test]
    fn base64_std_roundtrip() {
        // 标准 base64 用 +/ 字符集，密文里可能出现 +/，必须能正确还原
        assert_eq!(base64_std(b"\xfb\xff\xfe"), "+//+"); // 251,255,254 → +//+
        assert_eq!(base64_std(b"\x00"), "AA==");
        assert_eq!(base64_std(b"\x00\x00"), "AAA=");

        let samples: Vec<Vec<u8>> = vec![
            vec![0xde, 0xad, 0xbe, 0xef],
            (0u8..=255).collect(),
            b"OPENFRP authorization plaintext".to_vec(),
            vec![0u8; 32],
        ];
        for s in samples {
            let enc = base64_std(&s);
            assert_eq!(base64_std_decode(&enc).unwrap(), s, "标准 base64 解码应还原原文");
        }
    }

    #[test]
    fn nacl_box_decrypt_roundtrip() {
        // 模拟服务器：生成服务器密钥对，用客户端公钥加密明文，客户端再解密
        let client_secret = SecretKey::generate(&mut OsRng);
        let client_public = PublicKey::from(&client_secret);
        let server_secret = SecretKey::generate(&mut OsRng);
        let server_public = PublicKey::from(&server_secret);

        let plaintext = b"OPENFRPeyJ0eXAiOiJKV1QifQ.abcdef";
        // 服务器用【服务器私钥 + 客户端公钥】加密（box 对称：双方都可解）
        let nonce = crypto_box::Nonce::from([7u8; 24]);
        let boxed = SalsaBox::new(&client_public, &server_secret);
        let ciphertext = boxed.encrypt(&nonce, plaintext.as_slice()).unwrap();

        // 组装成 wire 格式：nonce(24) || ciphertext，再用【标准 base64】编码
        // （服务端密文用 base64.StdEncoding，与密钥的 base64url 不同，别混用）
        let mut wire = Vec::new();
        wire.extend_from_slice(nonce.as_slice());
        wire.extend_from_slice(&ciphertext);
        let enc_b64 = base64_std(&wire);
        let server_pub_b64 = base64_url(server_public.as_bytes());
        let client_secret_b64 = base64_url(&client_secret.to_bytes());

        // 客户端用【客户端私钥 + 服务器公钥】解密
        let decrypted =
            decrypt_authorization(&client_secret_b64, &server_pub_b64, &enc_b64).unwrap();
        assert_eq!(decrypted.as_bytes(), plaintext);
    }

    #[test]
    fn nacl_box_rejects_wrong_key() {
        let client_secret = SecretKey::generate(&mut OsRng);
        let client_public = PublicKey::from(&client_secret);
        let server_secret = SecretKey::generate(&mut OsRng);
        let server_public = PublicKey::from(&server_secret);

        let nonce = crypto_box::Nonce::from([1u8; 24]);
        let boxed = SalsaBox::new(&client_public, &server_secret);
        let ciphertext = boxed.encrypt(&nonce, b"secret".as_slice()).unwrap();

        let mut wire = Vec::new();
        wire.extend_from_slice(nonce.as_slice());
        wire.extend_from_slice(&ciphertext);
        let enc_b64 = base64_std(&wire);
        let server_pub_b64 = base64_url(server_public.as_bytes());

        // 用错误的客户端私钥解密，必须失败
        let wrong_secret = SecretKey::generate(&mut OsRng);
        let wrong_b64 = base64_url(&wrong_secret.to_bytes());
        assert!(decrypt_authorization(&wrong_b64, &server_pub_b64, &enc_b64).is_err());
    }
}

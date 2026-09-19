//! frp — 内网穿透模块（自 NetTool 迁移，2026-09-19）
//!
//! 成员：
//! - [`frp_local`]：本地 frpc 进程管理（写配置 / 拉起 / watchdog / 日志事件）
//! - [`lolia`]：LoliaFRP 开放 API（OAuth2 授权 + 隧道 / 节点 / 流量）+ 本地隧道运行
//! - [`openfrp`]：OpenFrp OPENAPI（远程安全登录 + 隧道管理）+ 简易启动
//! - [`sakura`]：SakuraFrp API v4（访问密钥 + 云端下发配置）+ 本地隧道运行
//!
//! 与 NetTool 版的差异：
//! - 不迁移 SSH 远程部署模块（frp.rs / FrpDeployView）；
//! - `applog` 换成本文件的轻量 stdout 日志；
//! - TLS 后端由 VersePC-CE 的 reqwest(rustls-tls) 自带，不再手动 install provider；
//! - OpenFrp 专用 frpc 下载改为「返回直链 + 由前端走下载任务」，见
//!   [`openfrp::openfrp_frpc_download_info`] 与 [`openfrp::openfrp_frpc_install`]。

pub mod frp_local;
pub mod lolia;
pub mod openfrp;
pub mod sakura;

// ============================================================
// 内置 frpc.exe（编译期打进 exe，运行时自解压到资源文件夹）
// ============================================================

/// 编译期内嵌的 frpc.exe（src-tauri/resources/frp/frpc.exe，构建脚本保证存在）。
/// 单文件便携：不依赖外部 resources 目录，首次启动自解压。
pub static BUNDLED_FRPC: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/frp/frpc.exe"));

/// frp 资源目录：exe 同目录的 resources/frp（便携语义，跟随 exe 移动）。
/// 目录创建失败（exe 目录只读等）时回退到应用配置目录。
pub fn frp_resource_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    if let Some(d) = exe_dir {
        let dir = d.join("resources").join("frp");
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir;
        }
    }
    let fallback = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("frp");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

/// 把内嵌的 frpc.exe 解压到资源目录（已存在且大小一致则跳过）。
/// 返回落盘路径；完全写不进去时返回 None（resolve_frpc 还有别的候选）。
pub fn ensure_bundled_frpc(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dest = frp_resource_dir(app).join("frpc.exe");
    if let Ok(meta) = std::fs::metadata(&dest) {
        if meta.len() == BUNDLED_FRPC.len() as u64 {
            return Some(dest);
        }
    }
    match std::fs::write(&dest, BUNDLED_FRPC) {
        Ok(()) => {
            log_info("frp", format!("内置 frpc 已就绪：{}", dest.display()));
            Some(dest)
        }
        Err(e) => {
            log_warn("frp", format!("内置 frpc 解压失败（{}）：{}", dest.display(), e));
            None
        }
    }
}

/// 轻量应用日志（NetTool `applog` 的替身）：打到 stdout，不引入额外依赖。
/// 只记事件名与摘要，绝不打 token / secret / 密码（各模块已自行打码）。
pub fn log_info(tag: &str, msg: impl std::fmt::Display) {
    println!("[frp:{}] {}", tag, msg);
}

pub fn log_warn(tag: &str, msg: impl std::fmt::Display) {
    eprintln!("[frp:{}] {}", tag, msg);
}

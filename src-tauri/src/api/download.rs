// api/download.rs — 下载/安装相关 API 路由
// 职责：处理 install-start / install-progress / install-cancel / check-version-name
//       以及工具箱「下载自定义文件」的 download-custom 系列

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::api::ApiResult;
use crate::download::custom_session;
use crate::install;
use crate::storage;
use crate::utils;

/// 处理下载/安装相关路由
/// 返回 Some(ApiResult) 表示已处理，None 表示不匹配
pub async fn handle(
    app: &AppHandle,
    method: &str,
    path: &str,
    params: &Option<Value>,
    body: &Option<Value>,
) -> Option<ApiResult> {
    let key = format!("{} {}", method.to_uppercase(), path);

    match key.as_str() {
        // ===== 安装入口 =====
        "POST /api/install-start" => {
            let body = body.as_ref().or(params.as_ref())?;
            let version_id = body.get("versionId").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let version_url = body.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let custom_name = body.get("customName").and_then(|v| v.as_str()).map(|s| s.to_string());
            let loader_info = body.get("loaderInfo").cloned();
            // 下载源（前端已选择，如 china-first/auto/mojang），为空时后端回退到设置值
            let download_source = body.get("downloadSource").and_then(|v| v.as_str()).map(|s| s.to_string());

            if version_id.is_empty() || version_url.is_empty() {
                return Some(ApiResult::err(400, "缺少 versionId 或 url"));
            }

            // 创建安装会话
            let (session_id, cancel_flag) = install::session::create_session(&version_id);

            // 复制变量给异步任务
            let app_clone = app.clone();
            let sid = session_id.clone();
            let vid = version_id.clone();
            let vurl = version_url.clone();
            let cname = custom_name.clone();
            let linfo = loader_info.clone();
            let dsource = download_source.clone();

            // 启动异步安装任务
            tauri::async_runtime::spawn(async move {
                install::perform_installation(app_clone, sid, vid, vurl, cname, linfo, dsource, cancel_flag).await;
            });

            Some(ApiResult::ok(json!({
                "success": true,
                "sessionId": session_id,
                "versionId": version_id,
                "loaderInfo": loader_info,
                "message": "安装已开始"
            })))
        }

        // ===== 安装进度查询（兼容旧的轮询模式） =====
        "GET /api/install-progress" => {
            let session_id = params
                .as_ref()
                .and_then(|p| p.get("sessionId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if session_id.is_empty() {
                return Some(ApiResult::ok(json!({
                    "sessionId": "",
                    "versionId": "",
                    "status": "idle",
                    "progress": 0,
                    "stage": "",
                    "message": "无安装任务",
                    "currentFile": "",
                    "totalFiles": 0,
                    "completedFiles": 0,
                    "speed": 0,
                    "bytesDownloaded": 0,
                    "totalBytes": 0,
                    "errors": []
                })));
            }

            match install::session::get_session_status(session_id) {
                Some(status) => Some(ApiResult::ok(status)),
                None => Some(ApiResult::ok(json!({
                    "sessionId": session_id,
                    "status": "completed",
                    "progress": 100,
                    "stage": "completed",
                    "message": "会话已结束"
                }))),
            }
        }

        // ===== 取消安装 =====
        "GET /api/install-cancel" => {
            let session_id = params
                .as_ref()
                .and_then(|p| p.get("sessionId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if session_id.is_empty() {
                return Some(ApiResult::err(400, "缺少 sessionId"));
            }

            let success = install::session::cancel_session(session_id);
            Some(ApiResult::ok(json!({
                "success": success,
                "message": if success { "已发送取消请求" } else { "会话不存在" }
            })))
        }

        // ===== POST 取消安装（与 GET 逻辑一致，从 body 读 sessionId） =====
        "POST /api/install-cancel" => {
            let data = body.as_ref().or(params.as_ref()).cloned().unwrap_or(Value::Null);
            let session_id = utils::get_str(&data, "sessionId");

            if session_id.is_empty() {
                return Some(ApiResult::err(400, "缺少 sessionId"));
            }

            let success = install::session::cancel_session(&session_id);
            Some(ApiResult::ok(json!({
                "success": success,
                "message": if success { "已取消" } else { "会话不存在" }
            })))
        }

        // ===== 工具箱：下载自定义文件（多线程下载引擎） =====
        "POST /api/download-custom" => {
            let data = body.as_ref().or(params.as_ref())?.clone();
            let url = utils::get_str(&data, "url");
            let save_path = utils::get_str(&data, "savePath");
            let file_name = utils::get_str(&data, "fileName");

            if url.trim().is_empty() {
                return Some(ApiResult::err(400, "请输入下载地址"));
            }
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Some(ApiResult::err(400, "仅支持 http/https 下载地址"));
            }
            if save_path.trim().is_empty() {
                return Some(ApiResult::err(400, "请选择保存位置"));
            }
            if !std::path::Path::new(save_path.trim()).is_dir() {
                return Some(ApiResult::err(400, "保存位置不存在或不是文件夹"));
            }

            let (session_id, cancel_flag) =
                custom_session::create_session(url.trim(), save_path.trim(), &file_name);

            let sid = session_id.clone();
            let task_url = url.trim().to_string();
            let task_path = save_path.trim().to_string();
            tauri::async_runtime::spawn(async move {
                run_custom_download(sid, task_url, task_path, file_name, cancel_flag).await;
            });

            Some(ApiResult::ok(json!({
                "success": true,
                "sessionId": session_id,
                "message": "下载已开始"
            })))
        }

        // ===== 工具箱：查询自定义下载进度 =====
        "GET /api/download-custom/status" => {
            let session_id = params
                .as_ref()
                .and_then(|p| p.get("sessionId"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if session_id.is_empty() {
                return Some(ApiResult::ok(json!({
                    "status": "not_found",
                    "progress": 0,
                    "message": "缺少 sessionId"
                })));
            }

            match custom_session::get_status(session_id) {
                Some(v) => Some(ApiResult::ok(v)),
                // 前端见到 not_found 会停止轮询并复位 UI
                None => Some(ApiResult::ok(json!({
                    "sessionId": session_id,
                    "status": "not_found",
                    "progress": 0,
                    "message": "会话不存在"
                }))),
            }
        }

        // ===== 工具箱：取消自定义下载 =====
        "POST /api/download-custom/cancel" => {
            let data = body.as_ref().or(params.as_ref()).cloned().unwrap_or(Value::Null);
            let session_id = utils::get_str(&data, "sessionId");

            if session_id.is_empty() {
                return Some(ApiResult::err(400, "缺少 sessionId"));
            }

            let ok = custom_session::cancel(&session_id);
            Some(ApiResult::ok(json!({
                "success": ok,
                "message": if ok { "已取消" } else { "会话不存在" }
            })))
        }

        // ===== 检查版本名是否可用 =====
        "POST /api/check-version-name" => {
            let body = body.as_ref().or(params.as_ref())?;
            let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let versions_dir = storage::resolve_data_dir().join("versions");
            let reason = validate_folder_name(name, &versions_dir);
            let available = reason.is_empty();
            Some(ApiResult::ok(json!({
                "available": available,
                "reason": reason
            })))
        }

        _ => None,
    }
}

// ============================================================================
// 工具箱「下载自定义文件」实现
// ============================================================================

/// 执行一次自定义下载：探测元信息 → 多线程分块下载 → 回写会话状态
// 全程只更新全局会话表，前端靠 GET /api/download-custom/status 轮询
async fn run_custom_download(
    session_id: String,
    url: String,
    save_path: String,
    file_name: String,
    cancel_flag: Arc<AtomicBool>,
) {
    // 1. 探测远程文件的推断文件名与总大小（失败不致命，回退为 URL 推断）
    let (auto_name, total) = probe_remote_file(&url).await;
    let raw_name = if file_name.trim().is_empty() {
        auto_name
    } else {
        file_name.trim().to_string()
    };
    let final_name = sanitize_file_name(&raw_name);
    let dest = resolve_dest_path(&save_path, &final_name);

    custom_session::update(&session_id, |s| {
        s.file_name = final_name.clone();
        s.save_path = save_path.clone();
        if total > 0 {
            s.total_bytes = total;
        }
        s.message = "开始下载...".to_string();
    });

    // 2. 进度回调：写入会话表
    let cb_sid = session_id.clone();
    let on_progress: crate::download::ProgressCb = Arc::new(move |p: &crate::download::DownloadProgress| {
        let pct = if p.total_bytes > 0 {
            ((p.bytes_downloaded.saturating_mul(100)) / p.total_bytes).min(100) as u32
        } else {
            0
        };
        let (bd, tb, sp) = (p.bytes_downloaded, p.total_bytes, p.speed);
        custom_session::update(&cb_sid, |s| {
            if s.status != custom_session::STATUS_DOWNLOADING {
                return;
            }
            s.bytes_downloaded = bd;
            if tb > 0 {
                s.total_bytes = tb;
            }
            s.progress = pct;
            s.speed = sp;
            s.message = if tb > 0 {
                format!("{} / {} · {}/s", human_size(bd), human_size(tb), human_size(sp))
            } else {
                format!("已下载 {} · {}/s", human_size(bd), human_size(sp))
            };
        });
    });

    // 3. 交给项目自带的多线程分块下载引擎（目标站点支持 Range 时自动分块并发）
    //    传 "mojang" 表示不做镜像改写 —— 这是用户自己填的地址，不能替换成项目镜像。
    let result = crate::download::download_with_mirror_cancellable(
        &url,
        &dest,
        None,
        None,
        "mojang",
        600,
        Some(on_progress),
        &cancel_flag,
    )
    .await;

    // 4. 回写终态
    match result {
        Ok(()) => {
            let saved = dest.display().to_string();
            custom_session::update(&session_id, |s| {
                s.status = custom_session::STATUS_COMPLETED.to_string();
                s.progress = 100;
                s.speed = 0;
                s.message = format!("已保存到 {}", saved);
            });
        }
        Err(e) => {
            let cancelled = cancel_flag.load(Ordering::SeqCst) || e.contains("已取消");
            custom_session::update(&session_id, |s| {
                s.speed = 0;
                if cancelled {
                    s.status = custom_session::STATUS_CANCELLED.to_string();
                    s.message = "已取消".to_string();
                    s.progress = s.progress.min(100);
                } else {
                    s.status = custom_session::STATUS_FAILED.to_string();
                    s.message = format!("下载失败：{}", e);
                }
            });
        }
    }
}

/// 探测远程文件的推断文件名与总大小（尽力而为，失败返回空名 + 0）
async fn probe_remote_file(url: &str) -> (String, u64) {
    let client = &*crate::download::single::HTTP_CLIENT;

    let resp = match client
        .get(url)
        .header("Range", "bytes=0-0")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return (String::new(), 0),
    };

    let status = resp.status().as_u16();

    // 大小：206 从 Content-Range 的 "bytes 0-0/总长" 取，200 直接用 Content-Length
    let total = if status == 206 {
        resp.headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.rsplit('/').next())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0)
    } else {
        resp.content_length().unwrap_or(0)
    };

    // 文件名：Content-Disposition 优先，其次最终 URL 的最后一段
    let mut name = resp
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_disposition_filename)
        .unwrap_or_default();

    if name.is_empty() {
        name = resp
            .url()
            .path_segments()
            .and_then(|mut seg| seg.next_back())
            .map(percent_decode)
            .unwrap_or_default();
    }

    (name, total)
}

/// 从 Content-Disposition 解析文件名（支持 RFC 5987 的 filename* 与普通 filename）
fn parse_disposition_filename(raw: &str) -> Option<String> {
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=") {
            // 形如 filename*=UTF-8''%E4%B8%AD%E6%96%87.zip
            let val = rest.rsplit("''").next().unwrap_or(rest);
            let decoded = percent_decode(val.trim().trim_matches('"'));
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename=") {
            let val = rest.trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                return Some(percent_decode(val));
            }
        }
    }
    None
}

/// 最小化 percent-decode（为解析下载文件名而写，避免引入额外依赖）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 清洗文件名：去掉路径分隔符与 Windows 非法字符，兜底 download.bin
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim().to_string();
    if trimmed.is_empty() {
        return "download.bin".to_string();
    }
    // 控制长度，避免超出文件系统上限
    trimmed.chars().take(150).collect()
}

/// 组装落盘路径；同名文件已存在时追加 (1)/(2) 序号，不静默覆盖用户已有文件
fn resolve_dest_path(dir: &str, file_name: &str) -> std::path::PathBuf {
    let dir = std::path::Path::new(dir);
    let first = dir.join(file_name);
    if !first.exists() {
        return first;
    }

    let path = std::path::Path::new(file_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("download");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");

    for i in 1..1000 {
        let candidate = if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        let p = dir.join(candidate);
        if !p.exists() {
            return p;
        }
    }
    first
}

/// 字节数转可读文本
fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{:.1} {}", v, UNITS[i])
    }
}

/// 校验版本整理夹名是否合法且不与现有版本重名。
/// 返回空字符串表示可用，否则返回错误原因。
fn validate_folder_name(name: &str, versions_dir: &std::path::Path) -> String {
    // 1. 空 / 空白
    if name.trim().is_empty() {
        return "文件夹名不能为空！".to_string();
    }
    // 2. 两端空格
    if name.starts_with(' ') {
        return "文件夹名不能以空格开头！".to_string();
    }
    if name.ends_with(' ') {
        return "文件夹名不能以空格结尾！".to_string();
    }
    // 3. 长度 1~100
    let len = name.chars().count();
    if len < 1 {
        return "长度至少需 1 个字符！".to_string();
    }
    if len > 100 {
        return "长度最长为 100 个字符！".to_string();
    }
    // 4. 尾部小数点
    if name.ends_with('.') {
        return "文件夹名不能以小数点结尾！".to_string();
    }
    // 5. 非法字符：Windows 路径非法字符 + Minecraft 额外字符 "!;"
    for c in name.chars() {
        match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '!' | ';' => {
                return format!("文件夹名不可包含 {} 字符！", c);
            }
            c if c.is_control() => {
                return format!("文件夹名不可包含 {} 字符！", c);
            }
            _ => {}
        }
    }
    // 6. Windows 保留名（CON/PRN/AUX/CLOCK$/NUL/COM0-9/LPT0-9），忽略大小写
    let upper = name.to_uppercase();
    let reserved = matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "CLOCK$" | "NUL" | "COM0" | "COM1" | "COM2" | "COM3"
            | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9" | "LPT0" | "LPT1"
            | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    );
    if reserved {
        return format!("文件夹名不可为 {}！", name);
    }
    // 7. NTFS 8.3 短文件名形式（"xx~1"）
    let bytes = name.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'~' && i >= 2 && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            return "文件夹名不能包含这一特殊格式！".to_string();
        }
    }
    // 8. 与 versions 目录下现有子文件夹名重名（忽略大小写）
    if let Ok(entries) = std::fs::read_dir(versions_dir) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            if let Some(fname) = entry.file_name().to_str() {
                if fname.eq_ignore_ascii_case(name) {
                    return "不可与现有文件夹重名！".to_string();
                }
            }
        }
    }
    String::new()
}

// download/custom_session.rs — 工具箱「下载自定义文件」会话管理
// 职责：维护用户任意 URL 下载任务的状态（进度 / 速度 / 状态），供前端轮询
//
// 背景：工具箱页面的「下载自定义文件」此前直接 fetch('/api/download-custom')，
// 但 Tauri 下既没有本地 HTTP 服务器，后端也从未实现过该路由 —— 功能一直是死的。
// 这里补上真实的会话表，配合 api/download.rs 的三个路由工作。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

/// 任务状态（前端据此渲染 / 决定是否继续轮询）
pub const STATUS_DOWNLOADING: &str = "downloading";
pub const STATUS_COMPLETED: &str = "completed";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELLED: &str = "cancelled";

/// 同时保留的终态会话上限，超过后在新建会话时回收，避免长时间运行后无限增长
const MAX_KEEP_TERMINAL: usize = 64;

/// 单个自定义下载任务
pub struct CustomDownload {
    pub session_id: String,
    pub url: String,
    pub file_name: String,
    pub save_path: String,
    pub status: String,
    pub progress: u32,
    pub message: String,
    pub speed: u64,
    pub bytes_downloaded: u64,
    pub total_bytes: u64,
    pub cancel_flag: Arc<AtomicBool>,
}

impl CustomDownload {
    fn new(session_id: String, url: String, save_path: String, file_name: String) -> Self {
        Self {
            session_id,
            url,
            file_name,
            save_path,
            status: STATUS_DOWNLOADING.to_string(),
            progress: 0,
            message: "正在连接...".to_string(),
            speed: 0,
            bytes_downloaded: 0,
            total_bytes: 0,
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "url": self.url,
            "fileName": self.file_name,
            "savePath": self.save_path,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "speed": self.speed,
            "bytesDownloaded": self.bytes_downloaded,
            "totalBytes": self.total_bytes,
        })
    }
}

type SessionMap = HashMap<String, Arc<Mutex<CustomDownload>>>;

static SESSIONS: Mutex<Option<SessionMap>> = Mutex::new(None);

fn with_map<R>(f: impl FnOnce(&mut SessionMap) -> R) -> Option<R> {
    let mut guard = SESSIONS.lock().unwrap();
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard.as_mut().map(f)
}

/// 创建新会话，返回 (session_id, cancel_flag)
pub fn create_session(url: &str, save_path: &str, file_name: &str) -> (String, Arc<AtomicBool>) {
    let session_id = format!("cdl-{}", uuid_like());
    let session = Arc::new(Mutex::new(CustomDownload::new(
        session_id.clone(),
        url.to_string(),
        save_path.to_string(),
        file_name.to_string(),
    )));
    let cancel_flag = session.lock().unwrap().cancel_flag.clone();

    with_map(|map| {
        // 回收多余的历史终态会话
        if map.len() >= MAX_KEEP_TERMINAL {
            let stale: Vec<String> = map
                .iter()
                .filter(|(_, s)| {
                    let st = s.lock().unwrap().status.clone();
                    st != STATUS_DOWNLOADING
                })
                .map(|(k, _)| k.clone())
                .collect();
            for k in stale {
                map.remove(&k);
            }
        }
        map.insert(session_id.clone(), session);
    });

    (session_id, cancel_flag)
}

/// 更新会话状态（会话不存在时静默忽略）
pub fn update(session_id: &str, f: impl FnOnce(&mut CustomDownload)) {
    with_map(|map| {
        if let Some(arc) = map.get(session_id) {
            let mut s = arc.lock().unwrap();
            f(&mut s);
        }
    });
}

/// 读取会话状态（不存在返回 None，路由据此回 not_found）
pub fn get_status(session_id: &str) -> Option<Value> {
    with_map(|map| {
        map.get(session_id)
            .map(|arc| arc.lock().unwrap().to_json())
    })
    .flatten()
}

/// 取消会话；返回 true 表示会话存在并已置取消标志
pub fn cancel(session_id: &str) -> bool {
    with_map(|map| {
        if let Some(arc) = map.get(session_id) {
            let mut s = arc.lock().unwrap();
            s.cancel_flag.store(true, Ordering::SeqCst);
            s.status = STATUS_CANCELLED.to_string();
            s.message = "已取消".to_string();
            s.speed = 0;
            return true;
        }
        false
    })
    .unwrap_or(false)
}

/// 生成简易唯一 ID（复用时间戳 + 计数，避免引入 uuid 依赖）
fn uuid_like() -> String {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", now, seq)
}

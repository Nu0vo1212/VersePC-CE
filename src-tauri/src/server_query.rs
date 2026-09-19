// server_query.rs — Minecraft 服务器状态查询（Server List Ping）
//
// 算法参考用户提供的 Python 实现（瞅眼服务器/2.py）：
//   TCP 连接 → Handshake(next_state=1) → Status Request → 读取 JSON 状态响应
//   延迟 = 握手 + 状态响应整个往返耗时（与 Python 版一致）
//
// 前端负责地址解析（host[:port] / [IPv6]:port），后端专注协议交互。

use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

fn write_varint(buf: &mut Vec<u8>, mut value: u32) {
    loop {
        if value < 0x80 {
            buf.push(value as u8);
            break;
        }
        buf.push(((value & 0x7F) | 0x80) as u8);
        value >>= 7;
    }
}

async fn read_varint(stream: &mut TcpStream) -> Option<u32> {
    let mut result: u32 = 0;
    let mut shift: u32 = 0;
    loop {
        let mut byte = [0u8; 1];
        match stream.read(&mut byte).await {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        result |= ((byte[0] & 0x7F) as u32) << shift;
        if byte[0] & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift >= 35 {
            return None;
        }
    }
}

/// 把域名拆成标签（SRV 查询名要用每个标签长度前缀编码）
fn encode_dns_name(name: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() {
            continue;
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out
}

/// 解析 DNS 报文中的名字（支持压缩指针），返回 (名字, 消费的字节数)
fn decode_dns_name(pkt: &[u8], mut pos: usize) -> Option<(String, usize)> {
    let mut labels: Vec<String> = Vec::new();
    let mut jumped = false;
    let mut end = pos;
    let mut steps = 0;
    loop {
        steps += 1;
        if steps > 64 || pos >= pkt.len() {
            return None;
        }
        let len = pkt[pos] as usize;
        if len & 0xC0 == 0xC0 {
            // 压缩指针
            if pos + 1 >= pkt.len() {
                return None;
            }
            let ptr = (((len & 0x3F) as usize) << 8) | pkt[pos + 1] as usize;
            if !jumped {
                end = pos + 2;
            }
            pos = ptr;
            jumped = true;
            continue;
        }
        pos += 1;
        if len == 0 {
            break;
        }
        if pos + len > pkt.len() {
            return None;
        }
        labels.push(String::from_utf8_lossy(&pkt[pos..pos + len]).to_string());
        pos += len;
    }
    if !jumped {
        end = pos;
    }
    Some((labels.join("."), end))
}

/// 构造一个 SRV 查询包（QTYPE=33, QCLASS=1）
fn build_srv_query(id: u16, name: &str) -> Vec<u8> {
    let mut pkt = Vec::new();
    pkt.extend_from_slice(&id.to_be_bytes());
    pkt.extend_from_slice(&[0x01, 0x00]); // flags: RD
    pkt.extend_from_slice(&[0x00, 0x01]); // QDCOUNT = 1
    pkt.extend_from_slice(&[0x00, 0x00]); // ANCOUNT
    pkt.extend_from_slice(&[0x00, 0x00]); // NSCOUNT
    pkt.extend_from_slice(&[0x00, 0x00]); // ARCOUNT
    pkt.extend_from_slice(&encode_dns_name(name));
    pkt.extend_from_slice(&[0x00, 0x21]); // QTYPE = SRV (33)
    pkt.extend_from_slice(&[0x00, 0x01]); // QCLASS = IN
    pkt
}

/// 查询 `_minecraft._tcp.<host>` 的 SRV 记录，返回 (target, port)。失败/无记录返回 None。
async fn resolve_minecraft_srv(host: &str) -> Option<(String, u16)> {
    if host.parse::<std::net::IpAddr>().is_ok() {
        return None; // IP 地址不查 SRV
    }
    let name = format!("_minecraft._tcp.{}", host);
    let id = 0x1a2b;

    // 候选 DNS 服务器：系统配置（读不了就直接用公共 DNS）
    let dns_servers: Vec<String> = ["8.8.8.8:53", "1.1.1.1:53", "223.5.5.5:53"]
        .iter()
        .map(|s| s.to_string())
        .collect();

    let query = build_srv_query(id, &name);
    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;

    for server in dns_servers {
        let _ = sock.send_to(&query, &server).await;
        let mut buf = [0u8; 2048];
        // 每个 DNS 服务器最多等 1.5s
        let n = match tokio::time::timeout(Duration::from_millis(1500), sock.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) => n,
            _ => continue,
        };
        if n < 12 {
            continue;
        }
        let resp = &buf[..n];
        let resp_id = u16::from_be_bytes([resp[0], resp[1]]);
        if resp_id != id {
            continue;
        }
        let qdcount = u16::from_be_bytes([resp[4], resp[5]]) as usize;
        let ancount = u16::from_be_bytes([resp[6], resp[7]]) as usize;
        // 跳过 question 段
        let mut pos = 12;
        for _ in 0..qdcount {
            let (_, end) = decode_dns_name(resp, pos)?;
            pos = end + 4; // QTYPE(2) + QCLASS(2)
        }
        // 遍历 answer 段，找 SRV 记录
        for _ in 0..ancount {
            let (_, end) = decode_dns_name(resp, pos)?;
            pos = end;
            if pos + 10 > resp.len() {
                break;
            }
            let qtype = u16::from_be_bytes([resp[pos], resp[pos + 1]]);
            let rdlength = u16::from_be_bytes([resp[pos + 8], resp[pos + 9]]) as usize;
            let rdata_start = pos + 10;
            pos = rdata_start + rdlength;
            if qtype != 33 {
                continue;
            }
            // SRV rdata: priority(2) weight(2) port(2) target
            if rdata_start + 6 > resp.len() {
                continue;
            }
            let port = u16::from_be_bytes([resp[rdata_start + 4], resp[rdata_start + 5]]);
            let (target, _) = decode_dns_name(resp, rdata_start + 6)?;
            let target = target.trim_end_matches('.').to_string();
            if !target.is_empty() && port > 0 {
                return Some((target, port));
            }
        }
    }
    None
}

/// 查询 MC 服务器状态。address 为纯主机名/IP（IPv6 不带方括号），port 缺省 25565。
#[tauri::command]
pub async fn tool_server_query(address: String, port: Option<u16>) -> Result<Value, String> {
    let host = address.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    if host.is_empty() {
        return Err("服务器地址不能为空".into());
    }
    let port = port.unwrap_or(25565);
    let timeout = Duration::from_secs(6);
    let start = Instant::now();

    // 优先解析 SRV 记录（如 2b2t.org 裸域名被 Cloudflare 托管、直连超时，SRV 指向真实入口 connect.2b2t.org）
    let (connect_host, connect_port) = match resolve_minecraft_srv(&host).await {
        Some((target, p)) => (target, p),
        None => (host.clone(), port),
    };

    // IPv6 主机必须用 [host]:port 形式，否则与端口号混淆
    let addr = if connect_host.contains(':') {
        format!("[{}]:{}", connect_host, connect_port)
    } else {
        format!("{}:{}", connect_host, connect_port)
    };

    let mut stream = tokio::time::timeout(timeout, TcpStream::connect(&addr))
        .await
        .map_err(|_| "连接超时".to_string())?
        .map_err(|e| format!("连接失败: {}", e))?;

    // ---- Handshake 包 ----
    let mut hs: Vec<u8> = Vec::new();
    write_varint(&mut hs, 0x00); // packet id: Handshake
    // 协议版本用 -1（VarInt 全 1），wiki.vg 推荐的状态查询通用值：
    // 2b2t 等老版本服务器（1.12.2/协议 340）的代理会校验协议号，填太新的 754/772 会被拒。
    // -1 表示"不指定版本"，绝大多数服务端/代理都接受，兼容性最好。
    write_varint(&mut hs, 0xFFFF_FFFF);
    let host_bytes = host.as_bytes();
    write_varint(&mut hs, host_bytes.len() as u32);
    hs.extend_from_slice(host_bytes);
    hs.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut hs, 0x01); // next state: Status
    let mut pkt: Vec<u8> = Vec::new();
    write_varint(&mut pkt, hs.len() as u32);
    pkt.extend_from_slice(&hs);
    stream
        .write_all(&pkt)
        .await
        .map_err(|e| format!("发送握手包失败: {}", e))?;

    // ---- Status Request 包 ----
    let mut req: Vec<u8> = Vec::new();
    write_varint(&mut req, 1); // length
    write_varint(&mut req, 0x00); // packet id: Status Request
    stream
        .write_all(&req)
        .await
        .map_err(|e| format!("发送状态请求失败: {}", e))?;

    // ---- 读取 Status Response ----
    let _len = tokio::time::timeout(timeout, read_varint(&mut stream))
        .await
        .map_err(|_| "读取响应超时".to_string())?
        .ok_or("连接已断开（长度）")?;
    let pid = tokio::time::timeout(timeout, read_varint(&mut stream))
        .await
        .map_err(|_| "读取响应超时".to_string())?
        .ok_or("连接已断开（包ID）")?;
    if pid != 0x00 {
        return Err("服务器返回了意外的响应".into());
    }
    let str_len = tokio::time::timeout(timeout, read_varint(&mut stream))
        .await
        .map_err(|_| "读取响应超时".to_string())?
        .ok_or("连接已断开（数据长度）")?;
    if str_len == 0 || str_len > 4 * 1024 * 1024 {
        return Err("响应数据异常".into());
    }
    let mut buf = vec![0u8; str_len as usize];
    tokio::time::timeout(timeout, stream.read_exact(&mut buf))
        .await
        .map_err(|_| "读取响应超时".to_string())?
        .map_err(|e| format!("读取响应失败: {}", e))?;
    let ping_ms = start.elapsed().as_millis() as u64;

    let status: Value =
        serde_json::from_slice(&buf).map_err(|e| format!("解析状态数据失败: {}", e))?;
    Ok(json!({
        "ok": true,
        "status": status,
        "pingMs": ping_ms,
        "host": host,
        "port": port
    }))
}

// ai.rs — AI 对话代理
// 在 Rust 后端发起 AI API 请求，绕过 WebView 的 CORS 限制
// 支持 openai / anthropic / google 三种接口格式

use serde_json::{json, Value};
use std::time::Duration;

// ============================================================================
// 消息与工具的格式转换
// ----------------------------------------------------------------------------
// 前端只产出**格式无关**的消息，由这里翻译成各家接口需要的样子：
//   { role:"system"|"user"|"assistant", content:"..." }
//   { role:"assistant", content:"...", toolCalls:[{ id, name, arguments }] }  // arguments 是 JSON 字符串
//   { role:"tool", toolCallId:"...", name:"...", content:"..." }              // 工具执行结果
// ============================================================================

fn msg_role(m: &Value) -> &str {
    m.get("role").and_then(|v| v.as_str()).unwrap_or("user")
}

fn msg_text(m: &Value) -> String {
    m.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// 取出 assistant 消息里的工具调用，统一为 (id, name, arguments_json_string)
fn msg_tool_calls(m: &Value) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    if let Some(arr) = m.get("toolCalls").and_then(|v| v.as_array()) {
        for (i, tc) in arr.iter().enumerate() {
            let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let id = if id.is_empty() { format!("call_{}", i + 1) } else { id };
            // arguments 允许是 JSON 字符串（openai 风格）或已是对象
            let args = match tc.get("arguments") {
                Some(Value::String(s)) => s.clone(),
                Some(v @ Value::Object(_)) => v.to_string(),
                _ => "{}".to_string(),
            };
            out.push((id, name, args));
        }
    }
    out
}

/// openai 风格 tools → anthropic tools
fn anthropic_tools(tools: &Value) -> Value {
    let mut out: Vec<Value> = Vec::new();
    if let Some(arr) = tools.as_array() {
        for t in arr {
            let f = t.get("function").unwrap_or(t);
            let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            out.push(json!({
                "name": name,
                "description": f.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "input_schema": f.get("parameters").cloned().unwrap_or(json!({ "type": "object", "properties": {} }))
            }));
        }
    }
    json!(out)
}

/// openai 风格 tools → google functionDeclarations
fn google_tools(tools: &Value) -> Value {
    let mut decls: Vec<Value> = Vec::new();
    if let Some(arr) = tools.as_array() {
        for t in arr {
            let f = t.get("function").unwrap_or(t);
            let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            decls.push(json!({
                "name": name,
                "description": f.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "parameters": f.get("parameters").cloned().unwrap_or(json!({ "type": "object", "properties": {} }))
            }));
        }
    }
    json!([{ "functionDeclarations": decls }])
}

fn has_tools(tools: Option<&Value>) -> bool {
    tools.map(|t| t.as_array().map(|a| !a.is_empty()).unwrap_or(false)).unwrap_or(false)
}

/// 根据接口格式构造请求体
fn build_body(format: &str, model: &str, messages: &Value, max_tokens: u64, tools: Option<&Value>) -> Value {
    let tokens = if max_tokens > 0 { max_tokens } else { 1024 };
    let msgs: Vec<Value> = messages.as_array().cloned().unwrap_or_default();

    match format {
        "anthropic" => {
            let mut sys_msg = String::new();
            let mut out: Vec<Value> = Vec::new();
            for m in &msgs {
                match msg_role(m) {
                    "system" => {
                        sys_msg.push_str(&msg_text(m));
                        sys_msg.push('\n');
                    }
                    "tool" => {
                        out.push(json!({
                            "role": "user",
                            "content": [{
                                "type": "tool_result",
                                "tool_use_id": m.get("toolCallId").and_then(|v| v.as_str()).unwrap_or(""),
                                "content": msg_text(m)
                            }]
                        }));
                    }
                    "assistant" => {
                        let calls = msg_tool_calls(m);
                        let text = msg_text(m);
                        if calls.is_empty() {
                            out.push(json!({ "role": "assistant", "content": text }));
                        } else {
                            // 同一轮里既有正文又有工具调用 → text 块 + tool_use 块
                            let mut parts: Vec<Value> = Vec::new();
                            if !text.trim().is_empty() {
                                parts.push(json!({ "type": "text", "text": text }));
                            }
                            for (id, name, args) in calls {
                                let input: Value = serde_json::from_str(&args).unwrap_or_else(|_| json!({}));
                                parts.push(json!({ "type": "tool_use", "id": id, "name": name, "input": input }));
                            }
                            out.push(json!({ "role": "assistant", "content": parts }));
                        }
                    }
                    _ => out.push(json!({ "role": "user", "content": msg_text(m) })),
                }
            }
            let mut body = json!({
                "model": model,
                "max_tokens": tokens,
                "system": sys_msg.trim(),
                "messages": out
            });
            if has_tools(tools) {
                body["tools"] = anthropic_tools(tools.unwrap());
            }
            body
        }
        "google" => {
            // system 抽到顶层 systemInstruction，不混进对话轮次
            let mut sys_msg = String::new();
            let mut contents: Vec<Value> = Vec::new();
            for m in &msgs {
                match msg_role(m) {
                    "system" => {
                        sys_msg.push_str(&msg_text(m));
                        sys_msg.push('\n');
                    }
                    "tool" => contents.push(json!({
                        "role": "user",
                        "parts": [{
                            "functionResponse": {
                                "name": m.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                "response": { "result": msg_text(m) }
                            }
                        }]
                    })),
                    "assistant" => {
                        let calls = msg_tool_calls(m);
                        let text = msg_text(m);
                        let mut parts: Vec<Value> = Vec::new();
                        if !text.trim().is_empty() {
                            parts.push(json!({ "text": text }));
                        }
                        for (_id, name, args) in calls {
                            let a: Value = serde_json::from_str(&args).unwrap_or_else(|_| json!({}));
                            parts.push(json!({ "functionCall": { "name": name, "args": a } }));
                        }
                        if parts.is_empty() {
                            parts.push(json!({ "text": text }));
                        }
                        contents.push(json!({ "role": "model", "parts": parts }));
                    }
                    _ => contents.push(json!({ "role": "user", "parts": [{ "text": msg_text(m) }] })),
                }
            }
            let mut body = json!({ "contents": contents, "generationConfig": { "maxOutputTokens": tokens } });
            if !sys_msg.trim().is_empty() {
                body["systemInstruction"] = json!({ "parts": [{ "text": sys_msg.trim() }] });
            }
            if has_tools(tools) {
                body["tools"] = google_tools(tools.unwrap());
            }
            body
        }
        _ => {
            // openai 格式：逐条重建，只保留合法字段（避免把自定义字段透传给严格校验的服务商）
            let mut out: Vec<Value> = Vec::new();
            for m in &msgs {
                match msg_role(m) {
                    "tool" => out.push(json!({
                        "role": "tool",
                        "tool_call_id": m.get("toolCallId").and_then(|v| v.as_str()).unwrap_or(""),
                        "content": msg_text(m)
                    })),
                    "assistant" => {
                        let calls = msg_tool_calls(m);
                        let text = msg_text(m);
                        if calls.is_empty() {
                            out.push(json!({ "role": "assistant", "content": text }));
                        } else {
                            let tcs: Vec<Value> = calls
                                .into_iter()
                                .map(|(id, name, args)| {
                                    json!({
                                        "id": id,
                                        "type": "function",
                                        "function": { "name": name, "arguments": args }
                                    })
                                })
                                .collect();
                            out.push(json!({
                                "role": "assistant",
                                "content": if text.is_empty() { Value::Null } else { json!(text) },
                                "tool_calls": tcs
                            }));
                        }
                    }
                    role => out.push(json!({ "role": role, "content": msg_text(m) })),
                }
            }
            let mut body = json!({ "model": model, "messages": out, "max_tokens": tokens });
            if has_tools(tools) {
                body["tools"] = tools.unwrap().clone();
            }
            body
        }
    }
}

/// 从响应中提取回复文本（anthropic 要把多个 text 块拼起来，否则工具调用轮会误判为空）
fn extract_reply(format: &str, data: &Value) -> String {
    let empty = "(空回复)";
    match format {
        "anthropic" => {
            if let Some(content) = data.get("content").and_then(|v| v.as_array()) {
                let text: String = content
                    .iter()
                    .filter_map(|c| c.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<&str>>()
                    .join("");
                if !text.is_empty() {
                    return text;
                }
            }
            empty.to_string()
        }
        "google" => {
            if let Some(candidates) = data.get("candidates").and_then(|v| v.as_array()) {
                if let Some(first) = candidates.first() {
                    if let Some(parts) = first
                        .get("content")
                        .and_then(|v| v.get("parts"))
                        .and_then(|v| v.as_array())
                    {
                        let text: String = parts
                            .iter()
                            .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
                            .collect::<Vec<&str>>()
                            .join("");
                        if !text.is_empty() {
                            return text;
                        }
                    }
                }
            }
            empty.to_string()
        }
        _ => {
            // openai 格式
            if let Some(choices) = data.get("choices").and_then(|v| v.as_array()) {
                if let Some(first) = choices.first() {
                    if let Some(text) = first
                        .get("message")
                        .and_then(|v| v.get("content"))
                        .and_then(|v| v.as_str())
                    {
                        return text.to_string();
                    }
                }
            }
            empty.to_string()
        }
    }
}

/// 从响应中解析工具调用，统一成 [{ id, name, arguments(JSON 字符串) }]。
/// 三种格式的结构差别很大，这里全部归一化，前端只认这一种。
fn extract_tool_calls(format: &str, data: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    match format {
        "anthropic" => {
            if let Some(arr) = data.get("content").and_then(|v| v.as_array()) {
                for c in arr {
                    if c.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                        continue;
                    }
                    let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let args = c.get("input").cloned().unwrap_or_else(|| json!({}));
                    out.push(json!({
                        "id": if id.is_empty() { format!("call_{}", out.len() + 1) } else { id.to_string() },
                        "name": name,
                        "arguments": args.to_string()
                    }));
                }
            }
        }
        "google" => {
            let parts = data
                .get("candidates")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(|v| v.as_array());
            if let Some(parts) = parts {
                for p in parts {
                    if let Some(fc) = p.get("functionCall") {
                        let name = fc.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        if name.is_empty() {
                            continue;
                        }
                        let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                        out.push(json!({
                            "id": format!("call_{}", out.len() + 1),
                            "name": name,
                            "arguments": args.to_string()
                        }));
                    }
                }
            }
        }
        _ => {
            let tcs = data
                .get("choices")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("tool_calls"))
                .and_then(|v| v.as_array());
            if let Some(tcs) = tcs {
                for (i, tc) in tcs.iter().enumerate() {
                    let f = tc.get("function").unwrap_or(tc);
                    let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let args = f.get("arguments").cloned().unwrap_or_else(|| json!("{}"));
                    let arg_str = match args {
                        Value::String(s) => s,
                        v => v.to_string(),
                    };
                    out.push(json!({
                        "id": if id.is_empty() { format!("call_{}", i + 1) } else { id.to_string() },
                        "name": name,
                        "arguments": arg_str
                    }));
                }
            }
        }
    }
    out
}

/// 将 AI 服务商返回的错误转换为用户能看懂的中文提示
fn friendly_error(status: u16, body: &str) -> String {
    let raw = &body[..body.len().min(300)];
    let lower = raw.to_lowercase();

    // 余额不足 / 配额用尽
    if status == 402
        || lower.contains("insufficient_balance")
        || lower.contains("insufficient balance")
        || lower.contains("insufficient_quota")
        || lower.contains("insufficient quota")
    {
        return format!("AI 账户余额不足，请登录对应服务商官网充值后重试（错误码 {}）", status);
    }
    // API Key 无效或过期
    if status == 401
        || lower.contains("invalid api key")
        || lower.contains("invalid_api_key")
        || lower.contains("unauthorized")
        || lower.contains("authentication")
    {
        return format!(
            "API Key 无效或已过期，请在设置中检查并重新填写正确的 API Key（错误码 {}）",
            status
        );
    }
    // 权限不足 / 内容被拒绝
    if status == 403 || lower.contains("permission_denied") || lower.contains("forbidden") {
        if lower.contains("content") && lower.contains("filter") {
            return format!(
                "请求内容被 AI 服务商拒绝（可能涉及违规内容），请换一种说法重试（错误码 {}）",
                status
            );
        }
        return format!(
            "API Key 权限不足，请检查该 Key 是否有对应模型的调用权限（错误码 {}）",
            status
        );
    }
    // 请求过于频繁 / 限流
    if status == 429 || lower.contains("rate_limit") || lower.contains("rate limit") || lower.contains("too many requests") {
        return format!("请求过于频繁，已触发限流，请稍等几秒后重试（错误码 {}）", status);
    }
    // 接口地址或模型不存在
    if status == 404
        || lower.contains("model not found")
        || lower.contains("model_not_found")
        || lower.contains("does not exist")
    {
        return format!(
            "接口地址或模型名称不正确，请检查供应商配置和所选模型是否匹配（错误码 {}）",
            status
        );
    }
    if status == 408 {
        return format!("AI 请求超时，请检查网络连接后重试（错误码 {}）", status);
    }
    if status == 413
        || lower.contains("too large")
        || lower.contains("maximum context")
        || lower.contains("context length")
    {
        return format!(
            "对话内容过长，超出了 AI 模型的处理上限，请缩短内容后重试（错误码 {}）",
            status
        );
    }
    if status == 400
        || lower.contains("invalid_request")
        || lower.contains("invalid request")
        || lower.contains("bad request")
    {
        return format!(
            "请求参数有误，可能是模型名称或消息格式不正确（错误码 {}）",
            status
        );
    }
    if status >= 500 {
        return format!("AI 服务商暂时不可用，请稍后重试（错误码 {}）", status);
    }
    format!("AI 请求失败（错误码 {}）：{}", status, raw)
}

/// AI 对话代理命令
/// 前端通过 window.electronAPI.ai.chat(reqConfig) 调用
/// reqConfig: { provider, apiKey, model, messages, endpoint, apiFormat, maxTokens, timeout, tools? }
/// 返回: { ok, reply, toolCalls? } —— toolCalls 非空时表示模型要求执行工具
#[tauri::command]
pub async fn ai_chat(config: Value) -> Value {
    let cfg = match config.as_object() {
        Some(c) => c,
        None => return json!({ "ok": false, "error": "请求参数格式错误" }),
    };

    let provider = cfg.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let api_key = cfg.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
    let model = cfg.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let endpoint = cfg.get("endpoint").and_then(|v| v.as_str()).unwrap_or("");
    let format = cfg.get("apiFormat").and_then(|v| v.as_str()).unwrap_or("openai").to_string();
    let messages = cfg.get("messages").cloned().unwrap_or(json!([]));
    let max_tokens = cfg.get("maxTokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let timeout = cfg.get("timeout").and_then(|v| v.as_u64()).unwrap_or(60000);
    let tools = cfg.get("tools").cloned();

    if provider.is_empty() && endpoint.is_empty() {
        return json!({ "ok": false, "error": "未配置供应商" });
    }
    if api_key.is_empty() {
        return json!({ "ok": false, "error": "未配置 API Key" });
    }
    if model.is_empty() {
        return json!({ "ok": false, "error": "未选择模型" });
    }

    // 构造 URL 与请求头
    let mut url = String::new();
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json"),
    );

    if provider == "custom" || !endpoint.is_empty() {
        url = endpoint.to_string();
        if format == "anthropic" {
            headers.insert("x-api-key", reqwest::header::HeaderValue::from_str(api_key).unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")));
            headers.insert("anthropic-version", reqwest::header::HeaderValue::from_static("2023-06-01"));
        } else if format == "google" {
            let sep = if url.contains('?') { '&' } else { '?' };
            url = format!("{}{}key={}", url, sep, api_key);
        } else {
            let bearer = format!("Bearer {}", api_key);
            headers.insert(reqwest::header::AUTHORIZATION, reqwest::header::HeaderValue::from_str(&bearer).unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")));
            if !url.ends_with("/chat/completions") && !url.ends_with("/completions") {
                while url.ends_with('/') { url.pop(); }
                url.push_str("/chat/completions");
            }
        }
    } else if provider == "google" || format == "google" {
        url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );
    } else if provider == "anthropic" || format == "anthropic" {
        url = if endpoint.is_empty() {
            "https://api.anthropic.com/v1/messages".to_string()
        } else {
            endpoint.to_string()
        };
        headers.insert("x-api-key", reqwest::header::HeaderValue::from_str(api_key).unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")));
        headers.insert("anthropic-version", reqwest::header::HeaderValue::from_static("2023-06-01"));
    } else {
        url = endpoint.to_string();
        let bearer = format!("Bearer {}", api_key);
        headers.insert(reqwest::header::AUTHORIZATION, reqwest::header::HeaderValue::from_str(&bearer).unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("")));
        if url.is_empty() {
            return json!({ "ok": false, "error": "供应商缺少接口地址" });
        }
    }

    if url.is_empty() {
        return json!({ "ok": false, "error": "供应商缺少接口地址" });
    }

    let body = build_body(&format, model, &messages, max_tokens, tools.as_ref());

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout.min(180_000).max(5_000)))
        .danger_accept_invalid_certs(true)
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": format!("HTTP 客户端初始化失败: {}", e) }),
    };

    let resp = match client.post(&url).headers(headers).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            return json!({ "ok": false, "error": format!("AI 请求失败: {}", e) });
        }
    };

    let status = resp.status().as_u16();
    let text = match resp.text().await {
        Ok(t) => t,
        Err(e) => return json!({ "ok": false, "error": format!("读取响应失败: {}", e) }),
    };

    if status >= 400 {
        return json!({ "ok": false, "error": friendly_error(status, &text) });
    }

    let data: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            return json!({ "ok": false, "error": format!("AI 返回非 JSON：{}", &text[..text.len().min(200)]) });
        }
    };

    let reply = extract_reply(&format, &data);
    let tool_calls = extract_tool_calls(&format, &data);
    json!({ "ok": true, "reply": reply, "toolCalls": tool_calls })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools_fixture() -> Value {
        json!([{
            "type": "function",
            "function": {
                "name": "list_versions",
                "description": "列出已安装的游戏版本",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }])
    }

    /// 一轮完整的工具往返：assistant 发起调用 → tool 回灌结果
    fn tool_roundtrip_messages() -> Value {
        json!([
            { "role": "system", "content": "你是 Verse 助手" },
            { "role": "user", "content": "我装了哪些版本？" },
            {
                "role": "assistant",
                "content": "我查一下。",
                "toolCalls": [{ "id": "call_1", "name": "list_versions", "arguments": "{}" }]
            },
            { "role": "tool", "toolCallId": "call_1", "name": "list_versions", "content": "{\"count\":2}" }
        ])
    }

    #[test]
    fn openai_body_rebuilds_tool_messages_without_extra_fields() {
        let body = build_body("openai", "gpt-4o-mini", &tool_roundtrip_messages(), 2048, Some(&tools_fixture()));
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4);
        // assistant 的工具调用必须还原成 openai 的 tool_calls 结构
        let tc = &msgs[2]["tool_calls"][0];
        assert_eq!(tc["function"]["name"], "list_versions");
        assert_eq!(tc["function"]["arguments"], "{}");
        assert_eq!(tc["type"], "function");
        // tool 结果只保留合法字段（不能把自定义的 name 透传出去）
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "call_1");
        assert_eq!(msgs[3]["content"], "{\"count\":2}");
        assert!(msgs[3].get("name").is_none());
    }

    #[test]
    fn anthropic_body_converts_tools_and_tool_roundtrip() {
        let body = build_body("anthropic", "claude-3-5-sonnet", &tool_roundtrip_messages(), 2048, Some(&tools_fixture()));
        // system 抽到顶层
        assert_eq!(body["system"], "你是 Verse 助手");
        assert_eq!(body["messages"].as_array().unwrap().len(), 3);
        // tools 用 input_schema
        assert_eq!(body["tools"][0]["name"], "list_versions");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        // assistant：正文 text 块 + tool_use 块
        let parts = body["messages"][1]["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "tool_use");
        assert_eq!(parts[1]["id"], "call_1");
        assert_eq!(parts[1]["name"], "list_versions");
        // tool 结果 → user 消息里的 tool_result（要用 tool_use_id 对应上）
        let tr = &body["messages"][2];
        assert_eq!(tr["role"], "user");
        assert_eq!(tr["content"][0]["type"], "tool_result");
        assert_eq!(tr["content"][0]["tool_use_id"], "call_1");
    }

    #[test]
    fn google_body_converts_tools_and_tool_roundtrip() {
        let body = build_body("google", "gemini-1.5-flash", &tool_roundtrip_messages(), 2048, Some(&tools_fixture()));
        // system 走 systemInstruction，不占对话轮次
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "你是 Verse 助手");
        assert_eq!(body["tools"][0]["functionDeclarations"][0]["name"], "list_versions");
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        // assistant → role=model，正文 text + functionCall
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][1]["functionCall"]["name"], "list_versions");
        // tool 结果 → role=user，functionResponse 用「工具名」而不是 id
        assert_eq!(contents[2]["role"], "user");
        assert_eq!(contents[2]["parts"][0]["functionResponse"]["name"], "list_versions");
    }

    #[test]
    fn tools_are_omitted_when_empty() {
        let empty = json!([]);
        for fmt in ["openai", "anthropic", "google"] {
            let body = build_body(fmt, "m", &json!([{ "role": "user", "content": "hi" }]), 0, Some(&empty));
            assert!(body.get("tools").is_none(), "{} 不该带上空的 tools", fmt);
            let body2 = build_body(fmt, "m", &json!([{ "role": "user", "content": "hi" }]), 0, None);
            assert!(body2.get("tools").is_none());
        }
    }

    #[test]
    fn extracts_tool_calls_from_all_three_formats() {
        let openai = json!({ "choices": [{ "message": {
            "content": null,
            "tool_calls": [{ "id": "call_a", "type": "function",
                "function": { "name": "navigate", "arguments": "{\"page\":\"mods\"}" } }]
        }}] });
        let calls = extract_tool_calls("openai", &openai);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["name"], "navigate");
        assert_eq!(calls[0]["arguments"], "{\"page\":\"mods\"}");

        let anthropic = json!({ "content": [
            { "type": "text", "text": "好的" },
            { "type": "tool_use", "id": "toolu_1", "name": "navigate", "input": { "page": "mods" } }
        ]});
        let calls = extract_tool_calls("anthropic", &anthropic);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "toolu_1");
        assert_eq!(calls[0]["arguments"], "{\"page\":\"mods\"}");

        let google = json!({ "candidates": [{ "content": { "parts": [
            { "functionCall": { "name": "navigate", "args": { "page": "mods" } } }
        ]}}]});
        let calls = extract_tool_calls("google", &google);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["name"], "navigate");
        assert_eq!(calls[0]["arguments"], "{\"page\":\"mods\"}");
    }

    #[test]
    fn no_tool_calls_means_empty_vec_and_reply_still_parsed() {
        let plain = json!({ "choices": [{ "message": { "content": "这是普通回复" } }] });
        assert!(extract_tool_calls("openai", &plain).is_empty());
        assert_eq!(extract_reply("openai", &plain), "这是普通回复");
        // anthropic 有工具块时，正文仍要能拼出来（旧实现只看第一块 → 会返回空回复）
        let mixed = json!({ "content": [{ "type": "tool_use", "id": "t", "name": "x", "input": {} }] });
        assert_eq!(extract_reply("anthropic", &mixed), "(空回复)");
    }

    #[test]
    fn missing_ids_are_generated_so_roundtrip_stays_valid() {
        let no_id = json!({ "choices": [{ "message": {
            "tool_calls": [{ "function": { "name": "navigate", "arguments": "{}" } }]
        }}] });
        let calls = extract_tool_calls("openai", &no_id);
        assert_eq!(calls[0]["id"], "call_1");
        // 带着生成出来的 id 回灌，仍应被还原
        let msgs = json!([
            { "role": "assistant", "content": "", "toolCalls": calls },
            { "role": "tool", "toolCallId": "call_1", "name": "navigate", "content": "ok" }
        ]);
        let body = build_body("openai", "m", &msgs, 0, None);
        assert_eq!(body["messages"][0]["tool_calls"][0]["id"], "call_1");
        assert_eq!(body["messages"][1]["tool_call_id"], "call_1");
    }
}

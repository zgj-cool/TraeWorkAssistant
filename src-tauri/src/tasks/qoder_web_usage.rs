//! Qoder 官网「积分消耗明细」读取（今日已用，官方网页会话）。
//!
//! 端点（实测 / 开源实现互证）：
//!   GET https://qoder.com.cn/api/v1/me/usages/big_model_credits/histories
//!       ?page=<n>&page_size=500&start_time=<ms>&end_time=<ms>
//!       &order_by=begin_at&order=-1
//! 鉴权为官网 Cookie/session（非 Bearer / 非 PAT），从本机 Qoder 客户端
//! Chromium Cookies 库读取：Local State.os_crypt.encrypted_key → DPAPI →
//! AES-256-GCM（v10）解密。全程零 cookie/token 输出，失败只回可读原因。
//!
//! 口径：**实际扣费** `credits`（免费模型上游下发 0，不得按原价虚增），
//! `credits` 缺失时回退 `original_credits`；按 `begin_at` 的本地自然日聚合。
//! 任一页失败 / 字段缺失 → ok=false，调用方回退快照。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::TimeZone;
use serde_json::{json, Value};

use crate::fs_utils;

const HISTORIES_PATH: &str = "/api/v1/me/usages/big_model_credits/histories";
const MAX_PAGES: usize = 6;
const PAGE_SIZE: usize = 500;
const ANALYTICS_PREFIXES: [&str; 4] = ["_ga", "_gcl", "_fbp", "Hm_"];

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    crate::vault::dpapi::unprotect(data)
}

#[cfg(not(windows))]
fn dpapi_unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("仅支持 Windows".into())
}

/// Local State → os_crypt.encrypted_key（base64 + DPAPI 包裹）→ AES-256 密钥
#[cfg(windows)]
fn load_aes_key(user_data: &Path) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let raw = std::fs::read_to_string(user_data.join("Local State"))
        .map_err(|e| format!("Local State 读取失败: {e}"))?;
    let ls: Value = serde_json::from_str(&raw).map_err(|e| format!("Local State 解析失败: {e}"))?;
    let enc = ls
        .get("os_crypt")
        .and_then(|v| v.get("encrypted_key"))
        .and_then(Value::as_str)
        .ok_or("Local State 无 os_crypt.encrypted_key")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(enc)
        .map_err(|e| format!("encrypted_key base64 解码失败: {e}"))?;
    if decoded.len() < 5 || &decoded[..5] != b"DPAPI" {
        return Err("encrypted_key 前缀非 DPAPI".into());
    }
    dpapi_unprotect(&decoded[5..])
}

/// v10 布局：'v10' + nonce(12) + ciphertext+tag(16)。
/// 非 v10 仅当内容是可打印 ASCII 时视为「老布局明文」——v20（Edge/Chrome 127+
/// App-Bound Encryption）等新密文绝不能按明文本透传：既拼不出有效 Cookie 头，
/// 又会把密文随请求错误消息泄露到日志/终端（2026-11-26 探针实测 Edge 全线 v20）。
#[cfg(windows)]
fn decrypt_blob(blob: &[u8], key: &[u8]) -> Option<String> {
    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    if blob.len() < 19 || &blob[..3] != b"v10" {
        let plain = String::from_utf8_lossy(blob).trim().to_string();
        let printable = !plain.is_empty() && plain.chars().all(|c| c.is_ascii_graphic() || c == ' ');
        return printable.then_some(plain);
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let nonce = Nonce::from_slice(&blob[3..15]);
    let plain = cipher.decrypt(nonce, &blob[15..]).ok()?;
    let s = String::from_utf8_lossy(&plain).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// 客户端运行中 Cookies 库被独占：复制到临时目录再读（-wal/-shm 一并复制）
#[cfg(windows)]
fn copy_cookies_db(prof: &Path) -> Result<(PathBuf, PathBuf), String> {
    let mut db = prof.join("Network").join("Cookies");
    if !db.exists() {
        db = prof.join("Cookies");
        if !db.exists() {
            return Err("未找到 Qoder Cookies 库".into());
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let td = std::env::temp_dir().join(format!("aw_qck_{}_{nanos}", std::process::id()));
    std::fs::create_dir_all(&td).map_err(|e| format!("临时目录创建失败: {e}"))?;
    let tmp_db = td.join("Cookies");
    let mut copied = Err("unreached".into());
    for _ in 0..3 {
        copied = std::fs::copy(&db, &tmp_db)
            .map(|_| ())
            .map_err(|e| format!("Cookies 复制失败（客户端可能占用）: {e}"));
        if copied.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    copied?;
    for suffix in ["-wal", "-shm"] {
        let side = db.with_file_name(format!("Cookies{suffix}"));
        if side.exists() {
            let _ = std::fs::copy(&side, td.join(format!("Cookies{suffix}")));
        }
    }
    Ok((tmp_db, td))
}

/// user_data 下一级含 Cookies 的目录（Chromium 多 Profile；Electron 根级 Network/Cookies
/// 也会作为名为 "Network" 的 profile 条目命中）。read_cookie_header 与手工探针共用，
/// 保证「读哪里」只有一个口径。
#[cfg(windows)]
fn profile_dirs_with_cookies(user_data: &Path) -> Result<Vec<PathBuf>, String> {
    let mut profiles: Vec<PathBuf> = std::fs::read_dir(user_data)
        .map_err(|e| format!("User Data 遍历失败: {e}"))?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .filter(|p| p.join("Network").join("Cookies").exists() || p.join("Cookies").exists())
        .collect();
    // Default / Profile * 优先，活跃账号通常在 Default
    profiles.sort_by_key(|p| p.file_name().and_then(|n| n.to_str()) != Some("Default"));
    Ok(profiles)
}

/// 从临时复制的 Cookies 库读 qoder 域记录（名称 + 密文）；读库失败 → 空表
#[cfg(windows)]
fn read_cookie_rows(tmp_db: &Path) -> Vec<(String, Vec<u8>)> {
    rusqlite::Connection::open_with_flags(tmp_db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|conn| {
            let mut stmt = conn.prepare(
                "SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%qoder.com%' OR host_key LIKE '%qoder.cn%' ORDER BY length(path) DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?;
            let mut out = Vec::new();
            for r in rows.flatten() {
                out.push(r);
            }
            Ok(out)
        })
        .unwrap_or_default()
}

/// 读取 qoder.com(.cn) 域 cookie → `Cookie` 请求头字符串（多 Profile 合并，不覆盖已取到的键）
#[cfg(windows)]
fn read_cookie_header(user_data: &Path) -> Result<String, String> {
    let key = load_aes_key(user_data)?;
    let mut cookies: HashMap<String, String> = HashMap::new();
    let profiles = profile_dirs_with_cookies(user_data)?;
    for prof in &profiles {
        let Ok((tmp_db, td)) = copy_cookies_db(prof) else { continue };
        let rows = read_cookie_rows(&tmp_db);
        let _ = std::fs::remove_dir_all(&td);
        for (name, enc) in rows {
            if ANALYTICS_PREFIXES.iter().any(|p| name.starts_with(p)) {
                continue;
            }
            if let Some(val) = decrypt_blob(&enc, &key) {
                cookies.entry(name).or_insert(val);
            }
        }
    }
    if cookies.is_empty() {
        return Err("未读取到 Qoder 官网会话 Cookie（请先在客户端登录账号中心）".into());
    }
    let mut parts: Vec<String> = cookies.into_iter().map(|(k, v)| format!("{k}={v}")).collect();
    parts.sort();
    Ok(parts.join("; "))
}

fn s_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").to_string()
}

fn num_f64(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    v.as_f64().or_else(|| v.as_str()?.trim().parse::<f64>().ok())
}

fn record_is_today(v: &Value, today: &str) -> bool {
    if let Some(ms) = v.as_i64().filter(|n| *n > 1_000_000_000_000) {
        return chrono::Local
            .timestamp_millis_opt(ms)
            .single()
            .map(|d| d.format("%Y-%m-%d").to_string() == today)
            .unwrap_or(false);
    }
    let s = s_of(Some(v));
    if s.is_empty() {
        return false;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&s) {
        return dt.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string() == today;
    }
    s.len() >= 10 && &s[..10] == today
}

/// 单页响应 → (当日实际扣费, 记录数, 是否还有下一页)
fn parse_page(body: &Value, today: &str) -> Result<(f64, usize, bool), String> {
    let data = fs_utils::dig(body, &["data"])
        .and_then(Value::as_array)
        .ok_or("响应缺 data 数组")?;
    if fs_utils::dig(body, &["page_result"]).is_none() {
        return Err("响应缺 page_result".into());
    }
    let mut used = 0.0;
    for rec in data {
        let begin = fs_utils::dig(rec, &["begin_at", "beginAt"]);
        let original = fs_utils::dig(rec, &["original_credits", "originalCredits"]);
        let credits = fs_utils::dig(rec, &["credits", "used_value", "usedValue"]);
        let Some(begin) = begin else {
            return Err("用量记录字段缺失（begin_at）".into());
        };
        if !record_is_today(begin, today) {
            continue;
        }
        // 消耗口径：实际扣费 credits（免费模型为 0），缺失回退原价名义值
        let actual = num_f64(credits)
            .or_else(|| num_f64(original))
            .ok_or("积分字段非数值（credits / original_credits）")?;
        used += actual;
    }
    let has_next = data.len() >= PAGE_SIZE;
    Ok((used, data.len(), has_next))
}

fn rounded(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

#[cfg(windows)]
fn fetch_impl() -> Value {
    let user_data = std::env::var("APPDATA")
        .map(|p| PathBuf::from(p).join("com.qodercn.app.stable"))
        .map_err(|_| "未找到 APPDATA".to_string())
        .and_then(|p| {
            if p.exists() {
                Ok(p)
            } else {
                Err("未找到 Qoder 客户端数据目录".into())
            }
        });
    let user_data = match user_data {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "used_today": null, "error": e }),
    };
    let cookie = match read_cookie_header(&user_data) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "used_today": null, "error": e }),
    };

    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|dt| dt.and_local_timezone(chrono::Local).single())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|| now.timestamp_millis() - 86_400_000);
    let end = now.timestamp_millis();
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build();

    let mut used = 0.0;
    let mut records = 0usize;
    for page in 1..=MAX_PAGES {
        let url = format!(
            "https://qoder.com.cn{HISTORIES_PATH}?page={page}&page_size={PAGE_SIZE}&start_time={start}&end_time={end}&order_by=begin_at&order=-1"
        );
        let resp = agent
            .get(&url)
            .set("Cookie", &cookie)
            .set("Origin", "https://qoder.com.cn")
            .set("Referer", "https://qoder.com.cn/account/usage")
            .set("X-Requested-With", "XMLHttpRequest")
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")
            .call();
        let body: Value = match resp {
            Ok(r) => match r.into_json::<Value>() {
                Ok(v) => v,
                Err(e) => {
                    return json!({ "ok": false, "used_today": null, "error": format!("响应解析失败: {e}") })
                }
            },
            Err(ureq::Error::Status(code, _)) => {
                return json!({ "ok": false, "used_today": null, "error": format!("官网返回 HTTP {code}（会话可能过期）") })
            }
            Err(e) => {
                return json!({ "ok": false, "used_today": null, "error": format!("官网请求失败: {e}") })
            }
        };
        match parse_page(&body, &today) {
            Ok((u, n, has_next)) => {
                used += u;
                records += n;
                if !has_next {
                    return json!({
                        "ok": true,
                        "used_today": rounded(used),
                        // 历史字段：现与 used_today 同口径（实际扣费），保留以兼容旧前端
                        "billed_today": rounded(used),
                        "records": records,
                        "source": "official_web_cookie",
                        "fetched_at": chrono::Utc::now().timestamp(),
                    });
                }
            }
            Err(e) => {
                return json!({ "ok": false, "used_today": null, "error": e });
            }
        }
    }
    json!({ "ok": false, "used_today": null, "error": "分页超过 6 页，放弃部分统计" })
}

#[cfg(not(windows))]
fn fetch_impl() -> Value {
    json!({ "ok": false, "used_today": null, "error": "Qoder 官网会话读取仅支持 Windows" })
}

/// 供 Tauri 命令调用：今日官网积分消耗聚合（失败时 ok=false，不含敏感信息）
pub fn fetch_today_usage() -> Value {
    let result = fetch_impl();
    if result.get("ok").and_then(Value::as_bool) == Some(false) {
        if let Some(err) = result.get("error").and_then(Value::as_str) {
            fs_utils::app_log_default(&format!("[qoder-web-usage] {err}"));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_page_aggregates_today_actual_only() {
        let body = json!({
            "data": [
                { "begin_at": "2026-11-19T10:00:00+08:00", "original_credits": "12.5", "credits": 3 },
                // 免费模型：原价 20 但实际扣 0，不得计入消耗
                { "begin_at": "2026-11-19T11:00:00+08:00", "original_credits": 20, "credits": 0 },
                { "begin_at": "2026-11-18T10:00:00+08:00", "original_credits": 99, "credits": 99 }
            ],
            "page_result": { "page": 1 }
        });
        // 仅当日实际扣费求和（第三行前一日被过滤）
        let (used, n, more) = parse_page(&body, "2026-11-19").unwrap();
        assert!((used - 3.0).abs() < 1e-9);
        assert_eq!(n, 3);
        assert!(!more);
    }

    #[test]
    fn parse_page_rejects_missing_fields() {
        let body = json!({ "data": [{ "begin_at": "2026-11-19T10:00:00+08:00" }], "page_result": {} });
        assert!(parse_page(&body, "2026-11-19").is_err());
        assert!(parse_page(&json!({"data": []}), "2026-11-19").is_err());
    }

    #[test]
    fn num_f64_accepts_number_and_numeric_string() {
        assert_eq!(num_f64(Some(&json!(12.5))), Some(12.5));
        assert_eq!(num_f64(Some(&json!("3.25"))), Some(3.25));
        assert_eq!(num_f64(Some(&json!("x"))), None);
    }

    /// v20（App-Bound）密不得按明文本透传；老布局可打印明文保留
    #[cfg(windows)]
    #[test]
    fn decrypt_blob_rejects_app_bound_ciphertext() {
        let key = [0u8; 32];
        assert_eq!(
            decrypt_blob(b"v20\x01\x02\x03\x04\x05\xff\xfe\x00garbage", &key),
            None
        );
        assert_eq!(decrypt_blob(b"plain-value", &key), Some("plain-value".to_string()));
        assert_eq!(decrypt_blob(b"", &key), None);
    }
}

/// 手工探针（`cargo test probe_qoder_web_usage_cookie -- --ignored --nocapture`）：
/// 逐来源报告「能否读到 cookie / 读不到的原因 / 读到的 cookie 名称」，发现会话类 cookie
/// 时调一次 histories 并只打印响应键名与条数——**绝不输出 cookie 值与字段值**。
/// 用途：验证官网明细通道是否可行（多账号需每个账号各一份官网会话）。
#[cfg(all(test, windows))]
mod probe_cookie {
    use super::*;

    fn sources() -> Vec<(String, PathBuf)> {
        let mut out = Vec::new();
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let work = PathBuf::from(&appdata).join("com.qodercn.app.stable");
        if work.exists() {
            out.push(("QoderWork-current".into(), work));
        }
        let slots = PathBuf::from(&appdata)
            .join("AIWorkAssistant")
            .join("data")
            .join("profiles_qoder_work");
        if let Ok(rd) = std::fs::read_dir(&slots) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    out.push((format!("work-slot:{}", e.file_name().to_string_lossy()), e.path()));
                }
            }
        }
        for (name, p) in [
            ("edge", PathBuf::from(&local).join("Microsoft").join("Edge").join("User Data")),
            ("chrome", PathBuf::from(&local).join("Google").join("Chrome").join("User Data")),
        ] {
            if p.exists() {
                out.push((name.into(), p));
            }
        }
        if let Ok(extra) = std::env::var("QODER_PROBE_USER_DATA") {
            if !extra.is_empty() {
                out.push(("env".into(), PathBuf::from(extra)));
            }
        }
        out
    }

    fn probe_source(name: &str, user_data: &Path) {
        println!("[probe] ===== {name}: {}", user_data.display());
        let key = match load_aes_key(user_data) {
            Ok(k) => k,
            Err(e) => {
                println!("[probe]   Local State/密钥不可用: {e}");
                return;
            }
        };
        let profiles = match profile_dirs_with_cookies(user_data) {
            Ok(p) => p,
            Err(e) => {
                println!("[probe]   遍历失败: {e}");
                return;
            }
        };
        if profiles.is_empty() {
            println!("[probe]   无含 Cookies 的 profile 目录");
            return;
        }
        let mut header: Option<String> = None;
        for prof in profiles {
            let label = prof.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let (tmp_db, td) = match copy_cookies_db(&prof) {
                Ok(v) => v,
                Err(e) => {
                    println!("[probe]   {label}: Cookies 复制失败 -> {e}");
                    continue;
                }
            };
            let rows = read_cookie_rows(&tmp_db);
            let _ = std::fs::remove_dir_all(&td);
            let mut names = Vec::new();
            let mut decrypted = 0usize;
            for (n, enc) in &rows {
                names.push(n.clone());
                if decrypt_blob(enc, &key).is_some() {
                    decrypted += 1;
                }
            }
            println!(
                "[probe]   {label}: qoder 域记录 {} 条，解密成功 {decrypted}；名称 {names:?}",
                rows.len()
            );
            if header.is_none() && names.iter().any(|n| n.contains("session")) {
                // 复用生产读取器生成请求头（值不外泄）
                match read_cookie_header(user_data) {
                    Ok(h) => header = Some(h),
                    Err(e) => println!("[probe]   会话 cookie 未能组装: {e}"),
                }
            }
        }
        let Some(h) = header else {
            println!("[probe]   未发现会话类 cookie（session*），不调用 histories");
            return;
        };
        println!("[probe]   调用 histories（近 7 天，page_size=5）…");
        println!("[probe]   {}", call_histories(&h));
    }

    fn call_histories(cookie: &str) -> Value {
        let now = chrono::Local::now();
        let end = now.timestamp_millis();
        let start = (now - chrono::Duration::days(7)).timestamp_millis();
        let url = format!(
            "https://qoder.com.cn{HISTORIES_PATH}?page=1&page_size=5&start_time={start}&end_time={end}&order_by=begin_at&order=-1"
        );
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(20))
            .build();
        let resp = agent
            .get(&url)
            .set("Cookie", cookie)
            .set("Origin", "https://qoder.com.cn")
            .set("Referer", "https://qoder.com.cn/account/usage")
            .set("X-Requested-With", "XMLHttpRequest")
            .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")
            .call();
        let summarize = |body: Value| {
            json!({
                "top_keys": body.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()),
                "data_len": body.get("data").and_then(Value::as_array).map(|a| a.len()),
                "record_keys": body
                    .get("data")
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                    .and_then(Value::as_object)
                    .map(|m| m.keys().cloned().collect::<Vec<_>>()),
                "page_result_keys": body
                    .get("page_result")
                    .and_then(Value::as_object)
                    .map(|m| m.keys().cloned().collect::<Vec<_>>()),
            })
        };
        match resp {
            Ok(r) => json!({ "status": 200, "shape": summarize(r.into_json().unwrap_or_default()) }),
            Err(ureq::Error::Status(code, r)) => {
                json!({ "status": code, "shape": summarize(r.into_json().unwrap_or_default()) })
            }
            Err(e) => json!({ "error": e.to_string() }),
        }
    }

    #[test]
    #[ignore]
    fn probe_qoder_web_usage_cookie() {
        for (name, dir) in sources() {
            probe_source(&name, &dir);
        }
    }
}

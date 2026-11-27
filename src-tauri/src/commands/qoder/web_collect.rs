//! Qoder 官网用量采集（Webview 同源 fetch 回传）。
//!
//! 背景：官网 `/api/v1/me/usages/big_model_credits/histories` 走网页会话鉴权，
//! 而 Edge/Chrome 127+ 的 cookie 是 v20（App-Bound Encryption），本机 DPAPI/AES-v10
//! 链路解不开（2026-11-26 探针实测：29 条含 qoder_session_cookie，解密成功 0）；
//! Qoder 客户端 cookie 库也不含官网会话。
//!
//! 因此改为「不碰加密」：Tauri 创建独立数据目录的 Webview 打开官网 usage 页，
//! 用户在该窗口登录一次后，注入脚本在**页面上下文**同源 fetch histories
//! （cookie 由 WebView 自动携带，不读出、不打印、不入库），挑拣必要字段后
//! POST 到本机回环端口回传，Rust 侧聚合入 kv `qoder_web_usage_cache`。
//!
//! 安全面：
//! - 回环监听仅绑定 127.0.0.1 随机端口 + 一次性随机 token（查询参数校验）；
//! - 只接收 `{records:[{t,oc,c,m,id}], grabbed_at_ms, href}`，请求体上限 8MB；
//! - 回传内容不含 cookie/token/prompt 等敏感字段（脚本侧只挑数值与模型名）；
//! - 事件/日志只含条数与汇总，不含明细。
//!
//! 最小版口径：近 31 天、单个 Webview 数据目录（后续按账号隔离扩展）。

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use chrono::TimeZone;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::fs_utils;
use crate::state::AppState;
use crate::commands::usage_history::{UsageSessionView, UsageSessionsResult};

/// 聚合结果 kv 键（前端 `qoder_web_usage_get` 读取）
const CACHE_KEY: &str = "qoder_web_usage_cache";
/// 采集窗口 label（唯一；重复点击先关旧窗）
const COLLECT_LABEL: &str = "qoder-web-collect";
/// 采集窗口等待上限（用户登录 + 31 天分页拉取）
const COLLECT_TIMEOUT: Duration = Duration::from_secs(240);
/// 请求体上限（近 31 天 × 500/页 × ≤20 页的挑拣字段仍远小于此）
const MAX_BODY: usize = 8 * 1024 * 1024;
/// 页面采集目标（与 qoder_web_usage.rs 同一端点；窗口打开页仅供用户登录）
const USAGE_PAGE: &str = "https://qoder.com.cn/account/usage";

/// 防重入：采集窗口在同一时刻只允许一个
static COLLECT_RUNNING: AtomicBool = AtomicBool::new(false);
/// 取消标记：窗口被用户关闭时置位，接收线程随即收尾
static COLLECT_CANCEL: AtomicBool = AtomicBool::new(false);

/// 注入脚本模板：`__PORT__` / `__TOKEN__` 由 Rust 侧替换。
/// 说明：HTTPS 页面请求 `http://127.0.0.1` 属 Chromium「potentially trustworthy」
/// 例外，不受混合内容拦截；Qoder 首页无 CSP（2026-11-26 实测），fetch/beacon 不被拦。
/// 用 `mode:"no-cors"` + `text/plain`（简单请求，无预检）发送，服务端不读响应体。
const SCRIPT_TEMPLATE: &str = r##"
(function () {
  var PORT = __PORT__, TOKEN = "__TOKEN__";
  var ENDPOINT = "http://127.0.0.1:" + PORT + "/ingest?token=" + TOKEN;
  var PAGE_SIZE = 500, MAX_PAGES = 20, DAYS = 31;
  var done = false, tries = 0;

  // 模型字段宽容解析：上游字段名不固定（字符串或 {name/code} 对象均兼容）。
  // 2026-11-26 字段探针实测 Qoder histories 无 model 字段，模型在 model_category。
  function modelOf(r) {
    var cands = [
      r.model_category, r.modelCategory,
      r.model, r.model_name, r.modelName, r.model_code, r.modelCode,
      r.model_id, r.modelId, r.llm_model, r.llmModel,
      r.used_model, r.usedModel, r.request_model, r.requestModel,
      r.agent_model, r.agentModel, r.code_model, r.codeModel,
      r.model_display_name, r.modelDisplayName
    ];
    for (var i = 0; i < cands.length; i++) {
      var v = cands[i];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (v && typeof v === "object") {
        var n = v.name || v.model_name || v.modelName || v.code || v.id || "";
        if (typeof n === "string" && n.trim()) return n.trim();
      }
    }
    return "";
  }
  function pick(r) {
    // 会话说明：上游实测无 input/prompt 字段，改用 name（会话/任务名）；
    // 保留 inputTrunc 等候选以兼容字段漂移，截断 200 字符防撑爆缓存。
    var pv = r.inputTrunc || r.input_trunc || r.input || r.prompt || r.agentPurpose || r.agent_purpose || r.description || r.name || "";
    // 业务类型/来源：官网实测仅 source 字段有值（kind/operation 恒空）
    var src = typeof r.source === "string" ? r.source : "";
    return {
      t: r.begin_at || r.beginAt || r.request_time || r.requestTime || r.time || null,
      oc: r.original_credits != null ? r.original_credits : r.originalCredits,
      c: r.credits != null ? r.credits : (r.used_value != null ? r.used_value : r.usedValue),
      m: modelOf(r),
      // 请求标识：上游无 request_id，优先 business_id，回退 session_id（同会话多行共享，可接受）
      id: r.request_id || r.requestId || r.business_id || r.businessId || r.session_id || r.sessionId || r.id || "",
      p: String(pv).replace(/\s+/g, " ").trim().slice(0, 200),
      // ── 以下为官网专有字段（会话明细展示原价/折扣/费用/类型） ──
      cm: r.cost != null ? r.cost : (r.cost_money != null ? r.cost_money : null),
      ocm: r.original_cost != null ? r.original_cost : (r.originalCost != null ? r.originalCost : null),
      d: r.discount_factor != null ? r.discount_factor : (r.discountFactor != null ? r.discountFactor : null),
      src: src,
      sid: r.session_id || r.sessionId || "",
      bid: r.business_id || r.businessId || ""
    };
  }
  async function page(n) {
    var start = Date.now() - DAYS * 86400000, end = Date.now();
    var url = "/api/v1/me/usages/big_model_credits/histories?page=" + n + "&page_size=" + PAGE_SIZE +
      "&start_time=" + start + "&end_time=" + end + "&order_by=begin_at&order=-1";
    // 对齐官网前端真实请求头（x-csrf-token 为固定 echo 值），降低被服务端拒绝的概率
    var r = await fetch(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        "x-csrf-token": "_echo_csrf_using_sec_fetch_site_",
        "x-requested-with": "XMLHttpRequest"
      },
      credentials: "include"
    });
    if (!r.ok) return { error: r.status };
    var j = await r.json();
    return { data: (j && j.data) || [] };
  }
  async function collect() {
    var all = [];
    for (var n = 1; n <= MAX_PAGES; n++) {
      var p = await page(n);
      if (p.error) return { error: p.error };
      if (!p.data.length) break;
      all = all.concat(p.data.map(pick));
      if (p.data.length < PAGE_SIZE) break;
    }
    return { records: all };
  }
  function toast(text, ok) {
    try {
      var el = document.createElement("div");
      el.textContent = text;
      el.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:10px 14px;" +
        "border-radius:8px;font:14px/1.4 system-ui,sans-serif;color:#fff;" +
        "box-shadow:0 6px 18px rgba(0,0,0,.25);background:" + (ok ? "#16a34a" : "#dc2626");
      document.body.appendChild(el);
    } catch (e) {}
  }
  // 账号标识探测（用于「登录的是不是目标账号」校验）：候选接口逐个试，取第一个带 id/email 的
  async function meInfo() {
    var paths = ["/api/v1/me", "/api/v2/me", "/api/v1/user/info", "/api/v1/userinfo", "/api/v2/user/info"];
    for (var i = 0; i < paths.length; i++) {
      try {
        var r = await fetch(paths[i], {
          headers: {
            accept: "application/json, text/plain, */*",
            "x-csrf-token": "_echo_csrf_using_sec_fetch_site_",
            "x-requested-with": "XMLHttpRequest"
          },
          credentials: "include"
        });
        if (!r.ok) continue;
        var j = await r.json();
        var d = j && (j.data || j.user_info || j.userInfo || j.user || j);
        if (!d || typeof d !== "object") continue;
        var uid = d.id || d.uid || d.userId || d.user_id || "";
        var email = d.email || "";
        var name = d.nickname || d.name || d.displayName || "";
        if (uid || email) return { uid: String(uid), email: String(email), name: String(name) };
      } catch (e) {}
    }
    return null;
  }
  var timer = setInterval(run, 4000);
  // 立即执行一次：静默采集用隐藏窗口，Chromium 会把定时器节流到分钟级，
  // 首轮必须即时拉取（cookie 已注入，无需等 timer）
  run();
  async function run() {
    if (done) return;
    tries++;
    try {
      var res = await collect();
      if (res.error) {
        if ((res.error === 401 || res.error === 403) && tries === 1) {
          toast("请先在本窗口登录 Qoder，登录后自动获取（无需其他操作）", false);
        }
        return;
      }
      if (!res.records || !res.records.length) return;
      done = true;
      clearInterval(timer);
      var me = null;
      try { me = await meInfo(); } catch (e) {}
      var body = JSON.stringify({ records: res.records, me: me, grabbed_at_ms: Date.now(), href: location.href });
      try {
        await fetch(ENDPOINT, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: body });
      } catch (e) {}
      toast("已获取官网用量（" + res.records.length + " 条），窗口即将关闭", true);
    } catch (e) {}
  }
})();
"##;

fn rand_token() -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(std::process::id().to_le_bytes());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    h.update(nanos.to_le_bytes());
    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    hex[..24].to_string()
}

/// 读一个最小 HTTP 请求（请求行 + 头 + Content-Length 指定的 body）。
/// 返回 (请求行, body)；非法/超限返回 None。
fn read_http_request(stream: &mut std::net::TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut tmp = [0u8; 4096];
    loop {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    }
    let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let request_line = head.lines().next().unwrap_or("").to_string();
    let content_length = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| v.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return None;
    }
    let mut body = buf[head_end..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    Some((request_line, body))
}

fn num_of(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    v.as_f64().or_else(|| v.as_str()?.trim().parse::<f64>().ok())
}

/// begin_at → 本地毫秒（兼容 epoch 秒/毫秒、RFC3339、本地时间串、纯日期）
fn begin_ms(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    if let Some(n) = v.as_f64() {
        if !n.is_finite() {
            return None;
        }
        return Some(if n.abs() < 10_000_000_000.0 { (n * 1000.0) as i64 } else { n as i64 });
    }
    let s = v.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(nd) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return chrono::Local
                .from_local_datetime(&nd)
                .single()
                .map(|d| d.timestamp_millis());
        }
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d
            .and_hms_opt(0, 0, 0)
            .and_then(|x| chrono::Local.from_local_datetime(&x).single())
            .map(|d| d.timestamp_millis());
    }
    None
}

/// 采集记录 → 看板口径聚合（近 31 天零填充）。
/// 口径 = **实际扣费** `credits`（免费模型上游下发 0，不得按原价虚增）；
/// `credits` 缺失时回退 `original_credits` 名义值；`original_credits` 仅在
/// 会话明细里展示原价/折扣，不参与消耗统计。
fn aggregate(records: &[Value]) -> Value {
    use chrono::Datelike;
    let today = chrono::Local::now().date_naive();
    let mut daily: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    let mut daily_models: std::collections::HashMap<
        String,
        std::collections::HashMap<String, (u64, f64)>,
    > = std::collections::HashMap::new();
    let mut model_totals: std::collections::HashMap<String, (u64, f64)> =
        std::collections::HashMap::new();
    let mut billed_total = 0.0f64;
    let mut used = 0usize;

    for r in records {
        let Some(ms) = begin_ms(r.get("t")) else { continue };
        // 消耗口径：实际扣费 credits（免费模型为 0），缺失回退原价 oc
        let Some(credit) = num_of(r.get("c")).or_else(|| num_of(r.get("oc"))) else {
            continue;
        };
        let Some(day) = chrono::Local
            .timestamp_millis_opt(ms)
            .single()
            .map(|d| d.format("%Y-%m-%d").to_string())
        else {
            continue;
        };
        used += 1;
        billed_total += credit;
        *daily.entry(day.clone()).or_insert(0.0) += credit;
        let model = r
            .get("m")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .unwrap_or("未知模型")
            .to_string();
        let dm = daily_models.entry(day).or_default();
        let e = dm.entry(model.clone()).or_insert((0, 0.0));
        e.0 += 1;
        e.1 += credit;
        let mt = model_totals.entry(model).or_insert((0, 0.0));
        mt.0 += 1;
        mt.1 += credit;
    }

    let mut usage_today = 0.0f64;
    let mut daily_out: Vec<Value> = Vec::new();
    for i in (0..=30).rev() {
        let d = today - chrono::Duration::days(i);
        let key = d.format("%Y-%m-%d").to_string();
        let u = daily.get(&key).copied().unwrap_or(0.0);
        if i == 0 {
            usage_today = u;
        }
        let mut day_models: Vec<Value> = daily_models
            .get(&key)
            .map(|m| {
                m.iter()
                    .map(|(model, (cnt, oc))| {
                        json!({ "model": model, "request_count": cnt, "credit": oc })
                    })
                    .collect()
            })
            .unwrap_or_default();
        day_models.sort_by(|a, b| {
            let ca = a.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
            let cb = b.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
            cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal)
        });
        daily_out.push(json!({ "date": key, "usage": u, "models": day_models }));
    }
    let usage_7days: f64 = daily_out
        .iter()
        .rev()
        .take(7)
        .filter_map(|d| d.get("usage").and_then(Value::as_f64))
        .sum();
    let usage_this_month: f64 = daily
        .iter()
        .filter_map(|(date, u)| {
            chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .ok()
                .filter(|d| d.year() == today.year() && d.month() == today.month())
                .map(|_| *u)
        })
        .sum();
    let mut models_out: Vec<Value> = model_totals
        .into_iter()
        .map(|(model, (cnt, oc))| {
            json!({ "model": model, "request_count": cnt, "credit": oc })
        })
        .collect();
    models_out.sort_by(|a, b| {
        let ca = a.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
        let cb = b.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
        cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal)
    });

    json!({
        "status": "complete",
        "source": "official_web",
        "fetched_at_ms": chrono::Utc::now().timestamp_millis(),
        "range_start": (today - chrono::Duration::days(30)).format("%Y-%m-%d").to_string(),
        "range_end": today.format("%Y-%m-%d").to_string(),
        "records_total": used,
        "billed_total": (billed_total * 100.0).round() / 100.0,
        "summary": {
            "usage_today": usage_today,
            "usage_7days": usage_7days,
            "usage_this_month": usage_this_month,
        },
        "daily": daily_out,
        "models": models_out,
    })
}

// ── 多账号存储（accounts 桶 + 全池汇总）──────────────────────────────────

/// 未指定账号时的默认桶（兼容旧调用）
const DEFAULT_ACCOUNT: &str = "default";

fn store_lock() -> &'static std::sync::Mutex<()> {
    static L: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(|| std::sync::Mutex::new(()))
}

/// 读取账号桶存储；兼容旧格式（单账号 payload 直接落顶层）→ 迁移到 default 桶
fn load_store(data_dir: &std::path::Path) -> Value {
    let v: Value = crate::store::db(data_dir).kv_get(CACHE_KEY);
    if v.get("accounts").map(Value::is_object).unwrap_or(false) {
        return v;
    }
    if v.get("status").is_some() {
        let fetched = v.get("fetched_at_ms").cloned().unwrap_or(json!(0));
        return json!({
            "accounts": { DEFAULT_ACCOUNT: v },
            "updated_at_ms": fetched,
        });
    }
    json!({ "accounts": {}, "updated_at_ms": 0 })
}

/// 写入单账号桶（读-改-写持锁：重试/多窗口不会互相覆盖其他账号）。
/// 写入真实账号时顺手清理旧单账号 `default` 桶（否则同一批数据会在
/// 「未绑定账号」与真实账号下各展示一份）。
fn upsert_account(data_dir: &std::path::Path, account_id: &str, payload: &Value) {
    let _guard = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store(data_dir);
    if !store.get("accounts").map(Value::is_object).unwrap_or(false) {
        store["accounts"] = json!({});
    }
    if account_id != DEFAULT_ACCOUNT {
        if let Some(map) = store.get_mut("accounts").and_then(Value::as_object_mut) {
            map.remove(DEFAULT_ACCOUNT);
        }
    }
    store["accounts"][account_id] = payload.clone();
    store["updated_at_ms"] = json!(chrono::Utc::now().timestamp_millis());
    let _ = crate::store::db(data_dir).kv_set(CACHE_KEY, &store);
}

/// 账号桶 → 看板视图：顶层为「已采集账号」的全池汇总（31 天零填充），
/// `accounts[]` 保留逐账号摘要供前端按账号筛选/展示采集状态。
fn aggregate_store(store: &Value) -> Value {
    use chrono::Datelike;
    let today = chrono::Local::now().date_naive();
    let mut accounts_out: Vec<Value> = Vec::new();
    let mut by_date: std::collections::BTreeMap<
        String,
        (f64, std::collections::HashMap<String, (u64, f64)>),
    > = std::collections::BTreeMap::new();
    let mut records_total = 0u64;
    let mut billed_total = 0.0f64;
    let mut fetched_max = 0i64;
    let mut range_start: Option<String> = None;
    let mut range_end: Option<String> = None;

    for (id, p) in store.get("accounts").and_then(Value::as_object).into_iter().flatten() {
        // 旧单账号桶（迁移自旧格式的 default）：一旦已有按账号归档的桶，就退出汇总——
        // 否则同一批消耗会被 default 与新账号桶重复计入
        if id == DEFAULT_ACCOUNT
            && store
                .get("accounts")
                .and_then(Value::as_object)
                .map(|m| m.keys().any(|k| k != DEFAULT_ACCOUNT))
                .unwrap_or(false)
        {
            continue;
        }
        records_total += p.get("records_total").and_then(Value::as_u64).unwrap_or(0);
        billed_total += p.get("billed_total").and_then(Value::as_f64).unwrap_or(0.0);
        fetched_max = fetched_max.max(p.get("fetched_at_ms").and_then(Value::as_i64).unwrap_or(0));
        if let Some(s) = p.get("range_start").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            range_start = Some(range_start.map_or(s.to_string(), |cur| cur.min(s.to_string())));
        }
        if let Some(e) = p.get("range_end").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            range_end = Some(range_end.map_or(e.to_string(), |cur| cur.max(e.to_string())));
        }
        for d in p.get("daily").and_then(Value::as_array).into_iter().flatten() {
            let Some(date) = d.get("date").and_then(Value::as_str) else { continue };
            let usage = d.get("usage").and_then(Value::as_f64).unwrap_or(0.0);
            let entry = by_date
                .entry(date.to_string())
                .or_insert_with(|| (0.0, std::collections::HashMap::new()));
            entry.0 += usage;
            for m in d.get("models").and_then(Value::as_array).into_iter().flatten() {
                let Some(model) = m.get("model").and_then(Value::as_str) else { continue };
                let cnt = m.get("request_count").and_then(Value::as_u64).unwrap_or(0);
                let credit = m.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
                let e = entry.1.entry(model.to_string()).or_insert((0, 0.0));
                e.0 += cnt;
                e.1 += credit;
            }
        }
        accounts_out.push(json!({
            "account_id": id,
            "account_name": p.get("account_name").cloned().unwrap_or(json!("")),
            "account_hint": p.get("account_hint").cloned().unwrap_or(Value::Null),
            "verified": p.get("verified").cloned().unwrap_or(json!(false)),
            "fetched_at_ms": p.get("fetched_at_ms").cloned().unwrap_or(json!(0)),
            "range_start": p.get("range_start").cloned().unwrap_or(json!("")),
            "range_end": p.get("range_end").cloned().unwrap_or(json!("")),
            "records_total": p.get("records_total").cloned().unwrap_or(json!(0)),
            "billed_total": p.get("billed_total").cloned().unwrap_or(json!(0.0)),
            "summary": p.get("summary").cloned().unwrap_or(Value::Null),
            // 逐账号 daily/models：前端按账号筛选时重算汇总（未筛选时用顶层全池汇总）
            "daily": p.get("daily").cloned().unwrap_or(json!([])),
            "models": p.get("models").cloned().unwrap_or(json!([])),
        }));
    }
    accounts_out.sort_by(|a, b| {
        let fa = a.get("fetched_at_ms").and_then(Value::as_i64).unwrap_or(0);
        let fb = b.get("fetched_at_ms").and_then(Value::as_i64).unwrap_or(0);
        fb.cmp(&fa)
    });

    // 31 天零填充汇总 daily（各账号同日相加；模型同名合并）
    let mut daily_out: Vec<Value> = Vec::new();
    for i in (0..=30).rev() {
        let d = today - chrono::Duration::days(i);
        let key = d.format("%Y-%m-%d").to_string();
        let (usage, models_map) = by_date
            .get(&key)
            .cloned()
            .unwrap_or_else(|| (0.0, std::collections::HashMap::new()));
        let mut models_out: Vec<Value> = models_map
            .into_iter()
            .map(|(model, (cnt, credit))| {
                json!({ "model": model, "request_count": cnt, "credit": credit })
            })
            .collect();
        models_out.sort_by(|a, b| {
            let ca = a.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
            let cb = b.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
            cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal)
        });
        daily_out.push(json!({ "date": key, "usage": usage, "models": models_out }));
    }
    let usage_today = daily_out
        .last()
        .and_then(|d| d.get("usage").and_then(Value::as_f64))
        .unwrap_or(0.0);
    let usage_7days: f64 = daily_out
        .iter()
        .rev()
        .take(7)
        .filter_map(|d| d.get("usage").and_then(Value::as_f64))
        .sum();
    let usage_this_month: f64 = daily_out
        .iter()
        .filter_map(|d| {
            let date = d.get("date").and_then(Value::as_str)?;
            let nd = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
            (nd.year() == today.year() && nd.month() == today.month())
                .then(|| d.get("usage").and_then(Value::as_f64).unwrap_or(0.0))
        })
        .sum();
    let mut model_totals: std::collections::HashMap<String, (u64, f64)> =
        std::collections::HashMap::new();
    for d in &daily_out {
        for m in d.get("models").and_then(Value::as_array).into_iter().flatten() {
            let Some(model) = m.get("model").and_then(Value::as_str) else { continue };
            let e = model_totals.entry(model.to_string()).or_insert((0, 0.0));
            e.0 += m.get("request_count").and_then(Value::as_u64).unwrap_or(0);
            e.1 += m.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
        }
    }
    let mut models_out: Vec<Value> = model_totals
        .into_iter()
        .map(|(model, (cnt, credit))| json!({ "model": model, "request_count": cnt, "credit": credit }))
        .collect();
    models_out.sort_by(|a, b| {
        let ca = a.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
        let cb = b.get("credit").and_then(Value::as_f64).unwrap_or(0.0);
        cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal)
    });

    json!({
        "status": "complete",
        "source": "official_web",
        "fetched_at_ms": fetched_max,
        "updated_at_ms": store.get("updated_at_ms").cloned().unwrap_or(json!(0)),
        "range_start": range_start.unwrap_or_default(),
        "range_end": range_end.unwrap_or_default(),
        "records_total": records_total,
        "billed_total": (billed_total * 100.0).round() / 100.0,
        "summary": {
            "usage_today": usage_today,
            "usage_7days": usage_7days,
            "usage_this_month": usage_this_month,
        },
        "daily": daily_out,
        "models": models_out,
        "accounts_total": accounts_out.len(),
        "accounts": accounts_out,
    })
}

/// 启动官网采集：开回环监听 → 创建**按账号隔离数据目录**的 Webview →
/// 页面登录后同源 fetch 回传，结果写入 `accounts[account_id]` 桶。
/// `account_id` = Qoder 池账号 id（qd-xxx）；缺省 / 不在池内则拒绝（防跨账号写错桶）。
/// 成功/失败均 emit `qoder-web-collect-done`（`{ok, account_id, records_total?, message?}`）。
#[tauri::command(async)]
pub fn qoder_web_collect_start(
    app: AppHandle,
    state: State<AppState>,
    account_id: Option<String>,
    silent: Option<bool>,
) -> Result<(), String> {
    if COLLECT_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("官网采集窗口已在运行，请先完成或关闭该窗口".into());
    }
    COLLECT_CANCEL.store(false, Ordering::SeqCst);
    let silent = silent.unwrap_or(false);
    // 账号标识：仅允许字母数字与 -_（同时用作 Webview 数据目录名，防路径穿越）
    let account_id = account_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_ACCOUNT.to_string());
    if !account_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        COLLECT_RUNNING.store(false, Ordering::SeqCst);
        return Err("账号标识非法（仅允许字母数字与 -_）".into());
    }
    // 目标账号信息（池内）：展示名 + 登录身份校验基准 uid
    let (acct_name, expect_uid) = {
        let pool = crate::store::docs::qoder_pool_load(&crate::store::db(&state.data_dir));
        let hit = pool
            .get("accounts")
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|a| a.get("id").and_then(Value::as_str) == Some(account_id.as_str()))
                    .cloned()
            });
        match hit {
            Some(a) => (
                a.get("nickname")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| account_id.clone()),
                a.get("uid").and_then(Value::as_str).unwrap_or("").to_string(),
            ),
            None if account_id == DEFAULT_ACCOUNT => ("未绑定账号".to_string(), String::new()),
            None => {
                COLLECT_RUNNING.store(false, Ordering::SeqCst);
                return Err("账号不在 Qoder 池内，请刷新账号列表后重试".into());
            }
        }
    };
    // 已存登录态（上次采集导出的 cookie）：有则先注入，页面直接处于登录态
    let saved_cookies = super::web_cookies::load(&state.data_dir, &account_id);
    let has_saved = saved_cookies.as_ref().is_some_and(|c| !c.is_empty());
    // 残留窗口（上次异常退出）先关掉，避免 label 冲突
    if let Some(w) = app.get_webview_window(COLLECT_LABEL) {
        let _ = w.close();
        std::thread::sleep(Duration::from_millis(120));
    }

    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            COLLECT_RUNNING.store(false, Ordering::SeqCst);
            return Err(format!("本地回传端口创建失败: {e}"));
        }
    };
    let _ = listener.set_nonblocking(true);
    let port = listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| format!("端口读取失败: {e}"))?;
    let token = rand_token();

    let script = SCRIPT_TEMPLATE
        .replace("__PORT__", &port.to_string())
        .replace("__TOKEN__", &token);

    // 每账号独立 Webview 数据目录：登录态互不影响，多账号可分别登录采集
    let data_root = state
        .data_dir
        .join("qoder_web")
        .join("accounts")
        .join(&account_id);
    if let Err(e) = std::fs::create_dir_all(&data_root) {
        COLLECT_RUNNING.store(false, Ordering::SeqCst);
        return Err(format!("采集窗口数据目录创建失败: {e}"));
    }
    // 有已存登录态时先开空白页（先注入 cookie 再导航，首请求即带登录态）
    let target = if has_saved { "about:blank" } else { USAGE_PAGE };
    let url: tauri::Url = match target.parse() {
        Ok(u) => u,
        Err(e) => {
            COLLECT_RUNNING.store(false, Ordering::SeqCst);
            return Err(format!("采集页地址无效: {e}"));
        }
    };
    if let Err(e) = WebviewWindowBuilder::new(&app, COLLECT_LABEL, WebviewUrl::External(url))
        .title(format!("Qoder 官网采集 · {acct_name}"))
        .inner_size(1120.0, 820.0)
        .visible(!silent)
        .data_directory(data_root)
        .initialization_script(&script)
        .build()
    {
        COLLECT_RUNNING.store(false, Ordering::SeqCst);
        return Err(format!("采集窗口创建失败: {e}"));
    }
    // 注入已存 cookie → 导航到官网页面
    if has_saved {
        if let Some(cookies) = saved_cookies.as_ref() {
            let mut injected = 0usize;
            for _ in 0..3 {
                if let Some(w) = app.get_webview_window(COLLECT_LABEL) {
                    match super::web_cookies::inject(&w, cookies) {
                        Ok(n) if n > 0 => {
                            injected = n;
                            break;
                        }
                        _ => std::thread::sleep(Duration::from_millis(150)),
                    }
                } else {
                    break;
                }
            }
            fs_utils::app_log(
                &state.data_dir,
                &format!("qoder: 官网采集已注入登录态 {injected} 条（账号 {acct_name}）"),
            );
        }
        if let Some(w) = app.get_webview_window(COLLECT_LABEL) {
            let _ = w.eval("location.replace('https://qoder.com.cn/account/usage')");
        }
    }
    // 用户关闭窗口 → 取消等待（接收线程自行收尾，不阻塞后续重试）
    if let Some(w) = app.get_webview_window(COLLECT_LABEL) {
        w.on_window_event(|ev| {
            if matches!(ev, tauri::WindowEvent::Destroyed) {
                COLLECT_CANCEL.store(true, Ordering::SeqCst);
            }
        });
    }

    let app2 = app.clone();
    let data_dir = state.data_dir.clone();
    std::thread::spawn(move || {
        // 静默采集（已注入登录态）只需要几十秒；可见采集（用户登录）给足 240s
        let budget = if silent {
            Duration::from_secs(90)
        } else {
            COLLECT_TIMEOUT
        };
        let deadline = Instant::now() + budget;
        let mut payload: Option<Value> = None;
        let mut saw_bad_token = false;
        while Instant::now() < deadline && !COLLECT_CANCEL.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    if let Some((line, body)) = read_http_request(&mut stream) {
                        let _ = stream.write_all(
                            b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
                        );
                        let _ = stream.flush();
                        if !line.contains(&format!("token={token}")) {
                            // token 不符：丢弃且不落日志内容（防本机其他进程探测）
                            saw_bad_token = true;
                            continue;
                        }
                        if let Ok(v) = serde_json::from_slice::<Value>(&body) {
                            payload = Some(v);
                            break;
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(120));
                }
                Err(_) => break,
            }
        }

        let result: Result<Value, String> = match payload {
            Some(v) => {
                let records = v
                    .get("records")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if records.is_empty() {
                    Err("采集到 0 条记录（近 31 天无用量或尚未登录）".to_string())
                } else {
                    let me = v.get("me").cloned().unwrap_or(Value::Null);
                    let me_uid = me.get("uid").and_then(Value::as_str).unwrap_or("").to_string();
                    if !expect_uid.is_empty() && !me_uid.is_empty() && me_uid != expect_uid {
                        let hint = me.get("email").and_then(Value::as_str).unwrap_or("");
                        Err(format!(
                            "当前登录的不是账号「{acct_name}」（登录 uid {me_uid}{} 与池内不一致），\
                             已放弃本次采集；请在该窗口退出登录后重新登录目标账号",
                            if hint.is_empty() {
                                String::new()
                            } else {
                                format!(" / {hint}")
                            }
                        ))
                    } else {
                        let mut out = aggregate(&records);
                        out["account_id"] = json!(account_id);
                        out["account_name"] = json!(acct_name);
                        out["account_hint"] = if me.is_null() {
                            Value::Null
                        } else {
                            json!({
                                "uid": me.get("uid").cloned().unwrap_or(json!("")),
                                "email": me.get("email").cloned().unwrap_or(json!("")),
                                "name": me.get("name").cloned().unwrap_or(json!("")),
                            })
                        };
                        // verified = 页面能给出 uid 且与池内一致；无法判定时 fail-open（保留结果但标未校验）
                        out["verified"] = json!(!expect_uid.is_empty() && !me_uid.is_empty());
                        upsert_account(&data_dir, &account_id, &out);
                        // 行级会话明细另桶落盘（SessionsTab Qoder 页优先数据源）
                        let sessions = session_rows_of(&records);
                        upsert_account_sessions(&data_dir, &account_id, &acct_name, &sessions);
                        fs_utils::app_log(
                            &data_dir,
                            &format!(
                                "qoder: 官网用量采集成功（账号 {}，{} 条，近 31 天，verified={}）",
                                acct_name,
                                records.len(),
                                !expect_uid.is_empty() && !me_uid.is_empty()
                            ),
                        );
                        Ok(out)
                    }
                }
            }
            None => {
                if saw_bad_token {
                    fs_utils::app_log(&data_dir, "qoder: 官网采集回传 token 校验失败（已丢弃）");
                }
                let hint = if silent {
                    "登录态已过期或官网未取到数据，请手动点「官网采集」重新登录"
                } else {
                    "未完成采集（窗口已关闭或 240s 内未登录/未取到数据）"
                };
                Err(hint.to_string())
            }
        };

        // 采集成功：导出 cookie 并加密落盘（下次静默刷新免登录）
        if result.is_ok() {
            if let Some(w) = app2.get_webview_window(COLLECT_LABEL) {
                match super::web_cookies::export(&w, "https://qoder.com.cn") {
                    Ok(cookies) if !cookies.is_empty() => {
                        if let Err(e) = super::web_cookies::save(&data_dir, &account_id, &cookies) {
                            fs_utils::app_log(&data_dir, &format!("qoder: 官网登录态保存失败: {e}"));
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        fs_utils::app_log(&data_dir, &format!("qoder: 官网登录态导出失败: {e}"))
                    }
                }
            }
        }

        if let Some(w) = app2.get_webview_window(COLLECT_LABEL) {
            let _ = w.close();
        }
        let ev = match &result {
            Ok(p) => json!({
                "ok": true,
                "silent": silent,
                "account_id": p.get("account_id"),
                "account_name": p.get("account_name"),
                "records_total": p.get("records_total"),
                "summary": p.get("summary"),
            }),
            Err(e) => json!({
                "ok": false,
                "silent": silent,
                "account_id": account_id,
                "account_name": acct_name,
                "message": e,
            }),
        };
        crate::events::emit_logged(&app2, "qoder-web-collect-done", ev, Some(&data_dir));
        COLLECT_RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

/// 全量官网采集视图（已采集账号汇总 + 逐账号明细；未采集过返回 null）
#[tauri::command]
pub fn qoder_web_usage_get(state: State<AppState>) -> Result<Value, String> {
    let store = load_store(&state.data_dir);
    let has_any = store
        .get("accounts")
        .and_then(Value::as_object)
        .map(|m| !m.is_empty())
        .unwrap_or(false);
    Ok(if has_any { aggregate_store(&store) } else { Value::Null })
}

// ── 会话明细（官网逐请求行级缓存；SessionsTab Qoder 页优先数据源）──────────

/// 行级会话缓存 kv（与用量桶分开：查询只读小对象，避免每次聚合拖大 JSON）
pub(crate) const SESSIONS_KEY: &str = "qoder_web_sessions_cache";
/// 单账号行级明细上限（按 ts 保留最新；31 天窗口极端量也可控）
const MAX_SESSION_ROWS: usize = 5000;

/// ts（秒）→ 本地自然日 YYYY-MM-DD（与 SessionsTab 区间比较同口径）
fn local_date_of(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// 采集记录 → 行级会话行（ts 秒 / request_id / model / credits / preview），按 ts 降序截断
fn session_rows_of(records: &[Value]) -> Vec<Value> {
    let mut rows: Vec<Value> = records
        .iter()
        .filter_map(|r| {
            let ts = begin_ms(r.get("t"))? / 1000;
            if ts <= 0 {
                return None;
            }
            // 扣费优先 credits（实际扣），缺失回退 original_credits（名义消耗）
            let credits = num_of(r.get("c")).or_else(|| num_of(r.get("oc")))?;
            let model = r
                .get("m")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("未知模型");
            let id = r.get("id").and_then(Value::as_str).unwrap_or("");
            let preview: String = r
                .get("p")
                .and_then(Value::as_str)
                .unwrap_or("")
                .chars()
                .take(200)
                .collect();
            Some(json!({
                "ts": ts,
                "id": id,
                "model": model,
                "credits": credits,
                "preview": preview,
                // 官网专有字段（会话明细展示原价/折扣/费用/类型）
                "original_credits": num_of(r.get("oc")),
                "cost": num_of(r.get("cm")),
                "original_cost": num_of(r.get("ocm")),
                "discount_factor": num_of(r.get("d")),
                "source": r.get("src").and_then(Value::as_str).unwrap_or(""),
                "session_id": r.get("sid").and_then(Value::as_str).unwrap_or(""),
                "business_id": r.get("bid").and_then(Value::as_str).unwrap_or(""),
            }))
        })
        .collect();
    rows.sort_by(|a, b| {
        let ta = a.get("ts").and_then(Value::as_i64).unwrap_or(0);
        let tb = b.get("ts").and_then(Value::as_i64).unwrap_or(0);
        tb.cmp(&ta)
    });
    rows.truncate(MAX_SESSION_ROWS);
    rows
}

/// 写入单账号行级会话（与用量桶同锁，避免并发覆盖）
fn upsert_account_sessions(
    data_dir: &std::path::Path,
    account_id: &str,
    name: &str,
    rows: &[Value],
) {
    let _guard = store_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut store: Value = crate::store::db(data_dir).kv_get(SESSIONS_KEY);
    if !store.get("accounts").map(Value::is_object).unwrap_or(false) {
        store = json!({ "accounts": {} });
    }
    // 同用量桶：写入真实账号时清理旧单账号 default 桶（防「未绑定账号」重复行）
    if account_id != DEFAULT_ACCOUNT {
        if let Some(map) = store.get_mut("accounts").and_then(Value::as_object_mut) {
            map.remove(DEFAULT_ACCOUNT);
        }
    }
    let now = chrono::Utc::now().timestamp_millis();
    store["accounts"][account_id] = json!({
        "name": name,
        "fetched_at_ms": now,
        "rows": rows,
    });
    store["updated_at_ms"] = json!(now);
    let _ = crate::store::db(data_dir).kv_set(SESSIONS_KEY, &store);
}

/// 官网行级明细 → `UsageSessionsResult`。
/// **None = 从未采集过**（调用方回退网关流水）；Some（即使空）表示官网源可用，
/// 以免「官网无记录」时被网关流水冒充成同一口径。
pub(crate) fn build_web_sessions_result(
    store: &Value,
    start: &str,
    end: &str,
    model_filter: Option<&str>,
    uid_filter: Option<&str>,
    page: u32,
    page_size: u32,
) -> Option<UsageSessionsResult> {
    let accounts = store.get("accounts").and_then(Value::as_object)?;
    if accounts.is_empty() {
        return None;
    }
    // 防重复：已有按账号归档的桶时，旧单账号 default 桶不参与查询
    let has_real = accounts.keys().any(|k| k != DEFAULT_ACCOUNT);
    let mut rows: Vec<UsageSessionView> = Vec::new();
    let mut models: std::collections::BTreeSet<String> = Default::default();
    let mut fetched_max = 0i64;
    for (acct_id, bucket) in accounts {
        if acct_id == DEFAULT_ACCOUNT && has_real {
            continue;
        }
        // uid 过滤先行（models 清单不收录被过滤账号用过的模型）
        if uid_filter.is_some_and(|f| acct_id != f) {
            continue;
        }
        let name = bucket.get("name").and_then(Value::as_str).unwrap_or("");
        fetched_max = fetched_max.max(
            bucket
                .get("fetched_at_ms")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        );
        for r in bucket.get("rows").and_then(Value::as_array).into_iter().flatten() {
            let ts = r.get("ts").and_then(Value::as_i64).unwrap_or(0);
            if ts <= 0 {
                continue;
            }
            let date = local_date_of(ts);
            if date.as_str() < start || date.as_str() > end {
                continue;
            }
            let model = r
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("未知模型")
                .to_string();
            models.insert(model.clone());
            if model_filter.is_some_and(|m| model != m) {
                continue;
            }
            rows.push(UsageSessionView {
                user_id: acct_id.clone(),
                account_name: name.to_string(),
                session_id: r.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                ts,
                date,
                model,
                // 类型/来源（kind/operation/source 组合）复用 mode 徽标展示
                mode: r.get("source").and_then(Value::as_str).unwrap_or("").to_string(),
                credits: r.get("credits").and_then(Value::as_f64).unwrap_or(0.0),
                cost_money: r.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                preview: r.get("preview").and_then(Value::as_str).unwrap_or("").to_string(),
                record_id: r
                    .get("business_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                original_credits: r.get("original_credits").and_then(Value::as_f64),
                original_cost: r.get("original_cost").and_then(Value::as_f64),
                discount_factor: r.get("discount_factor").and_then(Value::as_f64),
                source: r
                    .get("source")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string()),
            });
        }
    }
    rows.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| b.session_id.cmp(&a.session_id)));
    let total = rows.len() as u64;
    let credits_total = rows.iter().map(|r| r.credits).sum();
    let total_pages = total.div_ceil(page_size as u64).max(1) as u32;
    let page = page.min(total_pages);
    let begin = ((page as u64 - 1).saturating_mul(page_size as u64)) as usize;
    let rows: Vec<UsageSessionView> = rows
        .into_iter()
        .skip(begin)
        .take(page_size as usize)
        .collect();
    Some(UsageSessionsResult {
        fetched_at: fetched_max / 1000,
        total,
        credits_total,
        page,
        page_size,
        rows,
        models: models.into_iter().collect(),
    })
}

/// 读 kv 并构建会话查询结果（None = 未采集过）
pub(crate) fn web_sessions_query(
    state: &AppState,
    start: &str,
    end: &str,
    model: Option<&str>,
    uid: Option<&str>,
    page: u32,
    page_size: u32,
) -> Option<UsageSessionsResult> {
    let store: Value = crate::store::db(&state.data_dir).kv_get(SESSIONS_KEY);
    build_web_sessions_result(&store, start, end, model, uid, page, page_size)
}

/// 官网行级明细 → 会话展开行（官网行本身即单条请求；按 request_id ∪ preview 匹配）。
/// None = 未采集/未命中（调用方回退网关流水明细）。
pub(crate) fn build_web_session_detail(
    store: &Value,
    date: &str,
    uid: &str,
    sid: &str,
    preview: &str,
) -> Option<Vec<UsageSessionView>> {
    let bucket = store.get("accounts").and_then(Value::as_object)?.get(uid)?;
    // 旧单账号 default 桶在已有真实账号桶时不再展示（防重复行）
    if uid == DEFAULT_ACCOUNT
        && store
            .get("accounts")
            .and_then(Value::as_object)
            .map(|m| m.keys().any(|k| k != DEFAULT_ACCOUNT))
            .unwrap_or(false)
    {
        return None;
    }
    let name = bucket.get("name").and_then(Value::as_str).unwrap_or("");
    let sid = sid.trim();
    let pv = preview.trim();
    let mut out: Vec<UsageSessionView> = Vec::new();
    for r in bucket.get("rows").and_then(Value::as_array).into_iter().flatten() {
        let ts = r.get("ts").and_then(Value::as_i64).unwrap_or(0);
        if ts <= 0 || local_date_of(ts) != date {
            continue;
        }
        let rid = r.get("id").and_then(Value::as_str).unwrap_or("");
        let p = r.get("preview").and_then(Value::as_str).unwrap_or("");
        let hit = if sid.is_empty() {
            !pv.is_empty() && p == pv
        } else {
            rid == sid || (!pv.is_empty() && p == pv)
        };
        if !hit {
            continue;
        }
        out.push(UsageSessionView {
            user_id: uid.to_string(),
            account_name: name.to_string(),
            session_id: rid.to_string(),
            ts,
            date: date.to_string(),
            model: r
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("未知模型")
                .to_string(),
            mode: r.get("source").and_then(Value::as_str).unwrap_or("").to_string(),
            credits: r.get("credits").and_then(Value::as_f64).unwrap_or(0.0),
            cost_money: r.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            preview: p.to_string(),
            record_id: r
                .get("business_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            original_credits: r.get("original_credits").and_then(Value::as_f64),
            original_cost: r.get("original_cost").and_then(Value::as_f64),
            discount_factor: r.get("discount_factor").and_then(Value::as_f64),
            source: r
                .get("source")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
        });
    }
    (!out.is_empty()).then_some(out)
}

/// 读 kv 并构建会话展开明细（None = 未采集/未命中）
pub(crate) fn web_session_detail_query(
    state: &AppState,
    date: &str,
    uid: &str,
    sid: &str,
    preview: &str,
) -> Option<Vec<UsageSessionView>> {
    let store: Value = crate::store::db(&state.data_dir).kv_get(SESSIONS_KEY);
    build_web_session_detail(&store, date, uid, sid, preview)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_sums_actual_credits_by_local_day() {
        let today = chrono::Local::now().date_naive();
        let at = |d: chrono::NaiveDate, h: u32| -> i64 {
            d.and_hms_opt(h, 0, 0)
                .and_then(|x| chrono::Local.from_local_datetime(&x).single())
                .map(|dt| dt.timestamp_millis())
                .unwrap()
        };
        let records = vec![
            json!({"t": at(today, 9), "oc": 10.5, "c": 3.0, "m": "qwen3-coder"}),
            json!({"t": at(today, 10), "oc": "2", "c": 1.0, "m": "qwen3-coder"}),
            // 免费模型：原价 8 但实际扣 0，消耗统计必须按 0 计
            json!({"t": at(today, 11), "oc": 8.0, "c": 0.0, "m": "free-model"}),
            // 缺 c：回退原价 9
            json!({"t": at(today, 12), "oc": 9.0, "m": "fallback"}),
            json!({"t": at(today - chrono::Duration::days(1), 23), "oc": 5.0, "c": 5.0, "m": "claude"}),
            // 非法行：无 c 也无 oc
            json!({"t": at(today, 13), "m": "x"}),
        ];
        let out = aggregate(&records);
        assert_eq!(out["records_total"], json!(5));
        // 3 + 1 + 0（免费）+ 9（回退）
        assert!((out["summary"]["usage_today"].as_f64().unwrap() - 13.0).abs() < 1e-9);
        assert!((out["summary"]["usage_7days"].as_f64().unwrap() - 18.0).abs() < 1e-9);
        assert_eq!(out["daily"].as_array().unwrap().len(), 31, "近 31 天零填充");
        let models = out["models"].as_array().unwrap();
        let top = &models[0];
        assert_eq!(top["model"], json!("fallback"));
        assert_eq!(top["request_count"], json!(1));
        let free = models.iter().find(|m| m["model"] == json!("free-model"));
        let free = free.expect("免费模型也应在模型列表（消耗 0）");
        assert!(free["credit"].as_f64().unwrap().abs() < 1e-9);
    }

    #[test]
    fn begin_ms_accepts_epoch_and_strings() {
        assert_eq!(begin_ms(Some(&json!(1763510000000i64))), Some(1763510000000));
        assert_eq!(begin_ms(Some(&json!(1763510000i64))), Some(1763510000000));
        assert!(begin_ms(Some(&json!("2026-11-19T10:00:00+08:00"))).is_some());
        assert!(begin_ms(Some(&json!("2026-11-19 10:00:00"))).is_some());
        assert_eq!(begin_ms(Some(&json!("nonsense"))), None);
        assert_eq!(begin_ms(None), None);
    }

    /// 多账号存储：旧单账号格式自动迁移到 default 桶；写入新账号后汇总为全池视图
    #[test]
    fn store_migrates_legacy_and_sums_accounts() {
        let dir = std::env::temp_dir().join(format!("qoder_web_store_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let payload = |usage: f64, records: u64| {
            json!({
                "status": "complete",
                "source": "official_web",
                "account_name": "a",
                "fetched_at_ms": 111,
                "range_start": "2026-11-01",
                "range_end": today,
                "records_total": records,
                "billed_total": 1.0,
                "summary": { "usage_today": usage, "usage_7days": usage, "usage_this_month": usage },
                "daily": [{ "date": today, "usage": usage, "models": [
                    { "model": "m1", "request_count": 1, "credit": usage }
                ]}],
                "verified": true,
            })
        };
        // 旧格式：单账号 payload 直接落顶层
        crate::store::db(&dir)
            .kv_set(CACHE_KEY, &payload(5.0, 1))
            .unwrap();
        let migrated = load_store(&dir);
        assert!(migrated["accounts"][DEFAULT_ACCOUNT]["status"].is_string());
        // 仅有旧桶时照常展示（兼容迁移前的采集结果）
        let only_legacy = aggregate_store(&migrated);
        assert_eq!(only_legacy["accounts_total"], json!(1));
        assert!((only_legacy["summary"]["usage_today"].as_f64().unwrap() - 5.0).abs() < 1e-9);

        // 新账号写入另一个桶：旧桶自动退出汇总（防重复计数）
        upsert_account(&dir, "qd-a", &payload(2.0, 2));
        let after = load_store(&dir);
        assert!(
            after["accounts"].get(DEFAULT_ACCOUNT).is_none(),
            "写入真实账号后旧 default 桶应被清理"
        );
        let view = aggregate_store(&after);
        assert_eq!(view["accounts_total"], json!(1));
        assert_eq!(view["records_total"], json!(2));
        assert!((view["summary"]["usage_today"].as_f64().unwrap() - 2.0).abs() < 1e-9);
        assert_eq!(view["daily"].as_array().unwrap().len(), 31);
        assert_eq!(view["daily"].as_array().unwrap().last().unwrap()["usage"], json!(2.0));
        // 逐账号明细保留 verified 标记
        let accounts = view["accounts"].as_array().unwrap();
        assert!(accounts.iter().all(|a| a["verified"] == json!(true)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 官网行级明细 → 会话查询：区间/uid/model 过滤、分页夹取、models 清单、未采集 → None
    #[test]
    fn web_sessions_result_filters_and_pages() {
        let today = chrono::Local::now().date_naive();
        let at = |h: u32, m: u32| -> i64 {
            today
                .and_hms_opt(h, m, 0)
                .and_then(|x| chrono::Local.from_local_datetime(&x).single())
                .map(|d| d.timestamp())
                .unwrap()
        };
        let store = json!({"accounts": {
            "qd-a": {"name": "A", "fetched_at_ms": 1_700_000_000_000i64, "rows": [
                {"ts": at(10, 0), "id": "r1", "model": "m1", "credits": 1.0, "preview": "p1"},
                {"ts": at(9, 0), "id": "r2", "model": "m2", "credits": 2.0, "preview": "p2"}
            ]},
            "qd-b": {"name": "B", "fetched_at_ms": 1_700_000_100_000i64, "rows": [
                {"ts": at(11, 0), "id": "r3", "model": "m1", "credits": 3.0, "preview": "p3"}
            ]}
        }});
        let day = today.format("%Y-%m-%d").to_string();
        let all = build_web_sessions_result(&store, &day, &day, None, None, 1, 10).unwrap();
        assert_eq!(all.total, 3);
        assert_eq!(all.rows.len(), 3);
        assert_eq!(all.models, vec!["m1".to_string(), "m2".to_string()]);
        assert!((all.credits_total - 6.0).abs() < 1e-9);
        assert_eq!(all.rows[0].session_id, "r3", "ts 倒序");
        // uid 过滤（先进，models 清单只收录该账号模型）
        let a = build_web_sessions_result(&store, &day, &day, None, Some("qd-a"), 1, 10).unwrap();
        assert_eq!(a.total, 2);
        assert_eq!(a.models, vec!["m1".to_string(), "m2".to_string()]);
        // model 过滤不影响 models 清单
        let m = build_web_sessions_result(&store, &day, &day, Some("m2"), None, 1, 10).unwrap();
        assert_eq!(m.total, 1);
        assert_eq!(m.models.len(), 2);
        // 越界页回夹到最后一页
        let p = build_web_sessions_result(&store, &day, &day, None, None, 9, 2).unwrap();
        assert_eq!(p.page, 2);
        assert_eq!(p.rows.len(), 1);
        // 未采集 → None（调用方回退网关流水）
        assert!(build_web_sessions_result(&json!({"accounts": {}}), &day, &day, None, None, 1, 10).is_none());
    }

    /// 会话展开：官网行按 request_id ∪ preview 命中；未命中 → None（回退网关）
    #[test]
    fn web_session_detail_matches_sid_or_preview() {
        let today = chrono::Local::now().date_naive();
        let ts = today
            .and_hms_opt(8, 0, 0)
            .and_then(|x| chrono::Local.from_local_datetime(&x).single())
            .map(|d| d.timestamp())
            .unwrap();
        let store = json!({"accounts": {"qd-a": {"name": "A", "fetched_at_ms": 1, "rows": [
            {"ts": ts, "id": "r1", "model": "m1", "credits": 1.5, "preview": "写测试"}
        ]}}});
        let day = today.format("%Y-%m-%d").to_string();
        let by_sid = build_web_session_detail(&store, &day, "qd-a", "r1", "").unwrap();
        assert_eq!(by_sid.len(), 1);
        assert!((by_sid[0].credits - 1.5).abs() < 1e-9);
        let by_pv = build_web_session_detail(&store, &day, "qd-a", "", "写测试").unwrap();
        assert_eq!(by_pv.len(), 1);
        assert!(build_web_session_detail(&store, &day, "qd-a", "nope", "nope").is_none());
        assert!(build_web_session_detail(&store, &day, "qd-x", "r1", "").is_none());
    }
}
//! WorkBuddy 一键签到（F-15/F-16/F-55）+ 成长中心（T2.5/F-17）+ token 惰性续期（F-09）。
//! 原 src-python/workbuddy_checkin.py 的 Rust 移植，逐函数对齐：
//! - 签到：checkin_status（新路径回退旧路径）→ checkin_do（域名双探测 + 已签容错 + 奖励宽容解析）
//!   → 余额差值兜底（F-17，仅差值>0 采信）→ 401 刷新一次重试（F-09，禁二次刷新）
//! - 成长（活动域，travel/lottery/task-claim 不带 /v2）：
//!   travel（三态：`data.state` 权威口径为主 + 上游 issue #210 的深挖/白名单兜底；
//!   在途等待 / 到站先 claim 再派 / 空闲先领养 Buddy 再 depart，含每日限次）/
//!   lottery（lottery/summary chances → draw 带 client_token 循环上限 20）/
//!   tasks（GET `/v2/activity/growth/tasks` → 批量报名 task_codes →
//!   对 progress 达标者逐个 `POST /activity/growth/tasks/{code}/claim`，不伪造使用行为）
//!   各步独立容错，401 同款刷新重试
//! - NDJSON 事件契约（wb-checkin-progress 管线，前端逐行 JSON.parse）：
//!   start {type,total[,mode]} / account {user_id,name,status,message[,reward]
//!   [,reward_pending,pre_balance,pre_wb_credits][,checkin_streak],index} /
//!   growth {type:"growth",...,checkin_streak,index} / done {type:"done"[,mode],ok,already,failed}
//! - 结果 90 天滚动存储；刷新成功回写账号池过期时间（调度/到期日历数据源）
//! 红线：全程零 token 输出（凭证不入日志/事件）。

use serde_json::{json, Map, Value};

use crate::fs_utils;
use crate::state::AppState;

use super::{http_agent, http_agent_with_proxy};
use super::wb_common::{self, Creds};

/// 盲盒抽取循环上限（防接口异常时死循环；正常 balance 会归零）
const LOTTERY_MAX_DRAWS: usize = 20;

/// 签到间隔抖动（P4 防风控）：在配置 gap 基础上乘 0.5–1.5 的随机系数，
/// 打散固定间隔节奏（无 rand 依赖，纳秒熵源）。gap=0（关闭间隔）不抖动。
fn jittered_gap_secs(gap_secs: u64) -> u64 {
    if gap_secs == 0 {
        return 0;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let jittered = gap_secs * (500 + u64::from(nanos % 1000)) / 1000;
    // 下限钳制（审查修复）：小 gap 整数除法可能得 0（如 gap=1 且 nanos%1000<500），
    // 间隔失效——钳到 max(1, gap/2)，保持抖动区间 [0.5gap, 1.5gap) 的下界语义
    jittered.max(gap_secs / 2).max(1)
}

/// 签到轮次参数（对齐 python --uid/--skip-checked/--skip-expired/--lazy-hours）
#[derive(Clone, Default)]
pub struct CheckinOpts {
    pub uids: Vec<String>,
    /// 对齐 python --skip-checked 形参（python 侧同样声明未消费：
    /// 「今日已签」实际由 checkin_status 预检兜底返回 already）；保留字段维持调用方契约
    #[allow(dead_code)]
    pub skip_checked: bool,
    pub skip_expired: bool,
    pub lazy_hours: i64,
}

impl CheckinOpts {
    /// 每日计划任务默认（--json-stream --skip-checked，lazy 24h）
    pub fn daily() -> Self {
        Self {
            skip_checked: true,
            lazy_hours: 24,
            ..Default::default()
        }
    }
}

/// 成长中心开关（对齐 python --growth-travel/--growth-lottery/--growth-tasks）
#[derive(Clone, Copy, Default)]
pub struct GrowthOpts {
    pub travel: bool,
    pub lottery: bool,
    pub tasks: bool,
}

/// 区域端点表（对齐 python _urls_for；base 不带尾斜杠）
#[derive(Clone)]
struct Urls {
    base: &'static str,
    checkin_status: String,
    checkin_status_old: String,
    checkin_do: String,
    /// 成长中心统一走活动域（CN=www.workbuddy.cn，Global=www.workbuddy.ai）。
    /// 实测：travel/lottery/streak/task-claim **不带 /v2**，只有 tasks 列表/accept 带 /v2。
    web: &'static str,
    travel_status: String,
    travel_claim: String,
    travel_config: String,
    travel_depart: String,
    buddy_info: String,
    buddy_first: String,
    buddy_agreement: String,
    lottery_summary: String,
    lottery_draw: String,
    tasks: String,
    tasks_accept: String,
    /// 任务领奖为路径参数式：`{base}/activity/growth/tasks/{task_code}/claim`（POST，无 body）
    tasks_claim_base: String,
    energy: String,
    streak: String,
}

fn urls_for(base: &'static str) -> Urls {
    let b = base;
    let web = wb_common::region_activity_base(base);
    let wg = format!("{web}/activity/growth");
    Urls {
        base,
        checkin_status: format!("{b}/v2/billing/meter/checkin-activity-status"),
        checkin_status_old: format!("{b}/v2/billing/meter/checkin-status"),
        checkin_do: format!("{b}/v2/billing/meter/daily-checkin"),
        web,
        travel_status: format!("{wg}/buddy/travel/status"),
        travel_claim: format!("{wg}/buddy/travel/claim"),
        travel_config: format!("{wg}/buddy/travel/config"),
        travel_depart: format!("{wg}/buddy/travel/depart"),
        buddy_info: format!("{wg}/buddy/info"),
        buddy_first: format!("{wg}/buddy/first"),
        buddy_agreement: format!("{wg}/buddy/agreement"),
        lottery_summary: format!("{wg}/lottery/summary"),
        lottery_draw: format!("{wg}/lottery/draw"),
        tasks: format!("{web}/v2/activity/growth/tasks"),
        tasks_accept: format!("{web}/v2/activity/growth/tasks/accept"),
        tasks_claim_base: format!("{wg}/tasks"),
        energy: format!("{wg}/energy"),
        streak: format!("{wg}/streak"),
    }
}

impl Urls {
    /// 备用域名端点表（§2.2 域名双探测）：主域名网络不可达时切换重试一次
    fn alt(&self) -> Urls {
        let bases = wb_common::billing_bases("");
        let alt = if bases[0] == self.base { bases[1] } else { bases[0] };
        urls_for(alt)
    }
}

// ── 解析辅助（对齐 python _num_or_none / _scalar_of / bool(v)）─────────────

/// 奖励/余额数值归一：数字或纯数字字符串 → f64，其余 None（不递归，对齐 _num_or_none）
fn num_or_none(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    match v {
        Value::Bool(_) => None,
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// python bool() 语义（0/""/null/false → false，其余 true）
fn py_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map_or(true, |f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(_)) => true,
    }
}

/// 嵌套对象按常用数值键归一（energy/streak 兼容 {current:..} 等对象返回，
/// 修复前端「连签 [object Object] 天」展示）
fn scalar_of(v: &Value) -> Option<f64> {
    if let Some(m) = v.as_object() {
        for k in ["current", "days", "count", "value", "num", "total", "streak", "energy"] {
            if let Some(x) = m.get(k) {
                if !x.is_null() {
                    return scalar_of(x);
                }
            }
        }
        return None;
    }
    num_or_none(Some(v))
}

/// 签到连签天数（issue #180）：checkin-activity-status 响应的 streak_days——
/// 与 growth/streak 的「活跃连签」（使用事件驱动）是两个不同指标
fn streak_days_from(body: &Value) -> Option<f64> {
    num_or_none(fs_utils::dig(body, &["streak_days", "streakDays"]))
}

/// 延迟到账判定（issue #180）：credit_delayed 真值 = 签到积分次日到账（此时
/// data.credit 常为空，不应记「奖励未识别」）
fn delayed_credit_pending(body: &Value) -> bool {
    py_truthy(fs_utils::dig(body, &["credit_delayed", "creditDelayed"]))
}

/// T+1 待入账差值回填（issue #180）：billing meter 优先、WB credits 兜底（与
/// 签到当场差值兜底同序），仅差值 >0 采信（防并发扣减负值误报）
fn backfill_diff(
    pre_billing: Option<f64>,
    post_billing: Option<f64>,
    pre_wb: Option<f64>,
    post_wb: Option<f64>,
) -> Option<f64> {
    let round2 = |d: f64| (d * 100.0).round() / 100.0;
    if let (Some(pre), Some(post)) = (pre_billing, post_billing) {
        if post > pre {
            return Some(round2(post - pre));
        }
    }
    if let (Some(pre), Some(post)) = (pre_wb, post_wb) {
        if post > pre {
            return Some(round2(post - pre));
        }
    }
    None
}

/// 递归深挖奖励数额：键名含奖励语义子串的数值字段（宽容解析，对齐 doubao_quota
/// deep dig 模式）。刻意不含 balance/total/remaining 语义——避免把账户余额误当本次奖励。
fn deep_reward_dig(v: &Value, depth: usize) -> Option<f64> {
    if depth > 8 {
        return None;
    }
    match v {
        Value::Object(m) => {
            for (k, val) in m {
                let kl = k.to_ascii_lowercase();
                let looks_reward = ["reward", "bonus", "earned", "add_integral", "add_credits", "addcredit", "integral_add", "gain", "obtain", "prize"]
                    .iter()
                    .any(|s| kl.contains(s));
                if looks_reward {
                    if let Some(n) = num_or_none(Some(val)) {
                        return Some(n);
                    }
                }
            }
            for val in m.values() {
                if val.is_object() || val.is_array() {
                    if let Some(n) = deep_reward_dig(val, depth + 1) {
                        return Some(n);
                    }
                }
            }
            None
        }
        Value::Array(a) => a.iter().find_map(|x| deep_reward_dig(x, depth + 1)),
        _ => None,
    }
}

/// 递归找余额数值字段：键名含 remain/balance（大小写不敏感，排除 total；不含
/// 裸 capacity——CapacitySize/UsedCapacity 是总量/已用键，当余额即翻倍类错误，
/// 对齐 wb_credits M3「总量不当余额」原则）。
/// 用于 billing summary 结构未知时的余额差值兜底（pre/post 同结构，首命中稳定）。
fn deep_balance_dig(v: &Value, depth: usize) -> Option<f64> {
    if depth > 8 {
        return None;
    }
    match v {
        Value::Object(m) => {
            for (k, val) in m {
                let kl = k.to_ascii_lowercase();
                if (kl.contains("remain") || kl.contains("balance")) && !kl.contains("total") {
                    if let Some(n) = num_or_none(Some(val)) {
                        return Some(n);
                    }
                }
            }
            for val in m.values() {
                if val.is_object() || val.is_array() {
                    if let Some(n) = deep_balance_dig(val, depth + 1) {
                        return Some(n);
                    }
                }
            }
            None
        }
        Value::Array(a) => a.iter().find_map(|x| deep_balance_dig(x, depth + 1)),
        _ => None,
    }
}

/// 奖励数额一律以接口返回为准，不硬编码（F-17 红线）；无奖励回退 raw 摘要
fn reward_text(body: Option<&Value>, raw: &str) -> String {
    let r = body.and_then(|b| fs_utils::dig(b, &["reward", "credits", "points", "amount", "value"]));
    match r {
        Some(v) if !v.is_null() => format!("+{v}"),
        _ => {
            let t: String = raw.chars().take(60).collect();
            if t.is_empty() { "ok".to_string() } else { t }
        }
    }
}

fn s_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").to_string()
}

/// 取首个真值字符串（对齐 python `a or b or c`：空串视为假）
fn first_str(parts: &[Option<String>]) -> String {
    parts
        .iter()
        .flatten()
        .find(|s| !s.is_empty())
        .cloned()
        .unwrap_or_default()
}

// ── 签到端点（对齐 python checkin_status / checkin_do / fetch_balance）─────

/// 查询今日是否已签：新路径回退旧路径；返回 (today_checked_in, streak_days, status_ok)。
/// streak_days（issue #180）：同响应携带的签到连签天数，此前被丢弃导致前端只能
/// 展示 growth/streak 的活跃连签
fn checkin_status(
    agent: &ureq::Agent,
    headers: &[(String, String)],
    urls: &Urls,
) -> (Option<bool>, Option<f64>, bool) {
    for url in [&urls.checkin_status, &urls.checkin_status_old] {
        let (status, body) = wb_common::post_json(agent, url, headers, &json!({}));
        if status == 401 {
            return (None, None, false);
        }
        if status == 200 {
            if let Some(b) = body.filter(|b| b.is_object()) {
                let mut v = fs_utils::dig(&b, &["today_checked_in", "todayCheckedIn", "checked_in", "checkedIn"]);
                if v.is_none() {
                    // 部分响应以 0/1 表达
                    v = fs_utils::dig(&b, &["checked", "is_checked"]);
                }
                if let Some(v) = v {
                    return (Some(py_truthy(Some(v))), streak_days_from(&b), true);
                }
                return (None, streak_days_from(&b), true); // 200 但字段缺失：视为未知但不失败（执行时容错）
            }
        }
        // 其它状态码尝试旧路径
    }
    (None, None, false)
}

/// 签到执行。返回 (kind, message, reward, delayed, checkin_streak, dbg_keys)：
/// success / already / fail（auth 由调用方刷新重试）；delayed = 成功但奖励为空且
/// 带 credit_delayed（积分次日到账，issue #180）；checkin_streak = 签到响应内
/// streak_days（post-checkin 口径，比预检值新——当日首签时预检值少 1）；
/// dbg_keys = 成功但奖励未识别时的响应键路径（仅键名不含值，供 app.log 诊断
/// 校准，见 process_account）
fn checkin_do(
    agent: &ureq::Agent,
    headers: &[(String, String)],
    urls: &Urls,
) -> (String, String, Option<f64>, bool, Option<f64>, Option<String>) {
    let (mut status, mut body, mut raw) =
        wb_common::post_json_raw(agent, &urls.checkin_do, headers, &json!({}));
    if status == 0 {
        // 域名双探测（§2.2）：主域名网络不可达 → 备用域名重试一次
        let alt = urls.alt().checkin_do;
        if alt != urls.checkin_do {
            let r = wb_common::post_json_raw(agent, &alt, headers, &json!({}));
            status = r.0;
            body = r.1;
            raw = r.2;
        }
    }
    if status == 401 {
        return ("auth".into(), "登录态失效（401）".into(), None, false, None, None);
    }
    let code: Option<i64> = body
        .as_ref()
        .and_then(|b| b.get("code"))
        .and_then(Value::as_i64)
        .or_else(|| body.as_ref().and_then(|b| fs_utils::dig(b, &["code"])).and_then(Value::as_i64));
    let message = body
        .as_ref()
        .and_then(|b| fs_utils::dig(b, &["message", "msg"]))
        .map(|v| s_of(Some(v)));
    if status == 0 {
        let head: String = raw.chars().take(120).collect();
        return ("fail".into(), format!("网络不可达: {head}"), None, false, None, None);
    }
    if (200..=201).contains(&status) || code.is_some_and(|c| c == 0 || c == 200) {
        // 奖励数额以接口返回为准，不硬编码（F-17）；精确键未命中走递归深挖，
        // 仍无则兜底走签到前后余额差值（process_account）。
        // issue #180：服务端奖励在 data.credit（单数）——精确键表补 credit（dig
        // 精确等值匹配不会命中 credits_packages 等余额字段；deep_reward_dig 的
        // contains 表刻意不加裸 credit，避免误命中余额类字段）
        let reward = body.as_ref().and_then(|b| {
            num_or_none(fs_utils::dig(
                b,
                &[
                    "reward", "credits", "credit", "points", "amount", "integral", "score",
                    "bonus", "reward_amount", "add_integral", "addCredits", "earned",
                ],
            ))
            .or_else(|| deep_reward_dig(b, 0))
        });
        // issue #180：credit_delayed 真值 = 积分次日到账（常伴随 credit 为空），
        // 标记待入账而非「未识别」（调用方据此区分展示与 T+1 回填）
        let delayed = reward.is_none() && body.as_ref().is_some_and(delayed_credit_pending);
        // 签到连签（post-checkin）：签到响应自带 streak_days，当日首签时比
        // 预检值新 1 天（审查修复：预检值在成功路径会少计当日）
        let checkin_streak = body.as_ref().and_then(|b| streak_days_from(b));
        // 奖励未识别时收集响应键路径（不含值）供诊断校准
        let dbg_keys = if reward.is_none() && !delayed {
            body.as_ref().map(|b| {
                let mut paths = Vec::new();
                collect_key_paths(b, "", 0, &mut paths);
                paths.join(" | ")
            })
        } else {
            None
        };
        return ("success".into(), "签到成功".into(), reward, delayed, checkin_streak, dbg_keys);
    }
    // 已签容错（F-15）：code:10001 / message 含「已签到」/「repeat」
    let msg_low = message.as_deref().unwrap_or("").to_ascii_lowercase();
    if code == Some(10001)
        || ["已签到", "repeat", "already"].iter().any(|k| msg_low.contains(k))
    {
        // already 响应同样可能带 streak_days（post-checkin 口径）
        let checkin_streak = body.as_ref().and_then(|b| streak_days_from(b));
        return ("already".into(), "今日已签到".into(), None, false, checkin_streak, None);
    }
    let head: String = raw.chars().take(120).collect();
    let shown = message
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| if head.is_empty() { format!("HTTP {status}") } else { head });
    (
        "fail".into(),
        format!("{shown}（code={}）", code.map(|c| c.to_string()).unwrap_or_else(|| "None".into())),
        None,
        false,
        None,
        None,
    )
}

/// 收集 JSON 键路径（深度/数量受限；只采集键名不采集值——诊断用，避免敏感信息入日志）
fn collect_key_paths(v: &Value, prefix: &str, depth: usize, out: &mut Vec<String>) {
    if depth > 6 || out.len() >= 40 {
        return;
    }
    match v {
        Value::Object(m) => {
            for (k, val) in m {
                let p = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                out.push(p.clone());
                collect_key_paths(val, &p, depth + 1, out);
            }
        }
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate().take(3) {
                collect_key_paths(x, &format!("{prefix}[{i}]"), depth + 1, out);
            }
        }
        _ => {}
    }
}

/// 查询当前通用积分余额（get-user-resource-summary，与积分页同口径）。
/// 网络失败/解析失败返回 None——仅用于签到获得积分差值兜底，不阻塞签到。
fn fetch_balance(agent: &ureq::Agent, headers: &[(String, String)], base: &str) -> Option<f64> {
    let path = "/billing/meter/get-user-resource-summary";
    let (mut status, mut body) = wb_common::post_json(agent, &format!("{base}{path}"), headers, &json!({}));
    if status == 0 {
        let alt = if base == wb_common::BILLING_BASE_CN {
            wb_common::BILLING_BASE_GLOBAL
        } else {
            wb_common::BILLING_BASE_CN
        };
        if alt != base {
            let r = wb_common::post_json(agent, &format!("{alt}{path}"), headers, &json!({}));
            status = r.0;
            body = r.1;
        }
    }
    if status != 200 {
        return None;
    }
    let b = body?;
    // 与积分页统一解析器（wb_credits::balance_from_summary）：聚合父字段 +
    // Packages[] 明细并存时不翻倍（issue #120），pre/post 与积分页口径一致；
    // deep_balance_dig 保留为最后回退。
    crate::tasks::wb_credits::balance_from_summary(&b).or_else(|| deep_balance_dig(&b, 0))
}

/// WB credits 域余额（WorkBuddy 积分账本）：billing meter 是通用积分账本，
/// 签到奖励入 WB 积分——billing 差值恒 0 时用 credits 差值兜底
fn fetch_wb_credits_balance(state: &AppState, aid: &str) -> Option<f64> {
    let parsed = crate::tasks::wb_credits::fetch_credits(state, Some(aid), true).ok()?;
    parsed
        .get("accounts")?
        .as_array()?
        .iter()
        .find(|a| a.get("user_id").and_then(Value::as_str) == Some(aid))
        .and_then(|a| a.get("balance"))
        .and_then(Value::as_f64)
}

// ── 账号池回写 / 结果存储 ──────────────────────────────────────────────────

/// 刷新成功后回写账号池 token 过期时间（调度/到期日历数据源）
fn sync_pool_expiry(state: &AppState, aid: &str, creds: &Creds) {
    // SQLite 化（P3）：wb_accounts 表
    // 读-改-写互斥：罩住 load→改→save 段，防命令/后台/调度线程旧副本整文档覆盖
    let _guard = state.wb_pool_lock.lock().unwrap_or_else(|e| e.into_inner());
    let mut pool: Value = crate::store::docs::wb_pool_load(&crate::store::db(&state.data_dir));
    let mut changed = false;
    if let Some(accounts) = pool.get_mut("accounts").and_then(Value::as_array_mut) {
        for a in accounts.iter_mut() {
            if a.get("id").and_then(Value::as_str) == Some(aid) {
                if let Some(exp) = creds.expires_at_ms {
                    a["access_token_expires_at"] = json!(exp.div_euclid(1000));
                }
                if let Some(rexp) = creds.refresh_expires_at_ms {
                    a["refresh_token_expires_at"] = json!(rexp.div_euclid(1000));
                }
                a["needs_relogin"] = json!(false);
                a["relogin_reason"] = json!("");
                changed = true;
            }
        }
    }
    if changed {
        let _ = crate::store::docs::wb_pool_save(&crate::store::db(&state.data_dir), &pool);
    }
}

/// wb_checkin_results 文档写互斥（2026-11-20 审查修复，Medium）：append_results /
/// try_backfill_pending 均为整文档 load→改→save 且无锁——GUI 手动签到与 schtasks
/// CLI 轮次并发时后保存方整表覆盖先保存方，本轮签到事件或 T+1 回填结果丢失
/// （pending 标记被覆盖后差值回填永久失效，pre_balance 基准随之丢失）。
/// 对齐 doubao_checkin_results::record_day_at 同款双层锁：进程内 Mutex 串行化 +
/// CrossProcLock 跨进程互斥；跨进程锁 Busy/机制性失败降级进程内锁继续写（尽力
/// 不丢——签到记录为本进程侧产出，跳过即永久丢失，与 doubao skip_on_busy 路径
/// 语义不同；残余竞态窗口由 SQLite 写原子性兜底）。权衡：try_backfill 持锁跨越
/// 余额查询网络往返（秒级），他进程写方最长等待 3s 后降级。
static RESULTS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 签到结果 90 天滚动存储（趋势/日志数据源，F-55/F-22；SQLite 化 P3：wb_checkin_results 表）
fn append_results(state: &AppState, events: &[Value]) {
    let _g = RESULTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cross = match crate::tasks::qoder_common::CrossProcLock::try_acquire_ns(
        &state.data_dir,
        "wb_checkin",
        "append_results",
        3_000,
    ) {
        (Some(g), _) => Some(g),
        (None, Some(fail)) => {
            crate::fs_utils::app_log(
                &state.data_dir,
                &format!(
                    "[wb_checkin] 结果落库跨进程锁未获取（{}），降级进程内锁继续写",
                    fail.describe()
                ),
            );
            None
        }
        (None, None) => None,
    };
    let store = crate::store::db(&state.data_dir);
    let mut data: Value = crate::store::docs::wb_checkin_results_load(&store);
    let results: Vec<Value> = data
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let cutoff = (chrono::Local::now().date_naive() - chrono::Duration::days(90))
        .format("%Y-%m-%d")
        .to_string();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut kept: Vec<Value> = results
        .into_iter()
        .filter(|r| r.get("date").and_then(Value::as_str).unwrap_or("") >= cutoff.as_str())
        .collect();
    for ev in events {
        let mut rec = json!({
            "date": today,
            "time": fs_utils::now_ts(),
            "user_id": ev.get("user_id").cloned().unwrap_or_default(),
            "name": ev.get("name").cloned().unwrap_or_default(),
            "status": ev.get("status").cloned().unwrap_or_default(),
            "message": ev.get("message").cloned().unwrap_or_default(),
        });
        if let Some(r) = ev.get("reward").filter(|r| !r.is_null()) {
            rec["reward"] = r.clone();
        }
        // 待入账记录（issue #180）：存 pending 标记 + 签到前余额，供 T+1 差值回填
        if ev.get("reward_pending").and_then(Value::as_bool) == Some(true) {
            rec["reward_pending"] = json!(true);
            for k in ["pre_balance", "pre_wb_credits"] {
                if let Some(v) = ev.get(k).filter(|v| !v.is_null()) {
                    rec[k] = v.clone();
                }
            }
        }
        kept.push(rec);
    }
    data["results"] = json!(kept);
    let _ = crate::store::docs::wb_checkin_results_save(&store, &data);
}

/// T+1 待入账回填入口（issue #180）：加载结果文档 → 差值回填 → 有变更则落库。
/// success/already 主流程与 already 早返回分支共用。返回回填的差值。
fn try_backfill_pending(
    state: &AppState,
    aid: &str,
    agent: &ureq::Agent,
    headers: &[(String, String)],
    base: &str,
) -> Option<f64> {
    // 与 append_results 同款双层锁（2026-11-20 审查修复）：同段 load→改→save，
    // 与 GUI/CLI 并发轮次互斥；持锁跨越余额查询网络往返（见 RESULTS_LOCK 注释权衡）
    let _g = RESULTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _cross = match crate::tasks::qoder_common::CrossProcLock::try_acquire_ns(
        &state.data_dir,
        "wb_checkin",
        "append_results",
        3_000,
    ) {
        (Some(g), _) => Some(g),
        (None, Some(fail)) => {
            crate::fs_utils::app_log(
                &state.data_dir,
                &format!(
                    "[wb_checkin] T+1 回填跨进程锁未获取（{}），降级进程内锁继续写",
                    fail.describe()
                ),
            );
            None
        }
        (None, None) => None,
    };
    let mut results: Value =
        crate::store::docs::wb_checkin_results_load(&crate::store::db(&state.data_dir));
    let diff = backfill_pending_reward(state, aid, agent, headers, base, &mut results)?;
    let _ = crate::store::docs::wb_checkin_results_save(&crate::store::db(&state.data_dir), &results);
    Some(diff)
}

/// T+1 待入账差值回填（issue #180）：找该账号最近一条 reward_pending 且 date < 今日的
/// 记录，用当前余额 - 记录中签到前余额（billing 优先，WB credits 兜底，仅差值>0
/// 采信）回填 reward 并清 pending 标记。无待回填记录时不发起任何网络请求。
/// 返回回填的差值（None = 无待回填记录或差值未命中）。
fn backfill_pending_reward(
    state: &AppState,
    aid: &str,
    agent: &ureq::Agent,
    headers: &[(String, String)],
    base: &str,
    results: &mut Value,
) -> Option<f64> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let recs = results.get_mut("results")?.as_array_mut()?;
    let idx = recs.iter().rposition(|r| {
        r.get("reward_pending").and_then(Value::as_bool) == Some(true)
            && r.get("user_id").and_then(Value::as_str) == Some(aid)
            && r
                .get("date")
                .and_then(Value::as_str)
                .is_some_and(|d| d < today.as_str())
    })?;
    let rec = &recs[idx];
    let pre_b = rec.get("pre_balance").and_then(Value::as_f64);
    let pre_w = rec.get("pre_wb_credits").and_then(Value::as_f64);
    if pre_b.is_none() && pre_w.is_none() {
        return None; // 无签到前余额基准，无法差值回填（保持待入账态）
    }
    let post_b = fetch_balance(agent, headers, base);
    let post_w = fetch_wb_credits_balance(state, aid);
    let diff = backfill_diff(pre_b, post_b, pre_w, post_w)?;
    recs[idx]["reward"] = json!(diff);
    recs[idx]["reward_pending"] = json!(false);
    Some(diff)
}

// ── 签到主流程 ─────────────────────────────────────────────────────────────

/// 处理单账号签到（含 401 刷新一次重试）。返回 account 事件（不含 index）
fn process_account(state: &AppState, agent: &ureq::Agent, acct: &Value, opts: &CheckinOpts) -> Value {
    let aid = s_of(acct.get("id"));
    let name = first_str(&[
        acct.get("nickname").and_then(Value::as_str).map(str::to_string),
        Some(s_of(acct.get("uid")).chars().take(8).collect()),
        Some(aid.clone()),
    ]);
    let base_ev = json!({"user_id": aid, "name": name});
    if opts.skip_expired && py_truthy(acct.get("needs_relogin")) {
        return json!({ "user_id": aid, "name": base_ev["name"], "status": "fail", "message": "需重新登录，已跳过" });
    }
    let (creds, refreshed, note) = wb_common::ensure_fresh(state, agent, acct, opts.lazy_hours);
    if creds.access_token.is_empty() {
        let msg = if note == "vault_down" {
            "凭证加密存储暂时不可用（vault 故障），稍后自动恢复".to_string()
        } else {
            format!("无可用凭证（{note}）")
        };
        return json!({ "user_id": aid, "name": base_ev["name"], "status": "fail", "message": msg });
    }
    if refreshed {
        sync_pool_expiry(state, &aid, &creds);
    }
    let base = wb_common::region_billing_base(&creds.domain);
    let urls = urls_for(base);
    let mut headers = wb_common::build_auth_headers(&creds, false);
    let (checked, status_streak, ok) = checkin_status(agent, &headers, &urls);
    if ok && checked == Some(true) {
        let mut ev = json!({ "user_id": aid, "name": base_ev["name"], "status": "already", "message": "今日已签到" });
        if let Some(s) = status_streak {
            ev["checkin_streak"] = json!(s);
        }
        // T+1 待入账回填在早返回分支同样执行：今日已在别处签到时主流程不可达，
        // 漏跑会导致昨日 pending 当日不回填（审查修复）
        if let Some(diff) = try_backfill_pending(state, &aid, agent, &headers, base) {
            ev["message"] = json!(format!("今日已签到；昨日待入账积分已到账 +{diff}"));
        }
        return ev;
    }
    // 签到前余额（获得积分差值兜底数据源；两级恒取：①billing meter 通用积分
    // ②WB credits 域 WorkBuddy 积分——查询失败不阻塞签到。恒取两级的原因：
    // billing 前值可能成功但余额恰好不变（签到加的是 WB 积分账本），差值恒 0 时
    // 仍需 WB credits 差值兜底）
    let pre_balance = fetch_balance(agent, &headers, base);
    let pre_wb_credits = fetch_wb_credits_balance(state, &aid);
    let (mut kind, mut message, mut reward, mut delayed, mut do_streak, mut dbg_keys) =
        checkin_do(agent, &headers, &urls);
    if kind == "auth" {
        // 401：刷新一次仅重试失败分支（禁止二次刷新，F-09）。
        // H-1：加锁刷新 + 二次检查（他人已刷新落库直接复用）+ 内部落库
        let (new, fail_reason, fail_detail) = wb_common::refresh_token_once_locked(state, agent, &aid, &creds);
        match new {
            Some(new) => {
                sync_pool_expiry(state, &aid, &new);
                headers = wb_common::build_auth_headers(&new, false);
                let r = checkin_do(agent, &headers, &urls);
                kind = r.0;
                message = r.1;
                reward = r.2;
                delayed = r.3;
                do_streak = r.4;
                dbg_keys = r.5;
                // 二次失败（审查 P1-4）：新凭证仍 401 → 标记重登录，归一为 fail
                if kind == "auth" {
                    wb_common::mark_needs_relogin(state, &aid, "签到重试后仍 401");
                    kind = "fail".into();
                    message = "登录态失效（刷新后仍 401），需重新登录".into();
                    reward = None;
                    delayed = false;
                    do_streak = None;
                }
            }
            None => {
                // 凭证失效才标记重登录；网络故障/响应异常/他方进程刷新中不误标（审查 P1-4 + H-1）
                if fail_reason == Some(wb_common::RefreshFail::Auth) {
                    // issue #118：透传上游 error/error_description，便于区分会话失效与账号封禁
                    let mut reason = format!("签到 refresh 失败: {message}");
                    if let Some(d) = fail_detail.as_deref() {
                        reason.push_str(&format!("；上游: {d}（{}）", wb_common::refresh_fail_hint(d)));
                    }
                    wb_common::mark_needs_relogin(state, &aid, &reason);
                }
                kind = "fail".into();
                message = match fail_detail.as_deref() {
                    Some(d) => format!(
                        "登录态失效且刷新失败，需重新登录；上游: {d}（{}）",
                        wb_common::refresh_fail_hint(d)
                    ),
                    None => "登录态失效且刷新失败，需重新登录".into(),
                };
                reward = None;
                delayed = false;
                do_streak = None;
            }
        }
    }
    // 获得积分兜底（F-17）：接口未返回奖励数额时用签到前后余额差值；
    // 仅差值>0 才采信（防并发扣减/查询时点差造成负值误报）。
    // 两级数据源都尝试：①billing meter（通用积分）②WB credits（WorkBuddy 积分）
    let mut balance_shrunk = false; // 差值兜底期间检测到余额下降（并发扣减），用于诊断区分「无奖励」与「未能核实」
    // delayed（credit_delayed 次日到账）时跳过当场差值兜底：余额未变差值恒 0，
    // 白打两次余额查询（issue #180）
    if kind == "success" && reward.is_none() && !delayed {
        if let Some(pre) = pre_balance {
            if let Some(post) = fetch_balance(agent, &headers, base) {
                if post > pre {
                    reward = Some(((post - pre) * 100.0).round() / 100.0);
                } else if post < pre {
                    balance_shrunk = true;
                }
            }
        }
        if reward.is_none() {
            if let Some(pre) = pre_wb_credits {
                if let Some(post) = fetch_wb_credits_balance(state, &aid) {
                    if post > pre {
                        reward = Some(((post - pre) * 100.0).round() / 100.0);
                    } else if post < pre {
                        balance_shrunk = true;
                    }
                }
            }
        }
    }
    let status_txt = match kind.as_str() {
        "success" => "success",
        "already" => "already",
        _ => "fail",
    };
    // 「已签」回填：签到奖励当日只发一次，今日早前成功记录若已捕获奖励则同步展示
    //（用户语义：无论成功还是已签，获取积分列都应显示当日所得）
    //（审查 P1-3：结果表为纯 append，同日同账号可能多条——取当日 success 记录中的
    // 最大 reward，防早前无奖励记录遮蔽后来的有效记录）
    if status_txt == "already" && reward.is_none() {
        let results: Value = crate::store::docs::wb_checkin_results_load(&crate::store::db(&state.data_dir));
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        reward = results
            .get("results")
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .filter(|r| {
                        r.get("date").and_then(Value::as_str) == Some(today.as_str())
                            && r.get("user_id").and_then(Value::as_str) == Some(aid.as_str())
                            && r.get("status").and_then(Value::as_str) == Some("success")
                    })
                    .filter_map(|r| r.get("reward").and_then(Value::as_f64))
                    .fold(None::<f64>, |acc, v| Some(match acc {
                        Some(a) if a >= v => a,
                        _ => v,
                    }))
            });
    }
    // T+1 待入账回填（issue #180）：此前 credit_delayed 的记录积分次日才到账，
    // 当场差值恒 0——今日账号健康（success/already）时用当前余额与记录中签到前
    // 余额的差值回填并落库。已知权衡：差值窗口内其他入账（盲盒/任务等）会混入，
    // 与「仅差值>0 采信」既有口径一致；回填只写历史记录，不改今日获取积分展示
    let mut backfilled_msg = String::new();
    if matches!(status_txt, "success" | "already") {
        if let Some(diff) = try_backfill_pending(state, &aid, agent, &headers, base) {
            backfilled_msg = format!("；昨日待入账积分已到账 +{diff}");
        }
    }
    // 签到连签（issue #180）：success/already 以签到响应内 streak_days（post-checkin，
    // 当日首签时预检值少 1）优先，预检值为回退；fail 时仅预检值可用
    let checkin_streak = if matches!(kind.as_str(), "success" | "already") {
        do_streak.or(status_streak)
    } else {
        status_streak
    };
    // 诊断（脱敏红线：只输出键路径不含值）：成功但三层提取（精确键/深挖/双差值）
    // 均未命中时记录响应键路径，便于按真实结构校准奖励键；
    // delayed 属「待入账」非「未识别」，不打诊断日志
    if kind == "success" && reward.is_none() && !delayed {
        fs_utils::app_log(
            &state.data_dir,
            &format!(
                "wb 签到成功但奖励数额未识别（接口回显/递归深挖/双余额差值均未命中）: {aid}，响应键路径: {}{}",
                dbg_keys.as_deref().unwrap_or("（响应非 JSON）"),
                if balance_shrunk { "；差值兜底期间余额下降（并发扣减可能抵消奖励差值）" } else { "" },
            ),
        );
    }
    let mut ev = json!({ "user_id": aid, "name": base_ev["name"], "status": status_txt, "message": message });
    if let Some(r) = reward {
        ev["reward"] = json!(r);
    }
    if let Some(s) = checkin_streak {
        ev["checkin_streak"] = json!(s);
    }
    if delayed && reward.is_none() {
        // 待入账态（issue #180）：附带签到前余额供 T+1 差值回填；事件契约新增
        // reward_pending / pre_balance / pre_wb_credits（前端消费 reward_pending）
        ev["reward_pending"] = json!(true);
        if let Some(p) = pre_balance {
            ev["pre_balance"] = json!(p);
        }
        if let Some(p) = pre_wb_credits {
            ev["pre_wb_credits"] = json!(p);
        }
    }
    if kind == "success" && note == "refreshed" {
        ev["message"] = json!(format!("{}（凭证已续期）", ev["message"].as_str().unwrap_or("")));
    }
    if !backfilled_msg.is_empty() {
        ev["message"] = json!(format!("{}{}", ev["message"].as_str().unwrap_or(""), backfilled_msg));
    }
    ev
}

/// 签到整轮：逐账号串行处理，事件经 emit 回调逐条输出（NDJSON 管线复用）。
/// 返回 done 事件（ok/already/failed 计数），供启动补签/托盘静默路径直接消费。
pub fn run_checkin_round(state: &AppState, opts: &CheckinOpts, emit: &mut dyn FnMut(&Value)) -> Value {
    let agent = http_agent(30);
    let pool: Value = crate::store::docs::wb_pool_load(&crate::store::db(&state.data_dir));
    let mut accounts: Vec<Value> = pool
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !opts.uids.is_empty() {
        accounts.retain(|a| opts.uids.iter().any(|u| s_of(a.get("id")) == *u));
    }
    emit(&json!({"type": "start", "total": accounts.len()}));

    // 多账号签到间隔（任务配置页可改，默认 3s，0=关闭）：防上游频控，账号间串行等待；
    // 实际等待叠加 0.5–1.5× 抖动（P4 防风控，打散固定节奏）
    let gap_secs = crate::models::effective_checkin_gap(state.settings().wb_checkin_gap_secs);
    let mut events: Vec<Value> = Vec::new();
    for (i, acct) in accounts.iter().enumerate() {
        if i > 0 && gap_secs > 0 {
            std::thread::sleep(std::time::Duration::from_secs(jittered_gap_secs(gap_secs)));
        }
        // P4 防风控：账号配置了独立代理则单独构建 agent（出口隔离），否则共用直连 agent
        let proxy_url = acct.get("proxy_url").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        let acct_agent = proxy_url.map(|p| http_agent_with_proxy(30, Some(p)));
        let agent = acct_agent.as_ref().unwrap_or(&agent);
        // 单账号失败不中断整轮（python try/except 语义；Rust 直调无异常路径）
        let mut ev = process_account(state, agent, acct, opts);
        ev["index"] = json!(i + 1);
        emit(&ev);
        events.push(ev);
    }

    let ok = events.iter().filter(|e| e["status"] == "success").count();
    let already = events.iter().filter(|e| e["status"] == "already").count();
    let failed = events.len() - ok - already;
    let done = json!({"type": "done", "ok": ok, "already": already, "failed": failed});
    emit(&done);
    append_results(state, &events);
    done
}

// ── 成长中心自动化（T2.5/F-17）────────────────────────────────────────────

/// 401 刷新一次重试封装（对齐 python with_retry）：f 以 headers 为参，
/// 返回 (kind, msg)；kind=auth 时刷新凭证后重试一次。
fn with_retry<F>(state: &AppState, agent: &ureq::Agent, acct_id: &str, creds: &Creds, f: F) -> (String, String)
where
    F: Fn(&[(String, String)]) -> (String, String),
{
    let headers = wb_common::build_auth_headers(creds, false);
    let (kind, msg) = f(&headers);
    if kind == "auth" {
        // H-1：加锁刷新 + 二次检查 + 内部落库（原 refresh_token_once_ex + 手工 save）
        let (new, fail_reason, fail_detail) = wb_common::refresh_token_once_locked(state, agent, acct_id, creds);
        if let Some(new) = new {
            sync_pool_expiry(state, acct_id, &new);
            let h2 = wb_common::build_auth_headers(&new, false);
            let (kind2, msg2) = f(&h2);
            // 二次失败处理（审查 P1-4）：刷新成功但新凭证仍 401 → 凭证实际已失效，
            // 归一为 fail 并回写 needs_relogin（避免 auth 泄漏到上层结果）
            if kind2 == "auth" {
                wb_common::mark_needs_relogin(state, acct_id, "刷新后仍 401");
                return ("fail".into(), "登录态失效（刷新后仍 401），需重新登录".into());
            }
            return (kind2, msg2);
        }
        // 审查修复（M16）：按 RefreshFail 枚举区分文案——仅 Auth/NoRefreshToken 归为
        // 登录态问题（前者标 needs_relogin，后者无 rt 永不自愈同样标）；Network/
        // BadResponse/Busy 属瞬时失败（下次调度自然重试），如实报瞬时失败，
        // 不再渲染成「登录态失效」误导用户去重登
        let auth_dead = matches!(
            fail_reason,
            Some(wb_common::RefreshFail::Auth) | Some(wb_common::RefreshFail::NoRefreshToken)
        );
        if auth_dead {
            // issue #118：透传上游错误细节，便于区分会话失效与账号封禁
            let mut reason = format!("refresh 失败: {msg}");
            if let Some(d) = fail_detail.as_deref() {
                reason.push_str(&format!("；上游: {d}（{}）", wb_common::refresh_fail_hint(d)));
            }
            wb_common::mark_needs_relogin(state, acct_id, &reason);
            let msg_fail = match fail_detail.as_deref() {
                Some(d) => format!(
                    "登录态失效且刷新失败；上游: {d}（{}）",
                    wb_common::refresh_fail_hint(d)
                ),
                None => "登录态失效且刷新失败".into(),
            };
            return ("fail".into(), msg_fail);
        }
        let msg_fail = match fail_detail.as_deref() {
            Some(d) => format!(
                "刷新暂时失败（网络/响应异常或他方进程刷新中），稍后自动重试；上游: {d}（{}）",
                wb_common::refresh_fail_hint(d)
            ),
            None => "刷新暂时失败（网络/响应异常或他方进程刷新中），稍后自动重试".into(),
        };
        return ("fail".into(), msg_fail);
    }
    (kind, msg)
}

/// 旅行状态归一：上游权威字段为 `data.state`（idle / traveling / arrived），不是 arrived 布尔。
/// 取不到时返回空串，由 `classify_travel` 依据记录/目的地/状态词作兜底推断。
fn travel_state_of(body: &Option<Value>) -> String {
    body.as_ref()
        .and_then(|b| fs_utils::dig(b, &["state"]))
        .map(|v| s_of(Some(v)).trim().to_ascii_lowercase())
        .unwrap_or_default()
}

/// 旅行三态（合并上游 issue #210 的三态分派；本地 `data.state` 为第一依据）：
/// 到达（领奖+出发）/ 在途（跳过）/ 空闲（直接出发）。
#[derive(PartialEq, Eq, Debug)]
enum TravelState {
    Arrived,
    InTransit,
    Idle,
}

/// 在途状态串白名单（精确值匹配，防 API 信封顶层 `status:"success"` 误判在途）
const TRAVELING_STATUS: [&str; 6] = [
    "traveling",
    "travelling",
    "on_trip",
    "in_transit",
    "ongoing",
    "on_the_way",
];

/// 明确「无行程/已结束」状态词（上游审查修复 2026-11-18）：行程专用键命中这些值时，
/// 覆盖残留 record_id/destination 的在途推断——旧逻辑有 record 即在途，行程结束但
/// arrived 字段名不匹配（响应结构漂移）时会「不出发不领奖」卡死且无自救。
const IDLE_STATUS: [&str; 9] = [
    "idle",
    "none",
    "no_trip",
    "not_traveling",
    "finished",
    "completed",
    "done",
    "cancelled",
    "canceled",
];

/// 旅行字段递归深挖：精确键名命中（travel/status 的行程字段可能被 record/trip
/// 等业务容器包裹——dig 只沿信封键下钻会漏，导致 arrived/record_id 全部 miss）。
/// 与 deep_reward_dig 同模式：限深 8、精确等值匹配（不做 contains，防误命中）。
fn deep_travel_dig<'a>(v: &'a Value, keys: &[&str], depth: usize) -> Option<&'a Value> {
    if depth > 8 {
        return None;
    }
    match v {
        Value::Object(m) => {
            for k in keys {
                if let Some(hit) = m.get(*k) {
                    return Some(hit);
                }
            }
            m.values()
                .filter(|val| val.is_object() || val.is_array())
                .find_map(|val| deep_travel_dig(val, keys, depth + 1))
        }
        Value::Array(a) => a.iter().find_map(|x| deep_travel_dig(x, keys, depth + 1)),
        _ => None,
    }
}

/// 旅行状态判定（本地 `data.state` 优先，上游 #210 兜底）：
/// 1. `data.state` 命中 idle/traveling/arrived 时直接采用——这是抓包确认的权威字段；
/// 2. 取不到 `state`（响应结构漂移/旧版本）时按上游策略推断：
///    arrived 真值 → Arrived；有行程标识（record_id / 目的地 / 在途状态串）→ InTransit；
///    其余（空响应/无任何行程字段）→ Idle 按空闲出发。
/// 误判在途的代价 = 喵喵永不出发（issue #210 主症状），故无标识时宁可出发——
/// 服务端对「无行程时出发」只会拒绝，下次调度自然重试。
fn classify_travel(b: &Value, data_state: &str) -> TravelState {
    // ① 本地权威口径：`data.state` 明确给出时以此为准
    match data_state {
        "arrived" => return TravelState::Arrived,
        "traveling" | "travelling" | "on_trip" | "in_transit" | "ongoing" | "on_the_way" => {
            return TravelState::InTransit
        }
        "idle" | "none" | "no_trip" | "not_traveling" => return TravelState::Idle,
        _ => {}
    }
    // ② 上游兜底推断（state 缺失或值不在白名单内）
    if py_truthy(deep_travel_dig(b, &["arrived", "is_arrived", "has_arrived"], 0)) {
        return TravelState::Arrived;
    }
    // 行程标识须为「有值」：null 字段（空闲常见形状 {"record_id":null}）不算
    // 在途证据（与 claim 侧 record_id 的 null 过滤同口径）
    let has_record = deep_travel_dig(b, &["record_id", "recordId"], 0)
        .filter(|v| !v.is_null())
        .is_some();
    let has_dest = deep_travel_dig(b, &["destination"], 0)
        .filter(|v| !v.is_null())
        .is_some();
    // status 证据分级：行程专用键（trip_status/travel_status）可信；泛化键 "status"
    // 可能命中无关业务容器（如 task.status="done"），仅在前者 miss 时兜底读取
    let travel_status = deep_travel_dig(b, &["trip_status", "travel_status"], 0)
        .map(|v| s_of(Some(v)))
        .filter(|s| !s.is_empty());
    let status_str = travel_status
        .clone()
        .or_else(|| {
            deep_travel_dig(b, &["status"], 0)
                .map(|v| s_of(Some(v)))
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default()
        .to_ascii_lowercase();
    // 明确「无行程/已结束」状态覆盖残留 record_id/destination 误判。否定证据仅信任
    // 行程专用键——泛化键误覆盖会把真在途误判 Idle 触发无效出发；误判 Idle 的代价
    // 仅 depart 被服务端拒绝后下轮重试，可自纠，故宁可出发
    let idle_override = travel_status
        .map(|s| IDLE_STATUS.contains(&s.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    let traveling = !idle_override
        && (has_record || has_dest || TRAVELING_STATUS.contains(&status_str.as_str()));
    if traveling {
        TravelState::InTransit
    } else {
        TravelState::Idle
    }
}

/// JSON 键路径摘要（脱敏：只记键名不含值，与签到 dbg_keys 同红线，供诊断校准）
fn key_paths_of(b: &Value) -> String {
    let mut paths = Vec::new();
    collect_key_paths(b, "", 0, &mut paths);
    if paths.is_empty() {
        "（响应无可记键）".to_string()
    } else {
        paths.join(" | ")
    }
}

/// 领养前探活：`buddy/info` 无 buddy（null/缺字段）才需要 `/buddy/first`；
/// 查询失败一律 fail-open 当作已有，避免误触发领养写操作。
fn buddy_missing(agent: &ureq::Agent, headers: &[(String, String)], urls: &Urls) -> bool {
    let (st, body, _raw) = wb_common::get_json(agent, &urls.buddy_info, headers);
    if st != 200 {
        return false;
    }
    let Some(b) = body.as_ref() else { return false };
    let buddy = fs_utils::dig(b, &["buddy"]);
    match buddy {
        None => true,
        Some(Value::Null) => true,
        Some(Value::Object(m)) => m.is_empty() || (!m.contains_key("id") && !m.contains_key("buddy_id")),
        Some(Value::String(s)) => s.trim().is_empty() || s.trim() == "null",
        _ => false,
    }
}

/// 目的地 id：实测 1~4；配置不可用时默认 1（咖啡馆）。
fn travel_location_id(agent: &ureq::Agent, headers: &[(String, String)], urls: &Urls) -> u32 {
    let body = wb_common::get_json(agent, &urls.travel_config, headers)
        .1
        .filter(|b| b.is_object());
    let Some(b) = body else { return 1 };
    let candidates = fs_utils::dig(&b, &["locations", "list", "records"])
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    for item in candidates {
        if let Some(id) = fs_utils::dig(item, &["id", "location_id"])
            .and_then(|v| v.as_u64().or_else(|| v.as_str()?.trim().parse::<u64>().ok()))
        {
            if (1..=4).contains(&id) {
                return id as u32;
            }
        }
    }
    1
}

/// Buddy 猫猫旅行闭环：三态状态机（在途等待 / 到站先领后派 / 空闲先领养再派出）。
/// 权威口径见 gcli2api `internal/upstream/travel.go`：
/// `GET /activity/growth/buddy/travel/status` → `data.state=idle|traveling|arrived`，
/// `record_id` 用于 claim，depart body 为 `{"location_id":1..4}`（无 /v2、活动域）。
/// 合并上游 issue #210 的增强：状态字段深挖业务容器、null 不作在途证据、未识别
/// 响应形状落键路径诊断并「宁可出发」（服务端拒绝则下次调度自然重试）。
fn growth_travel(
    state: &AppState,
    agent: &ureq::Agent,
    headers: &[(String, String)],
    urls: &Urls,
) -> (String, String) {
    let (status, body, raw) = wb_common::get_json(agent, &urls.travel_status, headers);
    if status == 401 {
        return ("auth".into(), "登录态失效（401）".into());
    }
    if status != 200 || !body.as_ref().is_some_and(|b| b.is_object()) {
        let head: String = raw.chars().take(60).collect();
        let msg = if status != 0 {
            format!("travel/status 不可用（HTTP {status}）")
        } else {
            format!("travel/status 不可达: {head}")
        };
        return ("fail".into(), msg);
    }
    let b = body.as_ref().unwrap();
    // 本地权威口径：`data.state`；缺失时交给 classify_travel 深挖推断
    let mut data_state = travel_state_of(&body);
    // record_id 深挖（claim 入参；可能被业务容器包裹，null 不算有效行程证据）
    let mut record_id = deep_travel_dig(b, &["record_id", "recordId"], 0)
        .filter(|v| !v.is_null())
        .cloned();
    let mut daily_limit = fs_utils::dig(b, &["daily_limit_reached"])
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut notes: Vec<String> = Vec::new();
    let mut did_something = false;

    // 在途：直接跳过，等待到站（不领奖、不派出）
    if classify_travel(b, &data_state) == TravelState::InTransit {
        let dest = deep_travel_dig(b, &["destination", "name", "target"], 0)
            .map(|v| s_of(Some(v)))
            .filter(|d| !d.is_empty())
            .map(|d| format!("（{d}）"))
            .unwrap_or_default();
        let rid = record_id
            .as_ref()
            .map(|v| format!("记录 {}", value_display(v)))
            .unwrap_or_default();
        let extra = if rid.is_empty() { dest } else { format!("{dest}，{rid}") };
        return ("skip".into(), format!("旅行在途{extra}，等待到站"));
    }

    // 到站：先领奖，再复查状态（领奖后服务端会把 state 复位为 idle）
    // 上游 #210 允许 record_id 缺失时以空 body 提交 claim（部分响应形状不带 record_id，
    // 旧实现直接判失败会漏领当日奖励）；本地保留该宽容，但失败原因仍如实上报。
    if classify_travel(b, &data_state) == TravelState::Arrived {
        let claim_body = match &record_id {
            Some(rid) => json!({ "record_id": rid }),
            None => json!({}),
        };
        let (st, b1, r1) = wb_common::post_json_raw(agent, &urls.travel_claim, headers, &claim_body);
        if st == 401 {
            return ("auth".into(), "登录态失效（401，旅行领奖）".into());
        }
        if (200..=201).contains(&st) {
            did_something = true;
            notes.push(format!("领奖{}", reward_text(b1.as_ref(), &r1)));
            let (st2, body2, _raw2) = wb_common::get_json(agent, &urls.travel_status, headers);
            if st2 == 200 {
                // 领奖后服务端把 state 复位为 idle；只需刷新状态与每日限次，
                // record_id 已消费完毕（下一轮派出不再使用旧记录）
                data_state = travel_state_of(&body2);
                daily_limit = body2
                    .as_ref()
                    .and_then(|b2| deep_travel_dig(b2, &["daily_limit_reached"], 0))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
            }
        } else {
            return ("fail".into(), format!("旅行领奖失败（HTTP {st}）"));
        }
    }

    // 无猫先领养：同意协议 → first（门槛未完成时当日静默跳过）
    if buddy_missing(agent, headers, urls) {
        let _ = wb_common::post_json_raw(agent, &urls.buddy_agreement, headers, &json!({"agree": true}));
        let (st, _b, r) = wb_common::post_json_raw(agent, &urls.buddy_first, headers, &json!({}));
        if st == 401 {
            return ("auth".into(), "登录态失效（401，领养 Buddy）".into());
        }
        if st == 400 && r.contains("first_buddy task not completed yet") {
            return ("skip".into(), "领养门槛未达标（first_buddy 任务未完成），今日不重试".to_string());
        }
        if (200..=201).contains(&st) {
            did_something = true;
            notes.push("已领养 Buddy".into());
        } else {
            notes.push(format!("领养失败（HTTP {st}）"));
        }
    }

    // 派出：以最新状态重新判定（领奖后可能已复位 idle）。上游 #210 的「宁可出发」
    // 语义在此体现——classify_travel 无法识别行程字段时返回 Idle，直接派发；
    // 同时落脱敏键路径日志，供按真实响应结构校准。
    let latest_body = body.as_ref().unwrap();
    let post_state = classify_travel(latest_body, &data_state);
    let state_now = if data_state.is_empty() {
        match post_state {
            TravelState::Idle => "idle",
            TravelState::InTransit => "traveling",
            TravelState::Arrived => "arrived",
        }
    } else {
        data_state.as_str()
    };
    // 状态字段完全识别不出来时落诊断（脱敏：只记键名，与签到 dbg_keys 同红线）：
    // 这是上游 #210 容错分支的可观测性，便于按真实响应结构校准阈值/键名
    if data_state.is_empty() && post_state == TravelState::Idle {
        fs_utils::app_log(
            &state.data_dir,
            &format!(
                "wb 旅行状态未识别出在途/到达字段（按空闲处理并尝试出发），响应键路径: {}",
                key_paths_of(latest_body)
            ),
        );
    }
    if state_now != "traveling" {
        if daily_limit {
            notes.push("今日已派出，等待次日 00:00 重置".into());
        } else {
            let loc = travel_location_id(agent, headers, urls);
            let (st, _b, _r) =
                wb_common::post_json_raw(agent, &urls.travel_depart, headers, &json!({"location_id": loc}));
            if st == 401 {
                return ("auth".into(), "登录态失效（401，派出旅行）".into());
            }
            if (200..=201).contains(&st) {
                did_something = true;
                notes.push(format!("已派出旅行（地点 {loc}）"));
            } else {
                notes.push(format!("派出旅行失败（HTTP {st}）"));
            }
        }
    } else if !notes.iter().any(|n| n.contains("领奖")) {
        notes.push(format!("旅行状态 {state_now}，未派出"));
    }

    let kind = if did_something { "ok" } else { "skip" };
    (kind.into(), notes.join("；"))
}

/// 展示用值文本（数字去尾零、字符串原样）
fn value_display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 抽奖幂等令牌（前端 randomUUID 同款 8-4-4-4-12 形态；本地只需唯一，不要求密码学强度）
fn lottery_client_token(seq: usize) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let x = nanos
        ^ ((std::process::id() as u64) << 32)
        ^ (seq as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (x >> 32) as u32,
        ((x >> 16) & 0xffff) as u16,
        (x & 0xffff) as u16,
        ((x >> 48) & 0xffff) as u16,
        x & 0xffff_ffff_ffff
    )
}

/// 盲盒：lottery/summary(chances) → draw 循环（上限 20）。
/// 实测端点是活动域 `/activity/growth/lottery/{summary,draw}`（无 /v2），
/// draw 必须带 `client_token` 幂等令牌，空 body 会被上游静默拒绝。
fn growth_lottery(agent: &ureq::Agent, headers: &[(String, String)], urls: &Urls) -> (String, String) {
    let (status, body, raw) = wb_common::get_json(agent, &urls.lottery_summary, headers);
    if status == 401 {
        return ("auth".into(), "登录态失效（401）".into());
    }
    if status != 200 || !body.as_ref().is_some_and(|b| b.is_object()) {
        let head: String = raw.chars().take(60).collect();
        let msg = if status != 0 {
            format!("lottery/summary 不可用（HTTP {status}）")
        } else {
            format!("lottery/summary 不可达: {head}")
        };
        return ("fail".into(), msg);
    }
    let b = body.as_ref().unwrap();
    if fs_utils::dig(b, &["module", "enabled"])
        .and_then(Value::as_bool)
        .is_some_and(|enabled| !enabled)
    {
        return ("skip".into(), "抽奖模块未开启".into());
    }
    let balance = fs_utils::dig(b, &["chances", "balance", "count", "remain"]).and_then(|v| match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f.round() as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    });
    let Some(balance) = balance.filter(|n| *n > 0) else {
        return ("skip".into(), "无可用次数".into());
    };
    let mut balance = balance;
    let mut draws = 0usize;
    let mut rewards: Vec<String> = vec![];
    while balance > 0 && draws < LOTTERY_MAX_DRAWS {
        let (st, b, r) = wb_common::post_json_raw(
            agent,
            &urls.lottery_draw,
            headers,
            &json!({"client_token": lottery_client_token(draws + 1)}),
        );
        if st == 401 {
            return ("auth".into(), format!("登录态失效（401，已抽 {draws} 次）"));
        }
        if !(200..=201).contains(&st) {
            let head: String = r.chars().take(60).collect();
            if draws == 0 {
                return ("fail".into(), format!("draw 失败（HTTP {st}）{head}"));
            }
            break;
        }
        draws += 1;
        let prize = b
            .as_ref()
            .and_then(|bb| fs_utils::dig(bb, &["prize", "reward", "name"]))
            .or_else(|| b.as_ref().and_then(|bb| fs_utils::dig(bb, &["credit", "credits", "points", "amount"])));
        if let Some(rw) = prize.filter(|v| !v.is_null()) {
            rewards.push(value_display(rw));
        }
        balance -= 1;
    }
    let joined = if rewards.is_empty() {
        "见响应".to_string()
    } else {
        rewards.join("/")
    };
    ("ok".into(), format!("抽取 {draws} 次（奖励 {joined}）"))
}

/// 成长任务码：`task_code` / `taskCode` / `code`，空值不算。
fn task_code_of(t: &Value) -> Option<String> {
    for key in ["task_code", "taskCode", "code"] {
        if let Some(v) = fs_utils::dig(t, &[key]) {
            let code = s_of(Some(v));
            if !code.is_empty() {
                return Some(code);
            }
        }
    }
    None
}

/// 报名状态归一：大小写 / 连字符 / 下划线抹平（上游实测为 not_accepted → accepted → complete 字符串枚举）。
fn task_status_norm(t: &Value) -> String {
    fs_utils::dig(t, &["accept_status", "acceptStatus", "status"])
        .map(|v| s_of(Some(v)).trim().to_ascii_lowercase().replace('-', "").replace('_', ""))
        .unwrap_or_default()
}

fn task_needs_accept(t: &Value) -> bool {
    let s = task_status_norm(t);
    s.is_empty() || ["notaccepted", "unaccepted", "pending", "noaccept", "0", "false", "未报名"].contains(&s.as_str())
}

fn task_claimed(t: &Value) -> bool {
    for key in ["claimed", "is_claimed", "has_claimed", "received"] {
        if let Some(v) = fs_utils::dig(t, &[key]) {
            if py_truthy(Some(v)) {
                return true;
            }
        }
    }
    let s = task_status_norm(t);
    ["claimed", "received", "已领取", "claimedreward"].contains(&s.as_str())
}

/// 完成判定：官方口径以 progress 为准（current >= target 且 target > 0），
/// 平铺 current/target 与嵌套 progress 都支持；无进度信息时才回退状态枚举。
fn task_completed(t: &Value) -> bool {
    let progress = fs_utils::dig(t, &["progress"]);
    let current = progress
        .and_then(|p| fs_utils::dig(p, &["current", "value", "count", "num"]))
        .and_then(|v| num_or_none(Some(v)))
        .or_else(|| fs_utils::dig(t, &["current", "progress_current"]).and_then(|v| num_or_none(Some(v))));
    let target = progress
        .and_then(|p| fs_utils::dig(p, &["target", "total", "goal", "need"]))
        .and_then(|v| num_or_none(Some(v)))
        .or_else(|| fs_utils::dig(t, &["target", "progress_target"]).and_then(|v| num_or_none(Some(v))));
    if let (Some(c), Some(tg)) = (current, target) {
        return tg > 0.0 && c >= tg;
    }
    let s = task_status_norm(t);
    ["complete", "completed", "finished", "claimable", "rewardavailable", "已完成", "已达标", "可领取"].contains(&s.as_str())
}

fn task_claimable(t: &Value) -> bool {
    task_completed(t) && !task_claimed(t)
}

/// 任务链域名候选：当前 billing base 不通时依次探测活动域 / chat 域（仅 CN 区）。
fn task_list_candidates(base: &'static str) -> Vec<Urls> {
    let mut out = vec![urls_for(base)];
    if !wb_common::is_global_region(base) {
        for extra in [wb_common::ACTIVITY_BASE_CN, wb_common::REGION_CN.chat_base] {
            if !out.iter().any(|u| u.base == extra) {
                out.push(urls_for(extra));
            }
        }
    }
    out
}

/// HTTP 200 但业务码非 0 时视为失败（上游常在 body 里带 code/msg）。
fn task_business_error(body: &Option<Value>) -> Option<String> {
    let b = body.as_ref()?;
    let code = fs_utils::dig(b, &["code", "errcode"])?;
    let ok = match code {
        Value::Number(n) => n.as_i64() == Some(0) || n.as_f64() == Some(0.0),
        Value::String(s) => s == "0" || s.eq_ignore_ascii_case("success") || s.eq_ignore_ascii_case("ok"),
        _ => true,
    };
    if ok {
        return None;
    }
    let msg = fs_utils::dig(b, &["msg", "message"]).map(value_display).unwrap_or_default();
    Some(if msg.is_empty() { format!("code {}", value_display(code)) } else { msg })
}

/// 成长任务：GET 列表 → 批量报名 `task_codes` → 已完成任务逐个 `reward/claim` 领奖。
/// 不伪造行为事件：未完成任务只报名，等用户真实使用后再领奖。
fn growth_tasks(agent: &ureq::Agent, headers: &[(String, String)], urls: &Urls) -> (String, String) {
    let mut status = 0u16;
    let mut body: Option<Value> = None;
    let mut raw = String::new();
    let mut used = urls.clone();
    for candidate in task_list_candidates(urls.base) {
        let (st, b, r) = wb_common::get_json(agent, &candidate.tasks, headers);
        if st == 401 {
            return ("auth".into(), "登录态失效（401）".into());
        }
        let has_list = b
            .as_ref()
            .and_then(|x| fs_utils::dig(x, &["tasks"]))
            .and_then(Value::as_array)
            .is_some();
        status = st;
        body = b;
        raw = r;
        if has_list {
            used = candidate;
            break;
        }
    }
    let tasks: Vec<Value> = body
        .as_ref()
        .filter(|b| b.is_object() && status == 200)
        .and_then(|b| fs_utils::dig(b, &["tasks"]))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if tasks.is_empty() {
        let head: String = raw.chars().take(60).collect();
        let msg = if status == 0 {
            format!("tasks 不可达: {head}")
        } else {
            format!("tasks 列表为空或格式变化（HTTP {status}）: {head}")
        };
        return ("fail".into(), msg);
    }
    let mut accept_codes: Vec<String> = Vec::new();
    let mut claim_codes: Vec<String> = Vec::new();
    for t in &tasks {
        let Some(code) = task_code_of(t) else { continue };
        if task_needs_accept(t) && !accept_codes.contains(&code) {
            accept_codes.push(code.clone());
        }
        if task_claimable(t) && !claim_codes.contains(&code) {
            claim_codes.push(code);
        }
    }
    let mut notes: Vec<String> = Vec::new();
    let mut accepted = 0usize;
    let mut claimed = 0usize;
    if !accept_codes.is_empty() {
        let (st, b, r) = wb_common::post_json_raw(
            agent,
            &used.tasks_accept,
            headers,
            &json!({"task_codes": accept_codes}),
        );
        if st == 401 {
            return ("auth".into(), "登录态失效（401，报名阶段）".into());
        }
        if (200..=201).contains(&st) && task_business_error(&b).is_none() {
            accepted = accept_codes.len();
        } else {
            let detail = task_business_error(&b).unwrap_or_else(|| {
                let head: String = r.chars().take(60).collect();
                format!("HTTP {st} {head}")
            });
            notes.push(format!("报名失败：{detail}"));
        }
    }
    for code in &claim_codes {
        // 实测领奖为路径参数式：`{web}/activity/growth/tasks/{task_code}/claim`，POST 无 body。
        // 旧 `POST /v2/.../tasks/reward/claim {"task_code":...}` 是误用路径，恒 400。
        let claim_url = format!("{}/{}/claim", used.tasks_claim_base.trim_end_matches('/'), code);
        let (st, b, r) = wb_common::post_json_raw(agent, &claim_url, headers, &json!({}));
        if st == 401 {
            return ("auth".into(), format!("登录态失效（401，领奖阶段，已领 {claimed} 项）"));
        }
        let biz = task_business_error(&b);
        let already_flag = b
            .as_ref()
            .and_then(|bb| fs_utils::dig(bb, &["already_claimed"]))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let already = already_flag
            || biz.as_deref().is_some_and(|m| m.contains("已领") || m.to_ascii_lowercase().contains("already"));
        if ((200..=201).contains(&st) && biz.is_none()) || already {
            claimed += 1;
        } else {
            let detail = biz.unwrap_or_else(|| {
                let head: String = r.chars().take(60).collect();
                format!("HTTP {st} {head}")
            });
            notes.push(format!("领奖失败（{code}）：{detail}"));
        }
    }

    let pending = tasks.iter().filter(|t| !task_claimable(t) && !task_claimed(t)).count();
    let mut parts = vec![format!("报名 {accepted} 项"), format!("领取 {claimed} 项")];
    if pending > 0 {
        parts.push(format!("{pending} 项待完成"));
    }
    let has_notes = !notes.is_empty();
    parts.extend(notes);
    let kind = if accepted > 0 || claimed > 0 {
        "ok"
    } else if has_notes {
        "fail"
    } else {
        "skip"
    };
    (kind.into(), parts.join(" / "))
}

/// 能量与连签天数（页面附注展示；对象响应归一为标量，防 [object Object]）。
/// issue #180：growth/streak 的 streak 是「活跃连签」（使用事件驱动，成长任务
/// 做完常为 0），另取 checkin-activity-status 的 streak_days 作为「签到连签」
/// 分开展示（该接口为 POST，与签到预检同端点）
fn growth_info(agent: &ureq::Agent, headers: &[(String, String)], urls: &Urls) -> Vec<(&'static str, f64)> {
    let mut info = vec![];
    let (st, b, _r) = wb_common::get_json(agent, &urls.energy, headers);
    if st == 200 {
        if let Some(v) = b
            .filter(|bb| bb.is_object())
            .and_then(|bb| fs_utils::dig(&bb, &["energy", "value", "balance", "num"]).cloned())
            .and_then(|v| scalar_of(&v))
        {
            info.push(("energy", v));
        }
    }
    let (st, b, _r) = wb_common::get_json(agent, &urls.streak, headers);
    if st == 200 {
        if let Some(v) = b
            .filter(|bb| bb.is_object())
            .and_then(|bb| fs_utils::dig(&bb, &["streak", "days", "continuous_days", "count"]).cloned())
            .and_then(|v| scalar_of(&v))
        {
            info.push(("streak", v));
        }
    }
    let (st, b) = wb_common::post_json(agent, &urls.checkin_status, headers, &json!({}));
    if st == 200 {
        if let Some(v) = b.filter(|bb| bb.is_object()).and_then(|bb| streak_days_from(&bb)) {
            info.push(("checkin_streak", v));
        }
    }
    info
}

/// 单账号成长中心链式执行（旅行→盲盒→任务，各步独立容错；401 刷新一次重试）
fn process_account_growth(state: &AppState, agent: &ureq::Agent, acct: &Value, flags: &GrowthOpts) -> Value {
    let aid = s_of(acct.get("id"));
    let name = first_str(&[
        acct.get("nickname").and_then(Value::as_str).map(str::to_string),
        Some(s_of(acct.get("uid")).chars().take(8).collect()),
        Some(aid.clone()),
    ]);
    let base_ev = json!({"type": "growth", "user_id": aid, "name": name});
    let (creds, _refreshed, note) = wb_common::ensure_fresh(state, agent, acct, 24);
    if creds.access_token.is_empty() {
        let msg = if note == "vault_down" {
            "凭证加密存储暂时不可用（vault 故障），稍后自动恢复".to_string()
        } else {
            format!("无可用凭证（{note}）")
        };
        return json!({ "type": "growth", "user_id": aid, "name": base_ev["name"], "status": "fail", "message": msg });
    }
    let urls = urls_for(wb_common::region_billing_base(&creds.domain));

    let mut result = Map::new();
    let mut step_fails = 0usize;
    if flags.travel {
        let (kind, msg) = with_retry(state, agent, &aid, &creds, |h| growth_travel(state, agent, h, &urls));
        result.insert("travel".into(), json!(if kind == "fail" { "fail" } else { msg.as_str() }));
        if kind == "fail" {
            step_fails += 1;
        }
    }
    if flags.lottery {
        let (kind, msg) = with_retry(state, agent, &aid, &creds, |h| growth_lottery(agent, h, &urls));
        result.insert("lottery".into(), json!(if kind == "fail" { "fail" } else { msg.as_str() }));
        if kind == "fail" {
            step_fails += 1;
        }
    }
    if flags.tasks {
        let (kind, msg) = with_retry(state, agent, &aid, &creds, |h| growth_tasks(agent, h, &urls));
        if kind == "fail" {
            step_fails += 1;
            let short: String = aid.chars().take(8).collect();
            fs_utils::app_log(&state.data_dir, &format!("[wb-growth] {short} tasks: {msg}"));
        }
        // 报名/领奖失败时保留详细原因（含 HTTP 状态码）供 UI 排查，不折叠为裸 "fail"
        result.insert("tasks".into(), json!(msg));
    }
    // 能量/连签（不带刷新重试，纯展示）
    let headers = wb_common::build_auth_headers(&creds, false);
    for (k, v) in growth_info(agent, &headers, &urls) {
        result.insert(k.to_string(), json!(v));
    }

    let enabled = ["travel", "lottery", "tasks"]
        .iter()
        .filter(|k| result.contains_key(**k))
        .count();
    let status = if step_fails > 0 && step_fails == enabled { "fail" } else { "ok" };
    let mut ev = json!({ "type": "growth", "user_id": aid, "name": base_ev["name"], "status": status });
    for (k, v) in result {
        ev[k.as_str()] = v;
    }
    ev
}

/// 成长中心整轮：NDJSON 输出（wb-checkin-progress 管线复用）
pub fn run_growth_round(state: &AppState, flags: &GrowthOpts, uids: &[String], emit: &mut dyn FnMut(&Value)) {
    let agent = http_agent(30);
    let pool: Value = crate::store::docs::wb_pool_load(&crate::store::db(&state.data_dir));
    let mut accounts: Vec<Value> = pool
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !uids.is_empty() {
        accounts.retain(|a| uids.iter().any(|u| s_of(a.get("id")) == *u));
    }
    emit(&json!({"type": "start", "total": accounts.len(), "mode": "growth"}));
    // 多账号成长间隔（与签到共用 wb_checkin_gap_secs，默认 3s，0=关闭）：防上游频控，
    // 同签到一样叠加抖动（P4 防风控）
    let gap_secs = crate::models::effective_checkin_gap(state.settings().wb_checkin_gap_secs);
    for (i, acct) in accounts.iter().enumerate() {
        if i > 0 && gap_secs > 0 {
            std::thread::sleep(std::time::Duration::from_secs(jittered_gap_secs(gap_secs)));
        }
        // P4：独立代理账号单独构建 agent（与签到轮一致）
        let proxy_url = acct.get("proxy_url").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        let acct_agent = proxy_url.map(|p| http_agent_with_proxy(30, Some(p)));
        let agent = acct_agent.as_ref().unwrap_or(&agent);
        let mut ev = process_account_growth(state, agent, acct, flags);
        ev["index"] = json!(i + 1);
        emit(&ev);
    }
    emit(&json!({"type": "done", "mode": "growth"}));
}

// ── token 每周兜底续期（F-09，schtasks / --task-run wb-renew）──────────────

/// 每周兜底：对全部账号执行惰性刷新（lazy_hours 传 0 = 每天无条件刷新全部，F-55）。
/// 返回末行 JSON 摘要（零 token 输出）。
pub fn run_renew_only(state: &AppState, lazy_hours: i64) -> Value {
    let agent = http_agent(30);
    let pool: Value = crate::store::docs::wb_pool_load(&crate::store::db(&state.data_dir));
    let accounts: Vec<Value> = pool
        .get("accounts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items: Vec<Value> = vec![];
    for acct in &accounts {
        let aid = s_of(acct.get("id"));
        if aid.is_empty() {
            continue;
        }
        let (creds, refreshed, note) = wb_common::ensure_fresh(state, &agent, acct, lazy_hours);
        if refreshed {
            sync_pool_expiry(state, &aid, &creds);
        }
        let mut item = json!({"user_id": aid, "refreshed": refreshed, "note": note});
        if creds.access_token.is_empty() && note != "vault_down" {
            // vault_down（issue #153 修复 2）不得被覆写为 no_credential——
            // 否则下游按「账号无凭证」处理，掩盖 vault 故障真相
            item["note"] = json!("no_credential");
        }
        items.push(item);
    }
    json!({"mode": "renew", "finished_at": fs_utils::now_ts(), "accounts": items})
}

#[cfg(test)]
mod wb_checkin_tests {
    use super::*;

    // ── issue #210：旅行三态判定 ──

    #[test]
    fn deep_travel_dig_finds_fields_wrapped_in_business_containers() {
        // 行程字段被 record 容器包裹（非信封键）——dig 沿信封键下钻恒 miss，
        // 旧行为据此误判「旅行在途」致喵喵永不出发；深挖按精确键名命中
        let b = json!({"code": 0, "data": {"record": {"record_id": "r1", "arrived": true}}});
        assert_eq!(fs_utils::dig(&b, &["arrived"]), None);
        assert!(py_truthy(deep_travel_dig(&b, &["arrived", "is_arrived"], 0)));
        assert_eq!(
            deep_travel_dig(&b, &["record_id", "recordId"], 0).and_then(Value::as_str),
            Some("r1")
        );
    }

    /// 便捷包装：多数上游用例不带 `data.state`（验证纯推断分支）
    fn classify(b: &Value) -> TravelState {
        classify_travel(b, "")
    }

    #[test]
    fn classify_travel_three_states() {
        // 到达：领奖 + 出发
        assert_eq!(
            classify(&json!({"data": {"arrived": true, "record_id": "r"}})),
            TravelState::Arrived
        );
        // 在途：有行程标识（record / 目的地 / 在途状态串）
        assert_eq!(
            classify(&json!({"data": {"record_id": "r", "destination": "上海"}})),
            TravelState::InTransit
        );
        assert_eq!(
            classify(&json!({"data": {"trip_status": "Traveling"}})),
            TravelState::InTransit
        );
        // 空闲：无任何行程字段（旧行为误判「旅行在途」永不出发，issue #210）
        assert_eq!(classify(&json!({"code": 0, "data": null})), TravelState::Idle);
        assert_eq!(classify(&json!({"code": 0, "data": {}})), TravelState::Idle);
        assert_eq!(classify(&json!({"data": {"status": "idle"}})), TravelState::Idle);
        // null 字段不算行程证据（空闲常见形状，审查 issue #1）
        assert_eq!(
            classify(&json!({"data": {"record_id": null, "destination": null}})),
            TravelState::Idle
        );
        assert_eq!(
            classify(&json!({"data": {"record": {"record_id": null}}})),
            TravelState::Idle
        );
        // API 信封顶层 status:"success" 不得误判在途
        assert_eq!(
            classify(&json!({"code": 0, "status": "success", "data": {}})),
            TravelState::Idle
        );
        // 审查修复 2026-11-18：行程结束但 arrived 字段名不匹配 → 专用键明确
        // 「已结束」覆盖残留 record/dest，不再钉死在途（不出发不领奖无自救）
        assert_eq!(
            classify(&json!({"data": {"record_id": "r", "trip_status": "finished"}})),
            TravelState::Idle
        );
        // 泛化键 "status" 的否定词不作否定证据（可能命中无关容器 task.status="done"）：
        // 专用键 miss 时保留 record/dest 推断，真在途不误判 Idle
        assert_eq!(
            classify(&json!({"data": {"record_id": "r", "task": {"status": "done"}}})),
            TravelState::InTransit
        );
    }

    #[test]
    fn classify_travel_prefers_data_state() {
        // 本地权威口径：`data.state` 明确给出时优先于一切推断
        // （即使在途残留 record_id，state=idle 也应按空闲派出，不被残留钉死）
        assert_eq!(
            classify_travel(&json!({"data": {"state": "idle", "record_id": "r"}}), "idle"),
            TravelState::Idle
        );
        assert_eq!(
            classify_travel(&json!({"data": {"state": "arrived"}}), "arrived"),
            TravelState::Arrived
        );
        assert_eq!(
            classify_travel(&json!({"data": {"state": "traveling"}}), "traveling"),
            TravelState::InTransit
        );
        // state 值不在白名单（未知形态）→ 回落到上游推断，不因未知值直接判空闲/在途
        assert_eq!(
            classify_travel(&json!({"data": {"state": "something_new", "record_id": "r"}}), "something_new"),
            TravelState::InTransit
        );
        // state 缺失（空串）走推断：无任何行程字段 → 宁可出发
        assert_eq!(
            classify_travel(&json!({"code": 0, "data": {}}), ""),
            TravelState::Idle
        );
    }

    #[test]
    fn key_paths_of_masks_values() {
        // 诊断只记键名不含值（红线：日志不得落业务数据）
        let b = json!({"code": 0, "data": {"record": {"record_id": "secret"}}});
        let paths = key_paths_of(&b);
        assert!(!paths.contains("secret"));
        assert!(paths.contains("code") && paths.contains("record_id"));
    }

    /// 真机端到端（cargo test 真机_wb_growth -- --ignored --nocapture）：
    /// 取本地首个 WB 账号跑一轮成长（真实三开关），验证 issue #210 修复——
    /// travel 三态（Idle 出发 / InTransit 跳过 / Arrived 领奖）/ lottery / tasks。
    /// 有真实远端副作用（领奖/出发/抽奖/领任务），仅人工按需触发；轮次锁与
    /// GUI/CLI 互斥，占用时跳过。只打印 NDJSON 事件与账号元数据（不含 token）。
    #[test]
    #[ignore]
    fn 真机_wb_growth单账号端到端() {
        let state = AppState::new().expect("AppState 初始化失败");
        let pool = crate::store::docs::wb_pool_load(&crate::store::db(&state.data_dir));
        let accounts: Vec<Value> = pool
            .get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(!accounts.is_empty(), "本地无 WB 账号，无法验证");
        let acct = &accounts[0];
        let uid = s_of(acct.get("id"));
        println!(
            "选中账号: {}",
            serde_json::to_string(&json!({
                "id": uid,
                "uid": s_of(acct.get("uid")),
                "nickname": s_of(acct.get("nickname")),
                "domain": s_of(acct.get("domain")),
            }))
            .unwrap()
        );
        let s = crate::commands::workbuddy::load_settings(&state);
        let flags = GrowthOpts {
            travel: s.growth_travel,
            lottery: s.growth_lottery,
            tasks: s.growth_tasks,
        };
        match crate::commands::workbuddy::try_acquire_wb_round("真机测试", &state.data_dir) {
            Ok(_) => {
                run_growth_round(&state, &flags, &[uid], &mut |ev| {
                    println!("{}", serde_json::to_string(ev).unwrap());
                });
            }
            Err(why) => println!("轮次锁占用，跳过: {why}"),
        }
    }

    #[test]
    fn scalar_of_unwraps_common_keys() {
        // {current:..} 等对象返回归一为标量（修复前端 [object Object] 展示）
        assert_eq!(scalar_of(&json!({"current": 5})), Some(5.0));
        assert_eq!(scalar_of(&json!({"streak": {"days": "3"}})), Some(3.0));
        assert_eq!(scalar_of(&json!(7)), Some(7.0));
        assert_eq!(scalar_of(&json!("2.5")), Some(2.5));
        assert_eq!(scalar_of(&json!({"other": 1})), None);
        assert_eq!(scalar_of(&json!({"current": null})), None);
    }

    #[test]
    fn num_or_none_rejects_bools_and_garbage() {
        assert_eq!(num_or_none(Some(&json!(true))), None);
        assert_eq!(num_or_none(Some(&json!(10))), Some(10.0));
        assert_eq!(num_or_none(Some(&json!("12.5"))), Some(12.5));
        assert_eq!(num_or_none(Some(&json!("abc"))), None);
        assert_eq!(num_or_none(Some(&json!({"a": 1}))), None);
    }

    #[test]
    fn py_truthy_matches_python_bool_semantics() {
        assert!(!py_truthy(Some(&json!(0))));
        assert!(py_truthy(Some(&json!(1))));
        assert!(!py_truthy(Some(&json!(""))));
        assert!(py_truthy(Some(&json!("false")))); // python bool("false") == True
        assert!(!py_truthy(Some(&json!(null))));
        assert!(py_truthy(Some(&json!({"a": 1}))));
    }

    #[test]
    fn urls_cover_all_endpoints_and_alt_region() {
        let u = urls_for(wb_common::BILLING_BASE_CN);
        assert!(u.checkin_do.starts_with(wb_common::BILLING_BASE_CN));
        // 成长中心走活动域且不带 /v2（签到仍在 billing 域带 /v2）
        assert!(u.travel_status.starts_with(wb_common::ACTIVITY_BASE_CN));
        assert!(u.travel_status.ends_with("/activity/growth/buddy/travel/status"));
        assert!(!u.travel_status.contains("/v2/"));
        assert!(u.lottery_summary.ends_with("/activity/growth/lottery/summary"));
        assert!(u.lottery_draw.ends_with("/activity/growth/lottery/draw"));
        assert!(u.streak.ends_with("/activity/growth/streak"));
        assert!(u.buddy_first.ends_with("/activity/growth/buddy/first"));
        let alt = u.alt();
        assert_eq!(alt.base, wb_common::BILLING_BASE_GLOBAL);
        assert_ne!(alt.checkin_do, u.checkin_do);
    }

    #[test]
    fn growth_task_urls_cover_accept_and_path_style_claim() {
        let u = urls_for(wb_common::BILLING_BASE_CN);
        assert!(u.tasks.starts_with(wb_common::ACTIVITY_BASE_CN));
        assert!(u.tasks.ends_with("/v2/activity/growth/tasks"));
        assert!(u.tasks_accept.ends_with("/tasks/accept"));
        assert!(u.tasks_claim_base.ends_with("/activity/growth/tasks"));
        let claim = format!("{}/{}/claim", u.tasks_claim_base, "daily_chat");
        assert!(claim.ends_with("/activity/growth/tasks/daily_chat/claim"));
        assert!(!claim.contains("/reward/claim"));
        assert!(u.alt().tasks_claim_base.contains(wb_common::BILLING_BASE_GLOBAL));
        // CN 区任务链可探测 billing → activity → chat；Global 区只走自身域名
        assert_eq!(task_list_candidates(wb_common::BILLING_BASE_CN).len(), 3);
        assert_eq!(task_list_candidates(wb_common::BILLING_BASE_GLOBAL).len(), 1);
    }

    #[test]
    fn growth_travel_state_uses_data_state_not_arrived_bool() {
        let body = json!({"data": {"state": "arrived", "record_id": 42, "daily_limit_reached": false}});
        assert_eq!(travel_state_of(&Some(body)), "arrived");
        assert_eq!(travel_state_of(&Some(json!({"data": {"state": "traveling"}}))), "traveling");
        // 旧字段 arrived=true 但无 state 时不误判为已到站
        assert_eq!(travel_state_of(&Some(json!({"arrived": true}))), "");
        let token = lottery_client_token(3);
        assert_eq!(token.len(), 36);
        assert_eq!(token.matches('-').count(), 4);
        assert_ne!(token, lottery_client_token(4));
    }

    #[test]
    fn growth_task_classification_matches_real_enums() {
        let body = json!({"data": {"tasks": [
            {"task_code": "a", "accept_status": "not_accepted", "has_reward": true},
            {"task_code": "b", "accept_status": "accepted", "progress": {"current": 3, "target": 3}},
            {"task_code": "c", "accept_status": "complete", "claimed": false},
            {"task_code": "d", "accept_status": "complete", "claimed": true},
            {"taskCode": "e", "status": "已完成"}
        ]}});
        let tasks = fs_utils::dig(&body, &["tasks"]).and_then(Value::as_array).unwrap();
        let accept: Vec<String> = tasks
            .iter()
            .filter(|t| task_needs_accept(t))
            .filter_map(task_code_of)
            .collect();
        assert_eq!(accept, vec!["a"]);
        let claimable: Vec<String> = tasks.iter().filter(|t| task_claimable(t)).filter_map(task_code_of).collect();
        assert_eq!(claimable, vec!["b", "c", "e"]);
        assert!(task_claimed(&tasks[3]));
        assert!(!task_claimable(&tasks[3]));
        // has_reward=false 的未报名任务依然需要报名，不再被当作过滤门槛
        assert!(task_needs_accept(&json!({"task_code": "f", "has_reward": false})));
    }

    #[test]
    fn growth_task_business_error_reads_code_and_msg() {
        assert!(task_business_error(&Some(json!({"code": 0, "msg": "ok"}))).is_none());
        assert_eq!(
            task_business_error(&Some(json!({"code": 400, "msg": "参数错误"}))),
            Some("参数错误".to_string())
        );
        assert_eq!(
            task_business_error(&Some(json!({"code": 500}))),
            Some("code 500".to_string())
        );
    }

    #[test]
    fn reward_text_prefers_interface_values() {
        assert_eq!(reward_text(Some(&json!({"reward": 10})), ""), "+10");
        assert_eq!(reward_text(Some(&json!({"reward": 1.5})), ""), "+1.5");
        assert_eq!(reward_text(Some(&json!({})), "oops"), "oops");
        assert_eq!(reward_text(Some(&json!({})), ""), "ok");
    }

    // ── issue #180：credit 键 / credit_delayed / streak_days / T+1 回填 ──

    #[test]
    fn credit_key_matched_by_precise_dig_not_by_deep_dig_substring() {
        // 精确键表补单数 credit（issue #180 服务端真实奖励键）
        let b = json!({"code": 0, "data": {"credit": 5, "is_streak_day": true}});
        assert_eq!(
            num_or_none(fs_utils::dig(&b, &["reward", "credits", "credit", "points"])),
            Some(5.0)
        );
        // dig 精确等值匹配：单数 credit 不误命中复数/组合余额键
        let b2 = json!({"data": {"credit": null, "credits_packages": [{"balance": 100}]}});
        assert_eq!(num_or_none(fs_utils::dig(&b2, &["reward", "credits", "credit"])), None);
        // deep_reward_dig contains 表刻意不含裸 credit：credits_packages 不误判为奖励
        assert_eq!(deep_reward_dig(&b2, 0), None);
    }

    #[test]
    fn delayed_credit_detected_only_when_reward_missing() {
        assert!(delayed_credit_pending(&json!(
            {"code": 0, "data": {"credit": null, "credit_delayed": true, "is_streak_day": true}}
        )));
        assert!(!delayed_credit_pending(&json!({"code": 0, "data": {"credit": 5}})));
        assert!(!delayed_credit_pending(&json!({"code": 0, "data": {}})));
    }

    #[test]
    fn streak_days_extracted_from_checkin_status_body() {
        let b = json!({"code": 0, "data": {"today_checked_in": true, "streak_days": 5}});
        assert_eq!(streak_days_from(&b), Some(5.0));
        let b2 = json!({"data": {"streakDays": "3"}});
        assert_eq!(streak_days_from(&b2), Some(3.0));
        assert_eq!(streak_days_from(&json!({"data": {}})), None);
        assert_eq!(streak_days_from(&json!({"data": {"streak_days": null}})), None);
    }

    #[test]
    fn backfill_diff_prefers_billing_then_wb_positive_only() {
        // billing 命中优先
        assert_eq!(backfill_diff(Some(10.0), Some(15.0), Some(100.0), Some(103.0)), Some(5.0));
        // billing 恒 0 → WB credits 兜底
        assert_eq!(backfill_diff(Some(10.0), Some(10.0), Some(100.0), Some(103.0)), Some(3.0));
        // 双双无变化/下降：不采信
        assert_eq!(backfill_diff(Some(10.0), Some(10.0), Some(100.0), Some(100.0)), None);
        assert_eq!(backfill_diff(Some(10.0), Some(8.0), None, None), None);
        // 缺前值基准：不回填
        assert_eq!(backfill_diff(None, Some(15.0), None, Some(103.0)), None);
        // 差值四舍五入两位
        assert_eq!(backfill_diff(None, None, Some(0.1), Some(0.14)), Some(0.04));
    }
}

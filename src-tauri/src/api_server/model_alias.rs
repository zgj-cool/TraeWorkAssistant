//! 模型同义组（model alias groups）
//!
//! 背景：同一模型在各资源池的上游 id 不同（如 Trae `DeepSeek-V4-Pro-Official` /
//! Buddy `deepseek-v4-pro`），客户端想只配一个名字就要为每个 id 各配一份。
//!
//! 本模块提供**显式**同义组：一组 = 对外 id + 成员 `[{pool, model}]`——
//! - **仅对外 id 触发映射**（`resolve`，canonical 大小写不敏感）：请求对外 id 时
//!   按池取成员真实 id（`member`）；未列成员的池回退用请求名（即该池自身同名模型）。
//! - **成员 id 自身请求零行为差异**：成员 id 只作为改写目标，不触发映射（既有模型名
//!   仍按原逻辑路由）。
//! - **不影响模型目录**：unified_catalog / /v1/models 的条目与归并键完全不变，
//!   同义组只是请求入口的前置判断（与池前缀、Key 绑定同级）。
//!
//! 零配置（groups 为空）＝零行为差异。**不做任何后缀自动归一**（`-official` 等是否
//! 同一模型由用户判定后建组），避免把实际不同上游/倍率的模型误合并，也不误伤
//! `-thinking` / `-max` 等入口后缀语义。
//!
//! 存储：kv 键 `model_alias`（逻辑名 model_alias.json，SQLite 化后无运行期 JSON），
//! 读走 config_cache（5s TTL + 写路径失效），热路径（dispatch）可每请求调用。

use std::collections::HashSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::unified_catalog::canonical_id;

/// kv 键（逻辑文件名 `model_alias.json`）
pub const KV_KEY: &str = "model_alias";

/// 合法成员池（与 `dispatch::TargetPool` 的字符串标识一致）
pub const POOLS: [&str; 5] = ["trae", "buddy", "buddy-ai", "qoder", "custom"];

/// 同义组成员：某资源池内的真实模型 id
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AliasMember {
    /// 资源池标识（trae / buddy / buddy-ai / qoder / custom）
    #[serde(default)]
    pub pool: String,
    /// 该池上游真实模型 id
    #[serde(default)]
    pub model: String,
}

/// 同义组：对外 id + 各池成员
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AliasGroup {
    /// 对外 id（客户端配置的模型名；必填，仅此名字触发映射）
    #[serde(default)]
    pub id: String,
    /// 成员列表（各池真实 id，至少一条）
    #[serde(default)]
    pub members: Vec<AliasMember>,
    #[serde(default)]
    pub note: String,
    /// 组开关（false = 该对外名不参与映射，请求按原名原逻辑路由）
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// 配置整表
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AliasFile {
    #[serde(default)]
    pub groups: Vec<AliasGroup>,
    #[serde(default)]
    pub updated_at: Option<i64>,
}

/// 读取配置（热路径缓存；缺失/损坏 → 空表 = 零行为差异）
pub fn load(data_dir: &Path) -> AliasFile {
    super::config_cache::get_or_load(data_dir, KV_KEY, || {
        crate::store::db(data_dir).kv_get(KV_KEY)
    })
}

/// 整表保存（调用方负责先 `validate`；写后显式失效，网关即时生效）
pub fn save(data_dir: &Path, file: &AliasFile) -> Result<(), String> {
    let r = crate::store::db(data_dir).kv_set(KV_KEY, file);
    if r.is_ok() {
        super::config_cache::invalidate(data_dir, KV_KEY);
    }
    r
}

/// 解析请求名 → 同义组（**仅对外 id 命中**；成员 id 不触发映射，保持原路由）。
/// 组禁用视为不命中。返回克隆便于调用方跨多次借用使用
pub fn resolve(data_dir: &Path, requested: &str) -> Option<AliasGroup> {
    load(data_dir).resolve(requested).cloned()
}

impl AliasGroup {
    /// 该池的成员真实 id（无成员 = None）
    pub fn member(&self, pool: &str) -> Option<&str> {
        self.members
            .iter()
            .find(|m| m.pool == pool)
            .map(|m| m.model.trim())
            .filter(|m| !m.is_empty())
    }
}

impl AliasFile {
    /// 请求名命中（**仅对外 id**，canonical 大小写不敏感）。
    /// 成员 id 只作为改写目标，自身请求仍按原逻辑路由（同义组不影响既有模型名行为）
    pub fn resolve(&self, requested: &str) -> Option<&AliasGroup> {
        let key = canonical_id(requested);
        if key.is_empty() {
            return None;
        }
        self.groups
            .iter()
            .find(|g| g.enabled && canonical_id(&g.id) == key)
    }
}

/// 结构校验（保存前调用，失败返回中文错误）：
/// 对外 id 非空且组间唯一；成员 ≥1、池合法、model 非空；同组内池不重复。
/// 允许同一成员被多个组引用（同一模型起多个对外别名是合法用法）
pub fn validate(file: &AliasFile) -> Result<(), String> {
    let mut ids: HashSet<String> = HashSet::new();
    for (i, g) in file.groups.iter().enumerate() {
        let id = canonical_id(&g.id);
        if id.is_empty() {
            return Err(format!("第 {} 组：对外模型名不能为空", i + 1));
        }
        if !ids.insert(id.clone()) {
            return Err(format!("对外模型名重复：{}（每个组必须唯一）", g.id.trim()));
        }
        if g.members.is_empty() {
            return Err(format!("{}：至少需要一个池成员", g.id.trim()));
        }
        let mut pools: HashSet<&str> = HashSet::new();
        for m in &g.members {
            let pool = m.pool.trim();
            if !POOLS.contains(&pool) {
                return Err(format!(
                    "{}：不支持的池 {}（可选 trae/buddy/buddy-ai/qoder/custom）",
                    g.id.trim(),
                    m.pool
                ));
            }
            if m.model.trim().is_empty() {
                return Err(format!("{}：{} 池成员模型名不能为空", g.id.trim(), pool));
            }
            if !pools.insert(pool) {
                return Err(format!("{}：{} 池重复配置（每池至多一个成员）", g.id.trim(), pool));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(id: &str, members: &[(&str, &str)]) -> AliasGroup {
        AliasGroup {
            id: id.to_string(),
            members: members
                .iter()
                .map(|(p, m)| AliasMember { pool: p.to_string(), model: m.to_string() })
                .collect(),
            note: String::new(),
            enabled: true,
        }
    }

    fn sample() -> AliasFile {
        AliasFile {
            groups: vec![group(
                "deepseek-v4-pro",
                &[("trae", "DeepSeek-V4-Pro-Official"), ("buddy", "deepseek-v4-pro")],
            )],
            updated_at: None,
        }
    }

    #[test]
    fn resolve_only_public_id() {
        let f = sample();
        assert_eq!(f.resolve("deepseek-v4-pro").unwrap().id, "deepseek-v4-pro");
        assert_eq!(f.resolve("DEEPSEEK-V4-PRO").unwrap().id, "deepseek-v4-pro", "对外 id 大小写不敏感");
        // 成员 id 不触发映射（自身请求保持原路由，零行为差异）
        assert!(
            f.resolve("DeepSeek-V4-Pro-Official").is_none(),
            "成员 id 不得触发同义组映射"
        );
        assert!(f.resolve("glm-5.3").is_none());
        let g = f.resolve("deepseek-v4-pro").unwrap();
        assert_eq!(g.member("trae"), Some("DeepSeek-V4-Pro-Official"));
        assert_eq!(g.member("buddy"), Some("deepseek-v4-pro"));
        assert_eq!(g.member("qoder"), None, "未列成员的池回退请求名");
    }

    #[test]
    fn disabled_group_is_ignored() {
        let mut f = sample();
        f.groups[0].enabled = false;
        assert!(f.resolve("deepseek-v4-pro").is_none());
    }

    #[test]
    fn validate_rejects_malformed() {
        // 对外 id 为空
        assert!(validate(&AliasFile {
            groups: vec![group("", &[("buddy", "a")])],
            updated_at: None,
        })
        .is_err());
        // 成员为空
        assert!(validate(&AliasFile { groups: vec![group("x", &[])], updated_at: None }).is_err());
        // 池非法
        assert!(validate(&AliasFile {
            groups: vec![group("x", &[("foo", "a")])],
            updated_at: None,
        })
        .is_err());
        // 同组同池重复
        assert!(validate(&AliasFile {
            groups: vec![group("x", &[("buddy", "a"), ("buddy", "b")])],
            updated_at: None,
        })
        .is_err());
        // 对外 id 冲突
        assert!(validate(&AliasFile {
            groups: vec![group("x", &[("buddy", "a")]), group("X", &[("trae", "b")])],
            updated_at: None,
        })
        .is_err());
        // 同一成员被多个组引用：允许（同一模型可起多个对外别名）
        assert!(validate(&AliasFile {
            groups: vec![group("x", &[("buddy", "a")]), group("y", &[("buddy", "A")])],
            updated_at: None,
        })
        .is_ok());
        assert!(validate(&sample()).is_ok());
    }
}
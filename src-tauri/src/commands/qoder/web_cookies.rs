//! WebView2 cookie 导出/注入（Qoder 官网会话持久化，Windows only）。
//!
//! 背景（2026-11-26 实测）：Webview 窗口的 cookie 默认只存在内存——账号数据目录
//! `qoder_web/accounts/<id>/EBWebView/Default/Network/` 下**没有 Cookies 文件**，
//! 采集成功立即关窗后登录态即丢失 → 每次采集都要重新登录。
//!
//! 方案：采集成功后用 WebView2 官方 `ICoreWebView2CookieManager` 导出
//! `qoder.com.cn` 域 cookie，DPAPI 加密后按账号落盘；下次采集/后台刷新前先注入，
//! 页面直接处于登录态（无需再次输入账号密码）。
//!
//! 安全：cookie 仅 DPAPI 加密落盘（`<data>/qoder_web/cookies/<账号>.bin`），
//! 不写日志、不回传前端、不进事件载荷。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 单条 cookie（仅保留注入所需字段；`value` 是登录凭据，禁止外泄）
#[derive(Clone, Serialize, Deserialize)]
pub struct CookieRec {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    /// 过期时间（Unix 秒，浮点；None = 会话 cookie）
    #[serde(default)]
    pub expires: Option<f64>,
}

fn store_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("qoder_web").join("cookies")
}

fn store_path(data_dir: &Path, account_id: &str) -> PathBuf {
    store_dir(data_dir).join(format!("{account_id}.bin"))
}

/// 加密落盘（DPAPI；空集合视为无凭据，不覆盖已有文件）
pub fn save(data_dir: &Path, account_id: &str, cookies: &[CookieRec]) -> Result<(), String> {
    if cookies.is_empty() {
        return Ok(());
    }
    let json = serde_json::to_vec(cookies).map_err(|e| format!("cookie 序列化失败: {e}"))?;
    let enc = crate::vault::dpapi::protect(&json)?;
    std::fs::create_dir_all(store_dir(data_dir))
        .map_err(|e| format!("cookie 目录创建失败: {e}"))?;
    let path = store_path(data_dir, account_id);
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, &enc).map_err(|e| format!("cookie 写入失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("cookie 落盘失败: {e}"))?;
    Ok(())
}

/// 读取（不存在/解密失败 → None，调用方走首次登录流程）
pub fn load(data_dir: &Path, account_id: &str) -> Option<Vec<CookieRec>> {
    let raw = std::fs::read(store_path(data_dir, account_id)).ok()?;
    let plain = crate::vault::dpapi::unprotect(&raw).ok()?;
    serde_json::from_slice::<Vec<CookieRec>>(&plain).ok()
}

/// 是否已有可复用的登录态（刷新按钮据此判断能否后台静默同步）
pub fn has(data_dir: &Path, account_id: &str) -> bool {
    store_path(data_dir, account_id).exists()
}

#[cfg(windows)]
mod win {
    use super::CookieRec;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, GetCookiesCompletedHandler};
    use windows::core::{Interface, BOOL, HSTRING, PWSTR};

    unsafe fn cookie_manager(
        pw: &tauri::webview::PlatformWebview,
    ) -> Option<ICoreWebView2CookieManager> {
        let controller = pw.controller();
        let core = controller.CoreWebView2().ok()?;
        let core2: ICoreWebView2_2 = core.cast().ok()?;
        core2.CookieManager().ok()
    }

    unsafe fn to_rec(c: &ICoreWebView2Cookie) -> Option<CookieRec> {
        // ICoreWebView2Cookie 的属性是 out 参数风格（Name/Value/Domain/Path/Expires/IsXXX）
        let mut name = PWSTR::null();
        let mut value = PWSTR::null();
        let mut domain = PWSTR::null();
        let mut path = PWSTR::null();
        c.Name(&mut name).ok()?;
        c.Value(&mut value).ok()?;
        c.Domain(&mut domain).ok()?;
        c.Path(&mut path).ok()?;
        let mut secure = BOOL::default();
        let mut http_only = BOOL::default();
        let _ = c.IsSecure(&mut secure);
        let _ = c.IsHttpOnly(&mut http_only);
        let mut expires = 0f64;
        let _ = c.Expires(&mut expires);
        Some(CookieRec {
            name: take_pwstr(name),
            value: take_pwstr(value),
            domain: take_pwstr(domain),
            path: take_pwstr(path),
            secure: secure.as_bool(),
            http_only: http_only.as_bool(),
            expires: (expires.is_finite() && expires > 0.0).then_some(expires),
        })
    }

    /// 导出指定 URL 的 cookie（异步 API → 槽位 + 后台轮询；不阻塞 UI 线程防消息循环死锁）
    pub fn export(window: &WebviewWindow, url: &str) -> Result<Vec<CookieRec>, String> {
        let slot: Arc<Mutex<Option<Vec<CookieRec>>>> = Arc::new(Mutex::new(None));
        let slot2 = slot.clone();
        let url = url.to_string();
        window
            .with_webview(move |pw| unsafe {
                let Some(manager) = cookie_manager(&pw) else { return };
                let handler = GetCookiesCompletedHandler::create(Box::new(move |hr, list| {
                    let mut out: Vec<CookieRec> = Vec::new();
                    if hr.is_ok() {
                        if let Some(list) = list {
                            let mut count = 0u32;
                            if list.Count(&mut count).is_ok() {
                                for i in 0..count {
                                    if let Ok(c) = list.GetValueAtIndex(i) {
                                        if let Some(r) = to_rec(&c) {
                                            out.push(r);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if let Ok(mut g) = slot2.lock() {
                        *g = Some(out);
                    }
                    Ok(())
                }));
                let uri = HSTRING::from(url.as_str());
                let _ = manager.GetCookies(&uri, &handler);
            })
            .map_err(|e| format!("导出 cookie 失败: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Some(v) = slot.lock().ok().and_then(|g| g.clone()) {
                return Ok(v);
            }
            std::thread::sleep(Duration::from_millis(80));
        }
        Err("导出 cookie 超时（窗口可能已关闭）".into())
    }

    /// 注入 cookie（同步 AddOrUpdateCookie；应在页面导航前调用）
    pub fn inject(window: &WebviewWindow, cookies: &[CookieRec]) -> Result<usize, String> {
        let added = Arc::new(AtomicUsize::new(0));
        let added2 = added.clone();
        let cookies: Vec<CookieRec> = cookies.to_vec();
        window
            .with_webview(move |pw| unsafe {
                let Some(manager) = cookie_manager(&pw) else { return };
                for c in &cookies {
                    let Ok(cookie) = manager.CreateCookie(
                        &HSTRING::from(c.name.as_str()),
                        &HSTRING::from(c.value.as_str()),
                        &HSTRING::from(c.domain.as_str()),
                        &HSTRING::from(c.path.as_str()),
                    ) else {
                        continue;
                    };
                    let _ = cookie.SetIsHttpOnly(c.http_only);
                    let _ = cookie.SetIsSecure(c.secure);
                    if let Some(exp) = c.expires {
                        let _ = cookie.SetExpires(exp);
                    }
                    if manager.AddOrUpdateCookie(&cookie).is_ok() {
                        added2.fetch_add(1, Ordering::SeqCst);
                    }
                }
            })
            .map_err(|e| format!("注入 cookie 失败: {e}"))?;
        Ok(added.load(Ordering::SeqCst))
    }
}

#[cfg(windows)]
pub use win::{export, inject};

#[cfg(not(windows))]
pub fn export(_window: &tauri::WebviewWindow, _url: &str) -> Result<Vec<CookieRec>, String> {
    Err("仅支持 Windows".into())
}

#[cfg(not(windows))]
pub fn inject(_window: &tauri::WebviewWindow, _cookies: &[CookieRec]) -> Result<usize, String> {
    Err("仅支持 Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_store_roundtrip_is_encrypted() {
        let dir = std::env::temp_dir().join(format!("qoder_cookie_store_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cookies = vec![CookieRec {
            name: "qoder_session_cookie".into(),
            value: "secret-value".into(),
            domain: ".qoder.com.cn".into(),
            path: "/".into(),
            secure: true,
            http_only: true,
            expires: Some(1_800_000_000.0),
        }];
        // 非 Windows 上 DPAPI 不可用 → save 返回 Err，跳过断言
        if save(&dir, "qd-test", &cookies).is_ok() {
            let loaded = load(&dir, "qd-test").expect("应能解密读回");
            assert_eq!(loaded.len(), 1);
            assert_eq!(loaded[0].name, "qoder_session_cookie");
            assert_eq!(loaded[0].value, "secret-value");
            assert!(has(&dir, "qd-test"));
            // 落盘内容不得为明文
            let raw = std::fs::read(store_dir(&dir).join("qd-test.bin")).unwrap();
            assert!(
                !raw.windows(12).any(|w| w == b"secret-value"),
                "cookie 值不得明文落盘"
            );
        }
        assert!(load(&dir, "missing").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
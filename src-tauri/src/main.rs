// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod checkin_results;
mod device_proxy;
mod doubao_checkin_results;
mod events;
mod fs_utils;
mod icube_auth;
mod jwt;
mod models;
mod notify;
mod pe_version;
mod state;
mod store;
mod switcher;
mod tasks;
mod vault;
mod api_server;
mod workbuddy_atrest;
mod workbuddy_cli;

use state::AppState;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// 托盘菜单句柄：API 网关与代理启停项文本随服务状态动态切换
///（API 由 api_server::sync_tray_api_text 同步；代理由 proxy::sync_tray_proxy_text 同步）
pub struct TrayMenu {
    pub api_item: MenuItem<tauri::Wry>,
    pub proxy_item: MenuItem<tauri::Wry>,
}

/// 主窗口最大化状态记忆（issue #46）：无边框窗口（decorations:false）在最大化状态下
/// 经 hide→show 后，Win32 层 WS_MAXIMIZE 样式与 Tauri 内部状态可能失同步——窗口视觉上
/// 已还原但 isMaximized() 仍返回 true，此时 toggleMaximize 实际执行 unmaximize（空操作），
/// 表现为「窗口无法最大化」。
///
/// 同时记录隐藏时的外框尺寸（最大化尺寸）用于判定是否**真的**失同步：尺寸与隐藏时
/// 一致 = 状态与视觉同步，无需重建。原实现无条件 unmaximize→maximize，会让窗口在
/// 用户眼前从还原尺寸弹回最大化（缩放闪烁），体验很差。
pub struct MainWindowMaximized {
    pub maximized: std::sync::atomic::AtomicBool,
    /// 隐藏时外框尺寸（物理像素，w << 32 | h；0 表示未记录）
    pub outer_size: std::sync::atomic::AtomicU64,
}

/// 主窗口「首帧就绪」闸门（冷启动防白闪）：
/// 建窗阶段绝不调用 `maximized`/`show`，等前端把首屏骨架真正画到屏幕上后调用
/// `main_window_ready` 命令，才最大化 + 显示——用户看到的第一帧就是启动页内容。
pub struct MainWindowReveal {
    /// 是否已经显示过（一次性闸门，多路径触发只生效第一次）
    pub shown: std::sync::atomic::AtomicBool,
    /// 启动即最小化到托盘：保持隐藏，由托盘图标显示
    pub minimized: std::sync::atomic::AtomicBool,
    /// 「逻辑最大化」：启动时窗口直接以工作区尺寸建出、未调用 Win32 maximize，
    /// 故 `is_maximized()` 为假。标题栏图标与托盘恢复逻辑需要真实语义，
    /// 这里显式记一份——由前端 `maximize` 类操作与还原操作同步（见 window_state 命令）。
    pub logically_maximized: std::sync::atomic::AtomicBool,
}

/// 关闭本窗口的 DWM 过渡动画（`DWMWA_TRANSITIONS_FORCEDISABLED`）。
///
/// 这是冷启动「尺寸跳变一闪」的根因：窗口建出来是 1180×760，调用 `maximize()`
/// 时 Windows 会对「还原 → 最大化」的尺寸变化播放一段 DWM 过渡动画（约 200ms 的
/// 从小到大扩张），期间窗口内容被重采样/清屏，肉眼就是一次闪动。
/// 禁用过渡后最大化瞬时生效，用户直接看到最大化的完整启动页。
/// 必须在 `maximize()` **之前**调用，且只对本进程主窗口生效（不影响其它程序）。
#[cfg(target_os = "windows")]
fn disable_window_transitions(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
    };
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    // tauri 的 HWND 来自 windows crate（isize 新类型）；windows-sys 的 HWND 是
    // `*mut c_void` 类型别名，直接转裸指针传入即可。
    let hwnd = hwnd.0 as *mut core::ffi::c_void;
    let disabled: i32 = 1;
    // SAFETY: hwnd 来自 Tauri 的有效窗口句柄；属性值是指向 i32 的有效指针，
    // 长度与实际类型（BOOL）一致。失败仅意味着过渡未被禁用，不影响功能。
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED as u32,
            &disabled as *const i32 as *const core::ffi::c_void,
            std::mem::size_of::<i32>() as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn disable_window_transitions(_window: &tauri::WebviewWindow) {}

/// 把窗口直接调整到「主显示器工作区」大小并贴到工作区左上角（物理像素）。
///
/// 冷启动「尺寸跳变闪一下」的真正机制：窗口先以 1180×760 建出来，WebView2 在这个
/// 尺寸下完成首次布局与光栅化；随后 `maximize()` 把它放大到工作区 —— 放大瞬间
/// 新增区域还没有内容，合成器先清一遍底再重绘，肉眼就是「从小尺寸撑到全屏时闪一下」。
/// 只禁 DWM 过渡动画消不掉这一帧重绘（动画只是被跳过了，重绘依然发生）。
///
/// 因此这里在**页面加载前**（窗口仍隐藏）就把几何设成最终工作区尺寸：页面从头到尾
/// 只在最终尺寸下渲染一次，后面的 `maximize()` 因为尺寸已经等于工作区而不产生任何
/// 尺寸变化，也就没有多余的重绘。
///
/// 失败时保持构建尺寸（不影响可用性，只是可能仍有一次极短重绘）。
fn size_to_work_area(window: &tauri::WebviewWindow) {
    // 优先当前窗口所在显示器，取不到退回主显示器（冷启动时窗口通常在主屏）
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let wa = monitor.work_area();
    let (x, y) = (wa.position.x, wa.position.y);
    let (w, h) = (wa.size.width, wa.size.height);
    if w == 0 || h == 0 {
        return;
    }
    let _ = window.set_size(tauri::PhysicalSize::new(w, h));
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 窗口是否已经铺满所在显示器的工作区（尺寸容差 8px，吸收 DPI 取整差异）。
/// 为真时无需再 `maximize()`，避免无谓的 WM_SIZE 重排。
fn window_fills_work_area(window: &tauri::WebviewWindow) -> bool {
    let (Ok(size), Ok(pos)) = (window.outer_size(), window.outer_position()) else {
        return false;
    };
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return false;
    };
    let wa = monitor.work_area();
    let tol = MAXIMIZED_SIZE_TOLERANCE_PX;
    size.width.abs_diff(wa.size.width) <= tol
        && size.height.abs_diff(wa.size.height) <= tol
        && pos.x.abs_diff(wa.position.x) <= tol
        && pos.y.abs_diff(wa.position.y) <= tol
}

/// 一次性显示主窗口（最大化 + 聚焦）。返回是否本次真正执行了显示。
fn reveal_main_window(app: &tauri::AppHandle) -> bool {
    let Some(gate) = app.try_state::<MainWindowReveal>() else {
        return false;
    };
    if gate.minimized.load(std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    // swap 保证只显示一次（前端握手与兜底超时可能同时到）
    if gate.shown.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return false;
    }
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    // 关键顺序：① 再确认禁用 DWM 过渡（兜底/握手两条路径都会走到这里）；
    // ② 若几何还不是工作区尺寸（显示器在启动后才接上等），先补一次；
    // ③ 尺寸已等于工作区时**不再调 maximize()** —— 那会在同尺寸上再触发一次
    //    WM_SIZE/重排，正是「最后一跳」的来源；只有尺寸确实不同才最大化；
    // ④ 最后显示。
    disable_window_transitions(&window);
    size_to_work_area(&window);
    let fills = window_fills_work_area(&window);
    if !fills {
        let _ = window.maximize();
    }
    // 记录「逻辑最大化」：尺寸已铺满工作区但未走 Win32 maximize 时，前端
    // `isMaximized()` 会返回 false（标题栏图标错误、首次点击无效）。
    // 前端 TitleBar 经 `window_logically_maximized` 命令读取该标记来修正图标；
    // 用户手动还原/最大化时由 `window_logical_zoom_set` 同步，二者共同维护。
    if let Some(gate) = app.try_state::<MainWindowReveal>() {
        gate.logically_maximized
            .store(fills, std::sync::atomic::Ordering::SeqCst);
    }
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }
    let _ = window.set_focus();
    true
}

/// 查询「逻辑最大化」标记：启动时直接以工作区尺寸建窗，未走 Win32 maximize，
/// 前端据此修正标题栏图标与首次点击行为。
#[tauri::command]
fn window_logically_maximized(app: tauri::AppHandle) -> bool {
    app.try_state::<MainWindowReveal>()
        .map(|g| g.logically_maximized.load(std::sync::atomic::Ordering::SeqCst))
        .unwrap_or(false)
}

/// 前端还原/最大化后同步「逻辑最大化」标记（含手动拖动改变尺寸的情形）。
#[tauri::command]
fn window_logical_zoom_set(app: tauri::AppHandle, maximized: bool) {
    if let Some(gate) = app.try_state::<MainWindowReveal>() {
        gate.logically_maximized
            .store(maximized, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 前端首帧就绪回调：`main.tsx` 在启动页骨架绘制完成后 invoke。
/// 语义 = 「现在显示窗口，用户看到的就是这一帧」。
#[tauri::command]
fn main_window_ready(app: tauri::AppHandle) -> bool {
    reveal_main_window(&app)
}

/// 外框尺寸比对容差（物理像素）：同一个最大化窗口隐藏前后只可能有 DPI 取整级差异
const MAXIMIZED_SIZE_TOLERANCE_PX: u32 = 8;

/// 隐藏前后外框尺寸是否一致：隐藏时记录的是最大化尺寸，show 前若明显变小即说明
/// 视觉已还原而状态仍称最大化（issue #46 失同步形态）；未记录时视为一致。
fn size_matches_recorded(hidden_size: u64, w: u32, h: u32) -> bool {
    if hidden_size == 0 {
        return true; // 无记录：不做无谓重建
    }
    let (rw, rh) = ((hidden_size >> 32) as u32, hidden_size as u32);
    w.abs_diff(rw) <= MAXIMIZED_SIZE_TOLERANCE_PX && h.abs_diff(rh) <= MAXIMIZED_SIZE_TOLERANCE_PX
}

/// 隐藏主窗口到托盘：hide 前记录最大化状态与外框尺寸（issue #46）。返回是否找到主窗口。
fn hide_main_window(app: &tauri::AppHandle) -> bool {
    if let Some(window) = app.get_webview_window("main") {
        let maximized = window.is_maximized().unwrap_or(false);
        let packed_size = window
            .outer_size()
            .map(|s| ((s.width as u64) << 32) | s.height as u64)
            .unwrap_or(0);
        if let Some(flag) = app.try_state::<MainWindowMaximized>() {
            flag.maximized
                .store(maximized, std::sync::atomic::Ordering::Relaxed);
            flag.outer_size
                .store(packed_size, std::sync::atomic::Ordering::Relaxed);
        }
        let _ = window.hide();
        true
    } else {
        false
    }
}

/// 「记录为最大化」的窗口在 show 前是否失同步：is_maximized() 为假（需重新最大化），
/// 或为真但外框尺寸与隐藏时记录的最大化尺寸明显不符（视觉已还原）。
/// 尺寸一致时返回 false，跳过 unmaximize→maximize，避免可见的缩放闪烁。
fn maximized_state_desynced(window: &tauri::WebviewWindow, hidden_size: u64) -> bool {
    if !window.is_maximized().unwrap_or(false) {
        return true;
    }
    match window.outer_size() {
        Ok(s) => !size_matches_recorded(hidden_size, s.width, s.height),
        Err(_) => false,
    }
}

/// 窗口几何失效判定阈值（issue #183）：与任一显示器工作区的交叠区域宽高均不足
/// 150 物理像素即视为不可用——涵盖「窗口整体落在已断开的显示器坐标上」
/// 和「仅露出一条边」（任务栏缩略图呈一条线）两种休眠唤醒后的典型损坏形态
const MIN_VISIBLE_PX: i32 = 150;

/// 尺寸退化判定阈值（物理像素）：正常 resize 受 minWidth/minHeight（960x600 逻辑）
/// 约束，物理宽高不可能低于此值；低于即视为几何损坏
const MIN_SIZE_PX: u32 = 200;

/// 显示器几何快照（物理像素）：纯数据结构便于单测（tauri::Monitor 无法在测试中构造）
struct MonitorGeom {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    scale: f64,
}

impl MonitorGeom {
    fn from_monitor(m: &tauri::Monitor) -> Self {
        let wa = m.work_area();
        Self {
            x: wa.position.x,
            y: wa.position.y,
            w: wa.size.width as i32,
            h: wa.size.height as i32,
            scale: m.scale_factor(),
        }
    }
}

/// 窗口矩形与显示器工作区矩形的交叠宽高（无交叠时对应维为负值）
fn overlap_dims(wx: i32, wy: i32, ww: i32, wh: i32, m: &MonitorGeom) -> (i32, i32) {
    (
        (wx + ww).min(m.x + m.w) - wx.max(m.x),
        (wy + wh).min(m.y + m.h) - wy.max(m.y),
    )
}

/// 几何有效性纯判定：尺寸非退化，且与任一显示器工作区交叠宽高均 ≥ MIN_VISIBLE_PX
fn geometry_valid(wx: i32, wy: i32, ww: i32, wh: i32, monitors: &[MonitorGeom]) -> bool {
    if ww < MIN_SIZE_PX as i32 || wh < MIN_SIZE_PX as i32 {
        return false;
    }
    monitors.iter().any(|m| {
        let (dw, dh) = overlap_dims(wx, wy, ww, wh, m);
        dw >= MIN_VISIBLE_PX && dh >= MIN_VISIBLE_PX
    })
}

/// 校验窗口几何是否有效：尺寸非退化，且与任一显示器工作区有足够交叠。
/// 枚举显示器失败时不误伤（返回 true），交由原有的最大化重建逻辑兜底。
fn window_geometry_valid(window: &tauri::WebviewWindow) -> bool {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return false;
    };
    if size.width < MIN_SIZE_PX || size.height < MIN_SIZE_PX {
        return false;
    }
    let Ok(monitors) = window.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }
    let geoms: Vec<MonitorGeom> = monitors.iter().map(MonitorGeom::from_monitor).collect();
    geometry_valid(pos.x, pos.y, size.width as i32, size.height as i32, &geoms)
}

/// 几何失效后的修复（issue #183，审查问题 1/2/3）：保留用户尺寸，仅把窗口
/// 平移回「交叠面积最大（无交叠时中心距离最近）」的显示器工作区内并钳制可见；
/// 尺寸退化（一条线）时才按目标显示器 DPI 重置默认尺寸。全程物理坐标，
/// 无跨 DPI 换算不一致；工作区对齐 Tauri 启动居中行为（不遮挡任务栏）。
/// 目标显示器纯选择：交叠面积最大者；全部无交叠（如窗口挂在已断开的显示器上）
/// 时取中心距离最近者（调用方保证 monitors 非空）
fn pick_best_monitor<'a>(
    wx: i32,
    wy: i32,
    ww: i32,
    wh: i32,
    monitors: &'a [MonitorGeom],
) -> &'a MonitorGeom {
    monitors
        .iter()
        .max_by_key(|m| {
            let (dw, dh) = overlap_dims(wx, wy, ww, wh, m);
            let area = (dw.max(0) as i64) * (dh.max(0) as i64);
            let (dx, dy) = (wx + ww / 2 - (m.x + m.w / 2), wy + wh / 2 - (m.y + m.h / 2));
            let dist = (dx as i64) * (dx as i64) + (dy as i64) * (dy as i64);
            (area, -dist)
        })
        .expect("调用方保证 monitors 非空")
}

/// 修复后几何纯计算（物理像素 x, y, w, h）：保留用户尺寸并钳制到工作区；
/// 仅退化时按目标显示器 DPI 重置默认尺寸；nw ≤ mw 保证 clamp 区间合法
fn repaired_geometry(
    wx: i32,
    wy: i32,
    ww: i32,
    wh: i32,
    m: &MonitorGeom,
) -> (i32, i32, u32, u32) {
    let (nw, nh) = if ww < MIN_SIZE_PX as i32 || wh < MIN_SIZE_PX as i32 {
        (
            ((1180.0 * m.scale) as i32).min(m.w),
            ((760.0 * m.scale) as i32).min(m.h),
        )
    } else {
        (ww.min(m.w), wh.min(m.h))
    };
    // 位置：原坐标钳制进工作区，保留用户相对摆放
    let x = wx.clamp(m.x, m.x + m.w - nw);
    let y = wy.clamp(m.y, m.y + m.h - nh);
    (x, y, nw as u32, nh as u32)
}

fn repair_window_geometry(window: &tauri::WebviewWindow) {
    // API 失败（Windows 上实际不可达，tao 对 GetWindowRect 失败直接 panic）
    // 时的最后兜底：默认尺寸 + 居中
    let fallback = || {
        let _ = window.set_size(tauri::LogicalSize::new(1180.0, 760.0));
        let _ = window.center();
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        fallback();
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        fallback();
        return;
    };
    if monitors.is_empty() {
        fallback();
        return;
    }
    let geoms: Vec<MonitorGeom> = monitors.iter().map(MonitorGeom::from_monitor).collect();
    let (wx, wy, ww, wh) = (pos.x, pos.y, size.width as i32, size.height as i32);
    let best = pick_best_monitor(wx, wy, ww, wh, &geoms);
    let (x, y, nw, nh) = repaired_geometry(wx, wy, ww, wh, best);
    let _ = window.set_size(tauri::PhysicalSize::new(nw, nh));
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// 显示主窗口：unminimize + show + set_focus。修复动作全部在 show 之前完成
/// （窗口仍隐藏，用户看不到中间过程），避免从托盘恢复时出现「尺寸由小到大」的闪烁：
/// - 几何失效（休眠唤醒/显示器变更后落到屏外或尺寸退化）→ 平移回最近显示器工作区
///   并保留用户尺寸（issue #183：任务栏有图标但主页面无法显示、缩略图只有一条线）；
/// - 隐藏前为最大化但状态/视觉已失同步（issue #46 / #211）→ 才 unmaximize→maximize 重建。
///   重建必须先于 show：窗口隐藏时 tao 跳过 ShowWindow（无 SW_MAXIMIZE/SW_RESTORE 动画），
///   仅更新 Win32 样式与内部标志；若在 show 之后重建，用户会看到窗口先以还原尺寸出现、
///   再跳变最大化——即「每次从托盘打开界面闪一下」。
///   本地实现额外用「外框尺寸比对」判定是否**真的**失同步（状态与尺寸都正常时不再重建，
///   原实现无条件重建正是缩放闪烁的来源）。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let (was_maximized, hidden_size) = app
            .try_state::<MainWindowMaximized>()
            .map(|f| {
                (
                    f.maximized.load(std::sync::atomic::Ordering::Relaxed),
                    f.outer_size.load(std::sync::atomic::Ordering::Relaxed),
                )
            })
            .unwrap_or((false, 0));
        let _ = window.unminimize();
        if !window_geometry_valid(&window) {
            if let Some(st) = app.try_state::<AppState>() {
                fs_utils::app_log(
                    &st.data_dir,
                    "显示主窗口：检测到窗口几何失效（疑似休眠唤醒/显示器变更），已平移回最近显示器工作区",
                );
            }
            let _ = window.unmaximize();
            repair_window_geometry(&window);
        }
        // 仅在确实失同步时重建最大化，且重建发生在 show 之前：窗口仍隐藏，
        // 中间的「还原尺寸」不会被用户看到（issue #46 + #211 + 托盘恢复缩放闪烁）
        if was_maximized && maximized_state_desynced(&window, hidden_size) {
            if let Some(st) = app.try_state::<AppState>() {
                fs_utils::app_log(
                    &st.data_dir,
                    "显示主窗口：最大化状态失同步，show 前重建（避免可见缩放）",
                );
            }
            let _ = window.unmaximize();
            let _ = window.maximize();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 启动页底色判定：与前端 `lib/themes.ts::resolveTheme` 口径保持一致
/// （具体主题按自身明暗；`light`/`dark` 兼容旧值；`system`/空 → 跟随系统；
///  其余未知非空值在前端回退默认主题「炭黑」= 深色）。
fn splash_prefers_dark(theme: &str) -> bool {
    match theme.trim() {
        "graphite" | "light" => false,
        "charcoal" | "dark" | "violet-night" | "ink-green" | "amber-night" | "tech-blue" => true,
        "" | "system" => system_prefers_dark(),
        _ => true,
    }
}

/// 系统是否偏好深色（Windows：`AppsUseLightTheme` DWORD，0=深色）。
/// 读不到时按浅色（Windows 默认）——仅影响首帧背景色，不影响主题本身。
#[cfg(target_os = "windows")]
fn system_prefers_dark() -> bool {
    use windows_registry::CURRENT_USER;
    CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .ok()
        .and_then(|k| k.get_u32("AppsUseLightTheme").ok())
        .map(|light| light == 0)
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn system_prefers_dark() -> bool {
    true
}

/// 启动页底色（窗口层 + WebView 层共用）：浅色 `slate-50` / 深色 `zinc-950`。
/// 必须与 `index.html` 内联骨架的 `--bs-page`（`#f8fafc` / `#09090b`）保持一致，
/// 否则「空白窗口 → 启动页」之间会出现一次跳色。
fn splash_background(theme: &str) -> tauri::window::Color {
    if splash_prefers_dark(theme) {
        tauri::window::Color(9, 9, 11, 255)
    } else {
        tauri::window::Color(248, 250, 252, 255)
    }
}

/// 全局 panic hook（issue #224）：GUI 子系统（windows_subsystem="windows"）无 stderr，
/// panic 默认 hook 的输出全部丢弃——表现为「app.log 戛然而止、无任何错误提示」的
/// 无声崩溃。abort（panic 跨 FFI 边界无法 unwind 被强制 abort、double panic）前
/// 也会先过本 hook，留痕后再终止，可观测性对 0xc0000409 类崩溃是唯一线索。
/// 记录：线程名 + panic 位置 + 消息 + 强制 backtrace（release 无 PDB 时仍含
/// 帧地址，可与报告的异常偏移直接对应做符号化）。CLI 任务模式（--task-run）
/// 与 GUI 共用本入口，一并覆盖。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let msg = info
            .payload()
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| info.payload().downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_else(|| "<non-string payload>".to_string());
        // 审查修复（#224 跟进）：先落 app.log 再打 stderr——stderr 句柄存在但无效时
        // print 宏写失败会在 hook 内二次 panic → double panic abort，若文件先落盘
        // 则线索不丢；日志写入自身全吞错（fs_utils::app_log 无 panic 路径）
        fs_utils::app_log_default(&format!("[PANIC] thread={thread} loc={loc} msg={msg}"));
        eprintln!("[PANIC] thread={thread} loc={loc} msg={msg}");
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        if !bt.trim().is_empty() {
            fs_utils::app_log_default(&format!("[PANIC] backtrace:\n{bt}"));
            eprintln!("[PANIC] backtrace:\n{bt}");
        }
    }));
}

fn main() {
    // 全局 panic hook 必须最先安装（在任何可能 panic 的初始化之前），兜底观测
    // 窗口覆盖整个进程生命周期（含 CLI 任务模式与 migrate 阶段）
    install_panic_hook();

    // issue #224：TLS 加密后端进程默认收敛到 ring（纯 Rust）——rustls 0.23 默认
    // provider 是 aws-lc-rs（C 代码），内部错误直接 abort → 0xc0000409/0x7 无声崩溃；
    // ring 路径异常为可捕获的 Rust panic。install_default 仅首次生效，幂等；
    // 失败（如未来依赖在更早阶段抢先安装了非 ring provider）时告警留痕，
    // 避免 TLS 收敛目标静默退化（rcgen CA 签发的 KeyPair 不走 rustls provider，
    // 仍由 aws_lc_rs 承担，不受影响）
    if let Err(e) = tokio_rustls::rustls::crypto::ring::default_provider().install_default() {
        let msg = format!("[TLS] ring provider 安装失败，进程默认 provider 已被抢占: {e:?}");
        eprintln!("{msg}");
        fs_utils::app_log_default(&msg);
    }

    // 品牌迁移（老版本 Trae Work Assistant → AI Work 助手）：
    // 必须在 AppState::new 创建新数据目录之前执行；迁移为「复制」语义，
    // 旧数据目录原地保留（老应用可继续使用，两版并存），已迁移过则自动跳过
    let migrate_note = state::migrate_legacy_dirs();

    let state = match AppState::new() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("初始化失败: {e}");
            std::process::exit(1);
        }
    };

    // CLI 任务模式（D2）：schtasks 计划任务直调主 exe（`--task-run <name>`），
    // 执行完任务即退出；分支在 Builder 之前，天然绕开单实例插件，不启动 GUI。
    // Python 运行时移除后计划任务链依赖此入口（原 python 脚本直调的替代）。
    if let Some(task) = tasks::parse_task_mode(&std::env::args().collect::<Vec<_>>()) {
        std::process::exit(tasks::run_cli_task(&task, &state));
    }

    if let Some(note) = &migrate_note {
        fs_utils::app_log(&state.data_dir, note);
        eprintln!("{note}");
    }

    // 旧版计划任务迁移（并存语义）：按旧任务触发时间重建 AIWorkAssistant_DailyCheckin，
    // 旧任务保留供老应用继续使用；任何一步失败都静默跳过
    if let Some(note) = commands::misc::try_migrate_legacy_task() {
        fs_utils::app_log(&state.data_dir, &note);
    }
    // 计划任务 /TR 现代化迁移（issue #112）：历史 `cmd /c set … &&` 包裹与豆包 .cmd
    // 启动器在 Task Scheduler 触发时必弹黑框（cmd.exe 是控制台程序），后台线程一次性
    // 重建为主 exe 直调（GUI 子系统，无控制台）。部分失败不置位完成标记，下次启动重试。
    // 后台执行：任务枚举 + 逐任务 XML 查询可达数秒，不阻塞启动（取代原 PS 桥启动器迁移）。
    // 先延迟 120s 再扫描：迁移链路会 spawn cmd/schtasks 控制台程序，开机自启登录早期
    // spawn 控制台程序可能撞系统初始化窗口期报 0xc0000142（issue #137 同类风险）；
    // 迁移有一次性完成标记兜底，失败不置位、下次启动自动重试，故延迟无功能损害
    {
        let data_dir = state.data_dir.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(120));
            if let Some(note) = commands::misc::try_migrate_cmd_wrapped_tasks(&data_dir) {
                fs_utils::app_log(&data_dir, &note);
            }
        });
    }
    // OAuth 代理直连豁免崩溃残留清理（F-78 批次 2/缺陷13）：上次进程异常退出
    // 未还原 ProxyOverride 时，按标记文件只移除本软件追加的条目（无标记幂等空操作）
    device_proxy::bypass::cleanup_residual_bypass(&state.data_dir);

    // 单实例防护（仅正式版）：第二个进程启动时，本回调在首个实例中执行——把主窗口
    // 还原/显示/聚焦后，第二进程由插件自动退出。必须第一个注册（在创建窗口前持有互斥锁）。
    // dev 模式不启用：dev 与已安装版共用 identifier，启用会导致 `npm run tauri dev`
    // 与已安装应用互相顶替退出，干扰开发调试。
    #[cfg_attr(debug_assertions, allow(unused_mut))] // dev 不注册单实例插件
    let mut builder = tauri::Builder::default();
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
            if let Some(state) = app.try_state::<AppState>() {
                fs_utils::app_log(&state.data_dir, "检测到重复启动：已聚焦已有实例窗口");
            }
        }));
    }

    let app = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(state)
        .manage(MainWindowMaximized {
            maximized: std::sync::atomic::AtomicBool::new(false),
            outer_size: std::sync::atomic::AtomicU64::new(0),
        })
        .manage(MainWindowReveal {
            shown: std::sync::atomic::AtomicBool::new(false),
            minimized: std::sync::atomic::AtomicBool::new(false),
            logically_maximized: std::sync::atomic::AtomicBool::new(false),
        })
        .manage(Mutex::new(Option::<commands::api_server::ApiServerRuntime>::None))
        .manage(commands::checkin::CheckinGuard(tokio::sync::Mutex::new(())))
        .invoke_handler(tauri::generate_handler![
            commands::env::app_locate,
            commands::env::open_doubao_app,
            commands::env::open_trae_website,
            commands::env::env_check_trae_cn,
            commands::env::open_trae_cn_app,
            commands::env::open_workbuddy_app,
            commands::env::open_codebuddy_app,
            commands::env::open_workbuddy_ai_app,
            commands::env::open_codebuddy_ai_app,
            commands::env::codebuddy_env_check,
            commands::cert::cert_status,
            commands::cert::cert_install,
            commands::cert::cert_open_folder,
            commands::proxy::proxy_start,
            commands::proxy::proxy_stop,
            commands::proxy::proxy_status,
            commands::accounts::accounts_list,
            commands::accounts::accounts_export_raw,
            commands::accounts::accounts_import,
            commands::accounts::accounts_import_preview,
            commands::accounts::account_add_manual,
            commands::accounts::account_delete,
            commands::accounts::account_update,
            commands::accounts::account_get_jwt,
            commands::accounts::groups_list,
            commands::accounts::group_create,
            commands::accounts::group_update,
            commands::accounts::group_delete,
            commands::accounts::group_move,
            commands::shared_groups::shared_groups_list,
            commands::shared_groups::shared_groups_create,
            commands::shared_groups::shared_groups_update,
            commands::shared_groups::shared_groups_delete,
            commands::tags::tags_list,
            commands::tags::tags_create,
            commands::tags::tags_update,
            commands::tags::tags_delete,
            commands::tags::account_tags_set,
            commands::tags::account_tags_map,
            commands::api_server::api_keys_org_preview,
            commands::accounts::fetch_remaining_credits,
            commands::accounts::fetch_credit_detail,
            commands::accounts::refresh_remaining_credits,
            commands::accounts::credits_daily_list,
            commands::accounts::cooldown_clear,
            commands::accounts::cooldown_clear_all,
            commands::accounts::refresh_jwt,
            commands::accounts::renew_jwt_preflight,
            commands::checkin::checkin_start,
            commands::checkin::checkin_trends,
            commands::checkin::checkin_device_conflicts,
            commands::switch::switch_account,
            commands::switch::save_current_login,
            commands::switch::reset_device_ids,
            commands::misc::device_reset,
            commands::misc::autostart_status,
            commands::misc::autostart_set,
            commands::misc::jwt_parse,
            commands::misc::logs_query,
            commands::misc::logs_clear,
            commands::misc::startup_notice_take,
            commands::misc::traework_migration_guide,
            commands::misc::traework_migration_guide_dismiss,
            commands::misc::settings_get,
            commands::misc::settings_set,
            commands::misc::notify_test,
            commands::misc::notify_last_result_get,
            commands::misc::invite_link,
            commands::misc::credits_history,
            commands::misc::task_register,
            commands::misc::task_status,
            commands::misc::task_unregister,
            commands::misc::proxy_logs_list,
            commands::misc::proxy_log_detail,
            commands::misc::write_text_file,
            commands::misc::read_text_file,
            // issue #46：前端「最小化到托盘」走此命令，hide 前记录最大化状态
            commands::misc::minimize_to_tray,
            commands::api_server::api_server_start,
            commands::api_server::api_server_stop,
            commands::api_server::api_server_status,
            commands::api_server::pool_list,
            commands::api_server::pool_set,
            commands::api_server::pool_status,
            commands::api_server::wb_pool_status,
            commands::api_server::qoder_pool_status,
            commands::api_server::buddy_ai_pool_status,
            commands::api_server::qoder_catalog_sync,
            commands::api_server::api_logs_list,
            commands::api_server::api_logs_detail,
            commands::api_server::api_logs_search,
            commands::api_server::api_logs_recent,
            commands::api_server::api_debug_toggle,
            commands::api_server::api_debug_status,
            commands::api_server::api_models_list,
            commands::api_server::api_models_sync,
            commands::api_server::api_usage_stats,
            commands::api_server::api_wb_usage_stats,
            commands::api_server::api_buddy_ai_usage_stats,
            commands::api_server::api_custom_usage_stats,
            commands::api_server::api_qoder_usage_stats,
            commands::api_server::api_keys_list,
            commands::api_server::api_keys_save,
            commands::api_server::api_wb_catalog_sync,
            commands::api_server::api_wb_catalog_list,
            // Buddy 国际版（buddy-ai）模型目录（阶段 3：静态配置）
            commands::api_server::api_buddy_ai_catalog_list,
            commands::wb_config::wb_route_config_get,
            commands::wb_config::wb_route_config_set,
            commands::wb_config::wb_template_map_get,
            commands::wb_config::wb_template_map_set,
            commands::wb_config::wb_tool_alias_map_get,
            commands::wb_config::wb_tool_alias_map_set,
            commands::wb_config::fingerprint_samples_get,
            commands::wb_config::fingerprint_samples_clear,
            // 池级指纹清洗开关（issue #158 P1-4：wb_sanitize / qoder_sanitize 热切换）
            commands::api_server::sanitize_switches_get,
            commands::api_server::sanitize_switch_set,
            // 伪流式开关 / 重试预算 / keep-alive 间隔（issue #213 S7）
            commands::api_server::pseudo_stream_switches_get,
            commands::api_server::pseudo_stream_switch_set,
            commands::api_server::retry_budgets_get,
            commands::api_server::retry_budget_set,
            commands::api_server::pseudo_keepalive_get,
            commands::api_server::pseudo_keepalive_set,
            commands::api_server::api_unified_models,
            commands::api_server::dispatch_policy_get,
            commands::api_server::dispatch_policy_set,
            commands::api_server::model_whitelist_get,
            commands::api_server::model_whitelist_set,
            commands::api_server::gateway_settings_get,
            commands::api_server::gateway_settings_set,
            commands::api_server::lan_iface_ips,
            commands::api_server::custom_models_list,
            commands::api_server::custom_models_save,
            commands::api_server::custom_models_remove,
            commands::api_server::custom_model_test,
            commands::api_server::custom_lb_status,
            commands::api_server::trae_model_meta_set,
            commands::api_server::trae_model_meta_get,
            commands::api_server::trae_model_meta_clear,
            commands::api_server::trae_long_context_list,
            commands::api_server::trae_long_context_set,
            commands::api_server::qoder_context_length_list,
            commands::api_server::qoder_context_length_set,
            commands::ccswitch::ccswitch_status,
            commands::ccswitch::ccswitch_register,
            commands::profile::profile_list,
            commands::profile::profile_backup,
            commands::profile::profile_restore,
            commands::profile::profile_delete,
            commands::profile::profile_format_size,
            commands::doubao::doubao_accounts_list,
            commands::doubao::doubao_account_save,
            commands::doubao::doubao_account_remove,
            commands::doubao::doubao_detect_uid,
            commands::doubao::doubao_quota_fetch,
            commands::doubao::doubao_captured_credential,
            commands::doubao::doubao_credential_auto_apply,
            commands::doubao::doubao_renew_run,
            commands::doubao::doubao_keepalive_run,
            commands::doubao::doubao_account_set_credential,
            commands::doubao::doubao_account_get_credential,
            commands::doubao::doubao_renew_task_register,
            commands::doubao::doubao_renew_task_status,
            commands::doubao::doubao_renew_task_unregister,
            commands::doubao::doubao_history,
            commands::doubao::doubao_quota_task_register,
            commands::doubao::doubao_quota_task_status,
            commands::doubao::doubao_quota_task_unregister,
            commands::doubao::doubao_checkin_run,
            commands::doubao::doubao_dashboard_stats,
            commands::doubao::doubao_checkin_results_detail,
            commands::doubao::doubao_checkin_task_register,
            commands::doubao::doubao_checkin_task_status,
            commands::doubao::doubao_checkin_task_unregister,
            commands::doubao::doubao_open_as_account,
            commands::doubao::doubao_snapshot_meta,
            commands::doubao::doubao_chatdata_backup,
            commands::doubao::doubao_chatdata_restore,
            commands::doubao::doubao_chatdata_info,
            commands::doubao::doubao_export_chats,
            commands::oauth::oauth_get_login_url,
            commands::oauth::oauth_parse_callback,
            commands::oauth::oauth_login,
            commands::oauth_loopback::oauth_start_loopback,
            commands::oauth_loopback::oauth_stop_loopback,
            commands::trae_apps::apps_accounts_discover,
            commands::trae_apps::apps_account_add,
            commands::trae_apps::apps_entitlement_read,
            commands::trae_apps::refresh_pay_status,
            commands::trae_apps::accounts_backfill_dc_ids,
            commands::usage_history::usage_history_fetch,
            commands::usage_history::usage_sessions_query,
            commands::usage_history::trae_expired_ents,
            commands::updater::update_check,
            commands::updater::update_download,
            commands::updater::update_run_installer,
            commands::updater::update_auto_tick,
            commands::workbuddy::workbuddy_env_check,
            commands::workbuddy::workbuddy_open_auth_dir,
            commands::workbuddy::workbuddy_accounts_list,
            commands::workbuddy::workbuddy_account_save,
            commands::workbuddy::workbuddy_clear_relogin,
            commands::workbuddy::workbuddy_account_move,
            commands::workbuddy::workbuddy_groups_list,
            commands::workbuddy::workbuddy_groups_create,
            commands::workbuddy::workbuddy_groups_update,
            commands::workbuddy::workbuddy_groups_remove,
            commands::workbuddy::workbuddy_account_remove,
            commands::workbuddy::workbuddy_scan_auth_file,
            commands::workbuddy::workbuddy_account_import_auth,
            commands::workbuddy::workbuddy_refresh_token,
            commands::workbuddy::workbuddy_checkin_start,
            commands::workbuddy::workbuddy_growth_run,
            commands::workbuddy::workbuddy_checkin_results,
            commands::workbuddy::workbuddy_checkin_task_register,
            commands::workbuddy::workbuddy_checkin_task_status,
            commands::workbuddy::workbuddy_checkin_task_unregister,
            commands::workbuddy::workbuddy_renew_task_register,
            commands::workbuddy::workbuddy_renew_task_status,
            commands::workbuddy::workbuddy_renew_task_unregister,
            commands::workbuddy::workbuddy_credits_fetch,
            commands::workbuddy::workbuddy_credits_history_list,
            commands::workbuddy::workbuddy_editions_backfill,
            commands::workbuddy::workbuddy_settings_get,
            commands::workbuddy::workbuddy_ui_click_capture,
            commands::workbuddy::workbuddy_ui_click_checkin,
            commands::workbuddy::workbuddy_settings_set,
            commands::workbuddy::workbuddy_cli_status,
            commands::workbuddy::workbuddy_cli_bridge_set,
            commands::workbuddy::workbuddy_cli_rotate_run,
            commands::workbuddy::workbuddy_cli_rotate_logs,
            commands::workbuddy::workbuddy_chatdata_backup,
            commands::workbuddy::workbuddy_chatdata_restore,
            commands::workbuddy::workbuddy_chatdata_info,
            commands::workbuddy::workbuddy_chatdata_copy,
            commands::workbuddy::workbuddy_accounts_export,
            commands::workbuddy::workbuddy_accounts_import,
            commands::workbuddy::workbuddy_oauth_login,
            // Buddy 国际版（buddy-ai）独立池（阶段 1）
            commands::workbuddy::buddy_ai_oauth_login,
            commands::workbuddy::buddy_ai_account_import_creds,
            commands::workbuddy::buddy_ai_accounts_list,
            commands::workbuddy::buddy_ai_account_remove,
            commands::workbuddy::buddy_ai_refresh_token,
            // Buddy 国际版每日活跃打卡（阶段 3b）
            commands::workbuddy::buddy_ai_checkin_start,
            commands::workbuddy::buddy_ai_checkin_results,
            commands::workbuddy::buddy_ai_account_save,
            commands::workbuddy::buddy_ai_account_toggle,
            commands::workbuddy::buddy_ai_credits_history,
            commands::workbuddy::buddy_ai_accounts_export,
            commands::workbuddy::buddy_ai_accounts_import,
            commands::workbuddy::buddy_ai_local_scan,
            commands::workbuddy::buddy_ai_env_reset,
            commands::workbuddy::buddy_ai_request_usage,
            commands::workbuddy::buddy_ai_usage_official_all,
            commands::workbuddy::buddy_ai_sessions_query,
            commands::workbuddy::buddy_ai_credits_fetch,
            commands::workbuddy::buddy_ai_open_data_dir,
            commands::workbuddy::buddy_ai_catalog_sync,
            commands::workbuddy::workbuddy_env_reset_items,
            commands::workbuddy::workbuddy_env_reset,
            commands::workbuddy::workbuddy_usage_official,
            commands::workbuddy::workbuddy_usage_fallback,
            commands::workbuddy::workbuddy_usage_official_all,
            commands::workbuddy::workbuddy_sessions_query,
            commands::workbuddy::workbuddy_activity_info,
            commands::workbuddy_stats::workbuddy_token_stats,
            commands::workbuddy_stats::buddy_ai_token_stats,
            // Qoder（F-80 M1：签到 MVP 闭环 + 最小积分通道）
            commands::qoder::qoder_env_check,
            commands::qoder::qoder_open_ide,
            commands::qoder::qoder_open_work,
            commands::qoder::qoder_oauth_login,
            commands::qoder::qoder_oauth_cancel,
            commands::qoder::qoder_settings_get,
            commands::qoder::qoder_settings_set,
            commands::qoder::qoder_accounts_list,
            commands::qoder::qoder_account_save,
            commands::qoder::qoder_account_remove,
            commands::qoder::qoder_account_move,
            commands::qoder::qoder_groups_list,
            commands::qoder::qoder_groups_create,
            commands::qoder::qoder_groups_update,
            commands::qoder::qoder_groups_remove,
            commands::qoder::qoder_account_import_pat,
            commands::qoder::qoder_account_refresh_token,
            commands::qoder::qoder_ide_scan,
            commands::qoder::qoder_cli_status,
            commands::qoder::qoder_live_logins,
            commands::qoder::qoder_checkin_start,
            commands::qoder::qoder_checkin_results,
            commands::qoder::qoder_checkin_task_register,
            commands::qoder::qoder_checkin_task_status,
            commands::qoder::qoder_checkin_task_unregister,
            commands::qoder::qoder_credits_fetch,
            commands::qoder::qoder_web_usage_today,
            commands::qoder::qoder_credits_history_list,
            commands::qoder::qoder_sessions_query,
            commands::qoder::qoder_session_detail_query,
            commands::custom::custom_sessions_query,
            commands::custom::custom_session_detail_query,
            commands::qoder::qoder_accounts_export,
            commands::qoder::qoder_accounts_import,
            commands::qoder::qoder_env_reset_items,
            commands::qoder::qoder_env_reset,
            tasks::scheduler::scheduler_status,
            main_window_ready,
            window_logically_maximized,
            window_logical_zoom_set,
        ])
        .setup(|app| {
            // 审查修复 #2：注册全局句柄供后台线程状态告警弹桌面通知（notify.rs global_app）
            crate::notify::set_global_app(app.handle().clone());
            let state = app.state::<AppState>();

            // 数据存储层 SQLite 化（docs/sqllite-storage-plan.md）：旧 JSON 导入 aiwork.sqlite
            // 并移入 data/backup/（幂等；失败不阻断启动，下次启动重试）。
            // 必须先于本回调内一切 kv 消费方执行（settings/trim_logs 等）——否则升级
            // 首次启动读到全默认设置，trim_logs 会按默认保留期误裁日志。
            // 注意：必须先于 vault 迁移执行——JSON 中的明文凭据先入库，
            // 再由随后的 vault::migrate_on_startup 收敛进 Stronghold 并从库中占位化抹除。
            if let Some(summary) = store::migrate::migrate_on_startup(&state.data_dir) {
                fs_utils::app_log(&state.data_dir, &summary);
            }

            // TraeWork 双应用合并存量迁移（docs/completed/Trae双应用合并适配调整方案.md §5.8）：
            // settings trae_path 退役 + 旧快照池 profiles 整组搬迁（幂等；
            // Trae 运行中自动跳过下次重试），必须先于 settings 消费执行
            if let Some(summary) = store::migrate::migrate_traework_merge(&state.data_dir) {
                fs_utils::app_log(&state.data_dir, &summary);
            }

            let settings = state.settings();

            // 主窗口改为「在 setup 内动态创建」（tauri.conf.json 的 windows 置空）：
            // 只有建窗那一刻就把启动页底色交给 WebView2（builder.background_color →
            // DefaultBackgroundColor），才能保证窗口出现的第一帧即是正确底色。
            // 早期实现（配置建窗 + setup 里 set_background_color）实测仍会闪一下白：
            // WebView2 在建窗瞬间已按默认白底出过帧，后改色追不上；隐藏窗口再 show 也会
            // 因「不可见时不产帧」而在显示瞬间露出白帧。
            {
                let dark = splash_prefers_dark(&settings.theme);
                let color = splash_background(&settings.theme);
                let minimized = settings.launch_minimized;
                // 启动即最小化：闸门标记为「不再自动显示」，窗口由托盘图标唤起
                if minimized {
                    if let Some(gate) = app.try_state::<MainWindowReveal>() {
                        gate.minimized
                            .store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                }
                // 首帧明暗标记：必须在「页面开始解析前」写入 html，否则骨架会先按系统
                // prefers-color-scheme 画一帧再跳色。这里用初始化脚本（WebView2 的
                // AddScriptToExecuteOnDocumentCreated：文档创建即执行，不产生网络请求、
                // 也不受页面 CSP 限制）。
                // 反例（勿改回）：曾用 <script src="/boot-theme.js"> 读 localStorage——
                // 同步阻塞脚本排在 <style> 之前，冷启动时要等它取回来才开始解析样式，
                // 中间那一帧无样式 = 纯白底，正是「闪一下白」的来源。
                // 注意 Chromium 的解析时机不确定性：注入脚本可能在 <html> 尚未创建时就执行，
                // 故除立即尝试外，再用 rAF 补几次 + DOMContentLoaded 兜底（同一函数幂等）。
                // 第二段职责：**首帧握手**——骨架的样式与内容都进了合成器后，
                // 通知 Rust 显示窗口（调 main_window_ready 命令）。
                // 放在注入脚本里而不是 React 里：1.6MB bundle 的解析要几百毫秒，
                // 等它反而让「窗口迟迟不出现」；骨架是纯 CSS，第一帧就能画完。
                // `__TAURI_INTERNALS__` 由 Tauri 自己的 bootstrap 脚本注入，两段脚本
                // 的先后顺序不保证，故握手函数带存在性检查 + rAF 轮询重试（约 2s 上限）。
                // 另外必须先确认骨架 DOM（#boot-splash）已解析出来：否则窗口显示时页面
                // 还是空白底——深色主题下就是「先黑一下再出现启动页」。
                let boot_js = format!(
                    "(function(){{var d={};var n=0;function a(){{var r=document.documentElement;\
if(!r)return false;r.setAttribute('data-boot-theme',d?'dark':'light');\
if(d)r.classList.add('dark');else r.classList.remove('dark');return true;}}\
if(!a()){{var f=function(){{if(a()||++n>120)return;requestAnimationFrame(f);}};requestAnimationFrame(f);}}\
var k=0,m=0;function ready(){{var el=document.getElementById('boot-splash');\
if(!el||!el.firstElementChild){{if(++m>120)return;requestAnimationFrame(ready);return;}}\
var i=window.__TAURI_INTERNALS__;\
if(!i||!i.invoke){{if(++k>120)return;requestAnimationFrame(ready);return;}}\
try{{i.invoke('main_window_ready');}}catch(e){{}}}}\
requestAnimationFrame(function(){{requestAnimationFrame(ready);}});\
document.addEventListener('DOMContentLoaded',a,{{once:true}});}})();",
                    if dark { "true" } else { "false" }
                );
                let built = tauri::WebviewWindowBuilder::new(
                    app,
                    "main",
                    tauri::WebviewUrl::App("index.html".into()),
                )
                .title("AI Work 助手")
                .inner_size(1180.0, 760.0)
                .min_inner_size(960.0, 600.0)
                .decorations(false)
                .resizable(true)
                .center()
                // 建窗阶段绝不传 maximized(true)：tao 的处理顺序是
                // 「set_maximized(true)（内部 ShowWindow，窗口立刻可见）→ set_visible(false)」，
                // 中间那一瞬窗口已经露过脸，是「透白窗口一闪而过」的直接来源。
                // 最大化改到 reveal_main_window 里、与 show 一起做。
                .maximized(false)
                // 窗口明暗与「应用主题」对齐：WebView2 的 prefers-color-scheme 随之改变，
                // 于是即使注入脚本尚未生效，index.html 里 @media (prefers-color-scheme)
                // 那一档也已选出正确底色（双保险，避免深色主题下先刷一帧浅色）。
                .theme(Some(if dark {
                    tauri::Theme::Dark
                } else {
                    tauri::Theme::Light
                }))
                // 关键：先建隐藏窗口。配置建窗 + 立即显示时，WebView2 在首帧 HTML
                // 绘制前会先呈现自己的默认底色（系统白），表现为「透白窗口一闪」；
                // 先隐藏可彻底避免这一帧被看到。
                .visible(false)
                // 隐藏期间禁用渲染节流：否则 WebView 被判定为不可见而不产帧，
                // 等 show 的瞬间又回到「先白一帧」的老问题。
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .background_color(color)
                .initialization_script(boot_js)
                .build();
                if let Err(e) = built {
                    fs_utils::app_log(&state.data_dir, &format!("主窗口创建失败: {e}"));
                    return Err(e.into());
                }
                if let Some(window) = app.get_webview_window("main") {
                    // 建窗即禁用 DWM 过渡：本窗口后续任何「最大化 / 还原」都不再播放大
                    // 尺寸动画（冷启动首帧与托盘唤起共用同一 HWND，属性常驻）。
                    disable_window_transitions(&window);
                    // 关键：在建窗后、页面加载前就把几何拉到最终工作区尺寸。
                    // 页面从头到尾只在「最终尺寸」下渲染一次，后续 maximize() 因尺寸已
                    // 相等而不产生尺寸变化 —— 这是唯一能彻底消除「默认尺寸 → 全屏」重绘闪
                    // 的做法（只禁 DWM 动画不够：动画被跳过，重绘仍在）。
                    // launch_minimized 时同样处理：托盘唤起时尺寸已就绪，不会二次跳变。
                    size_to_work_area(&window);
                }
                // 兜底：前端握手未到达（JS 报错/资源损坏）时不能永远不显示窗口，
                // 2.5 秒后无条件显示——此时底色已是启动页色，最坏是空白启动页。
                if !minimized {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(2500));
                        if reveal_main_window(&handle) {
                            if let Some(st) = handle.try_state::<AppState>() {
                                fs_utils::app_log(
                                    &st.data_dir,
                                    "显示主窗口：前端首帧握手未到达，已按兜底超时显示",
                                );
                            }
                        }
                    });
                }
            }

            // 启动期日志清理：按 log_retention_days 丢弃过期日志行（消费设置项，避免无限增长）
            let retention = settings.log_retention_days.max(0) as u64;
            fs_utils::trim_logs(&state.data_dir, retention);

            // 清理上次运行残留的临时凭据文件（崩溃时未及删除的明文文件，失败不阻断启动）
            vault::cleanup_temp_accounts(&state);

            // 敏感数据迁移：库中明文 jwt/refresh_token → Stronghold vault（幂等，失败不阻断启动）
            vault::migrate_on_startup(&state);

            // 凭证收敛（审查 P0-1）：WB/Qoder token store 与豆包账号池的明文凭证
            // → Stronghold vault，SQLite 行占位化（幂等，失败不阻断启动）
            vault::migrate_ns_on_startup(&state);

            fs_utils::app_log(
                &state.data_dir,
                &format!(
                    "应用启动: tray=enabled, launch_minimized={}, auto_start_proxy={}, auto_start_api={}",
                    settings.launch_minimized, settings.auto_start_proxy, settings.auto_start_api
                ),
            );

            // P2（审查）：调度按 chrono::Local 触发，生效时区不可观测——TZ 被
            // 覆盖/清空时签到时刻会静默偏移，启动日志输出生效时区偏移与本地时间
            fs_utils::app_log(
                &state.data_dir,
                &format!(
                    "生效时区: 偏移{}，本地时间 {}",
                    chrono::Local::now().format("%:z"),
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                ),
            );

            // 注意：这里不能再调 window.maximize() 兜底——tao 的 maximize 内部是
            // ShowWindow(SW_MAXIMIZE)，会让隐藏窗口当场可见（正是透白一闪的来源）。
            // 最大化与显示统一由 reveal_main_window（前端首帧握手 / 兜底超时）负责。

            // 创建系统托盘（始终启用，支持最小化到托盘；失败不阻断启动）
            {
                let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                    let toggle_item =
                        MenuItem::with_id(app, "toggle", "显示/隐藏", true, None::<&str>)?;
                    let checkin_item =
                        MenuItem::with_id(app, "checkin", "一键签到", true, None::<&str>)?;
                    let api_item =
                        MenuItem::with_id(app, "api-toggle", "启动API网关", true, None::<&str>)?;
                    let proxy_item =
                        MenuItem::with_id(app, "proxy-toggle", "启动代理", true, None::<&str>)?;
                    let sep = PredefinedMenuItem::separator(app)?;
                    let quit_item =
                        MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                    let menu = Menu::with_items(
                        app,
                        &[&toggle_item, &sep, &checkin_item, &api_item, &proxy_item, &sep, &quit_item],
                    )?;
                    app.manage(TrayMenu { api_item, proxy_item });

                    let icon = app
                        .default_window_icon()
                        .cloned()
                        .ok_or("找不到默认窗口图标")?;

                    TrayIconBuilder::new()
                        .icon(icon)
                        .tooltip("AI Work 助手")
                        .menu(&menu)
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                let app = tray.app_handle();
                                let st = app.state::<AppState>();
                                if let Some(window) = app.get_webview_window("main") {
                                    if window.is_visible().unwrap_or(false) {
                                        let _ = hide_main_window(app);
                                        fs_utils::app_log(&st.data_dir, "托盘左键点击：隐藏窗口");
                                    } else {
                                        show_main_window(app);
                                        fs_utils::app_log(&st.data_dir, "托盘左键点击：显示窗口");
                                    }
                                } else {
                                    fs_utils::app_log(&st.data_dir, "托盘左键点击：找不到主窗口");
                                }
                            }
                        })
                        .on_menu_event(|app, event| match event.id.as_ref() {
                            "toggle" => {
                                let st = app.state::<AppState>();
                                if let Some(window) = app.get_webview_window("main") {
                                    if window.is_visible().unwrap_or(false) {
                                        let _ = hide_main_window(app);
                                        fs_utils::app_log(&st.data_dir, "菜单：隐藏窗口");
                                    } else {
                                        show_main_window(app);
                                        fs_utils::app_log(&st.data_dir, "菜单：显示窗口");
                                    }
                                }
                            }
                            "checkin" => {
                                // 托盘一键签到：Trae（start_checkin_core 内部防重入锁）
                                // + WorkBuddy 签到 + 成长计划（同步串行线程，各阶段完成发系统通知）
                                let app2 = app.clone();
                                std::thread::spawn(move || {
                                    let st = app2.state::<AppState>();
                                    let opts = commands::checkin::CheckinOpts {
                                        scope: "all".into(),
                                        user_ids: None,
                                        skip_checked_in: true,
                                        skip_expired: false,
                                    };
                                    if let Err(e) = commands::checkin::start_checkin_core(
                                        &app2, &st, opts, true,
                                    ) {
                                        fs_utils::app_log(
                                            &st.data_dir,
                                            &format!("托盘 Trae 签到失败: {e}"),
                                        );
                                        notify::notify(&app2, "Trae 签到启动失败", &e);
                                    }
                                    commands::workbuddy::tray_checkin_all(&app2, &st);
                                });
                            }
                            "api-toggle" => {
                                // 托盘启停 API 服务：block_on 等待快速启停完成，
                                // 菜单文本与通知由 do_start/do_stop 内统一处理
                                let st = app.state::<AppState>();
                                let runtime = app
                                    .state::<Mutex<Option<commands::api_server::ApiServerRuntime>>>();
                                let running = runtime
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .is_some();
                                let result = if running {
                                    tauri::async_runtime::block_on(
                                        commands::api_server::do_stop(app, &st, &runtime),
                                    )
                                    .map(|_| ())
                                } else {
                                    tauri::async_runtime::block_on(
                                        commands::api_server::do_start(app, &st, &runtime),
                                    )
                                    .map(|_| ())
                                };
                                if let Err(e) = result {
                                    fs_utils::app_log(
                                        &st.data_dir,
                                        &format!("托盘 API 服务操作失败: {e}"),
                                    );
                                    // 渠道推送统一入口（含桌面通知 + Bark/Server酱/Webhook，
                                    // 全部应用共用），避免与 notify::notify 重复弹窗。
                                    // 事件类别取 Other（手动操作结果，不受「任务失败」事件开关
                                    // 限制）：托盘菜单无其他反馈通道，若被事件开关静默，
                                    // 用户点了「启动服务」却只看到没起来、原因全无（静默失败红线）。
                                    // 后台线程版：菜单回调在主线程，四渠道 HTTP（最坏 ~40s）不得阻塞 UI 事件循环
                                    commands::workbuddy::push_notify_bg(
                                        Some(app.clone()),
                                        st.data_dir.clone(),
                                        "API 服务操作失败",
                                        &e,
                                        crate::notify::NotifyEvent::Other,
                                    );
                                }
                            }
                            "proxy-toggle" => {
                                // 托盘启停代理：与前端共用 proxy_start/proxy_stop 命令
                                //（菜单文本由 proxy.rs 内 sync_tray_proxy_text 统一同步，覆盖托盘/前端/自动启动三条路径）
                                let running = commands::proxy::proxy_is_running();
                                let result = if running {
                                    let st = app.state::<AppState>();
                                    commands::proxy::proxy_stop(app.clone(), st).map(|_| ())
                                } else {
                                    let port = app.state::<AppState>().settings().proxy_port;
                                    let st = app.state::<AppState>();
                                    // P4 Rust 化：proxy_start 已是异步命令（进程内代理启动含异步绑定），
                                    // 托盘回调运行在主线程，用 block_on 等待（与 API 服务托盘同款模式）
                                    tauri::async_runtime::block_on(commands::proxy::proxy_start(
                                        app.clone(), st, port,
                                    ))
                                    .map(|_| ())
                                };
                                if let Err(e) = result {
                                    let st = app.state::<AppState>();
                                    fs_utils::app_log(
                                        &st.data_dir,
                                        &format!("托盘代理操作失败: {e}"),
                                    );
                                    // 渠道推送统一入口（含桌面通知 + Bark/Server酱/Webhook，
                                    // 全部应用共用），避免与 notify::notify 重复弹窗。
                                    // 同上：托盘直操取 Other，不被「任务失败」事件开关静默；
                                    // 后台线程版防渠道 HTTP 阻塞主线程
                                    commands::workbuddy::push_notify_bg(
                                        Some(app.clone()),
                                        st.data_dir.clone(),
                                        "代理操作失败",
                                        &e,
                                        crate::notify::NotifyEvent::Other,
                                    );
                                }
                            }
                            "quit" => {
                                let st = app.state::<AppState>();
                                fs_utils::app_log(&st.data_dir, "菜单：用户请求退出应用");
                                // 与窗口关闭一致：先隐藏主窗口再退出，避免 WebView2 销毁期间窗口冻结
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.hide();
                                }
                                app.exit(0);
                            }
                            _ => {}
                        })
                        .build(app)?;
                    Ok(())
                })();

                match &result {
                    Ok(()) => fs_utils::app_log(&state.data_dir, "托盘图标创建成功"),
                    Err(e) => {
                        let msg = format!("托盘创建失败（应用将继续运行）: {e}");
                        fs_utils::app_log(&state.data_dir, &msg);
                        eprintln!("{msg}");
                    }
                }
            }

            // 启动时最小化到托盘（hide_main_window 会记录最大化状态，供托盘显示时恢复）
            if settings.launch_minimized {
                if hide_main_window(app.handle()) {
                    fs_utils::app_log(&state.data_dir, "启动最小化：窗口已隐藏到托盘");
                }
            }

            // 启动静默签到（T11）：延迟 60s 后对未签到账号自动执行一轮签到，
            // 复用托盘签到链路（含防重入锁，与手动/托盘签到天然互斥）；
            // skip_checked_in=true 保证幂等，重复开机不会重复签
            if settings.silent_checkin {
                let app2 = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                    let st = app2.state::<AppState>();
                    fs_utils::app_log(&st.data_dir, "静默签到：启动延迟到期，开始检查签到");
                    let opts = commands::checkin::CheckinOpts {
                        scope: "all".into(),
                        user_ids: None,
                        skip_checked_in: true,
                        skip_expired: false,
                    };
                    if let Err(e) = commands::checkin::start_checkin_core(&app2, &st, opts, true) {
                        fs_utils::app_log(&st.data_dir, &format!("静默签到失败: {e}"));
                        // 渠道推送统一入口（含桌面通知 + Bark/Server酱/Webhook，
                        // 全部应用共用），最小化启动时也能收到，避免重复弹窗
                        commands::workbuddy::push_notify(
                            Some(&app2),
                            &st.data_dir,
                            "静默签到失败",
                            &e,
                            crate::notify::NotifyEvent::TaskFail,
                        );
                    }
                });
            }

            // WorkBuddy 启动自动补签（F-55）：延迟 60s 核验未签账号并补签，
            // 复用 python 签到脚本（--skip-checked 幂等），独立于 Trae 静默签到
            {
                let app2 = app.handle().clone();
                let st = app.state::<AppState>();
                commands::workbuddy::startup_auto_checkin(&app2, &st);
            }

            // buddy-ai 存量迁移（§4.7）：wb 池混居的 global_region=true 账号一次性
            // 迁入 buddy-ai 独立池（kv 标记幂等；失败不置位下次重试，不阻断启动）
            {
                let st = app.state::<AppState>();
                if let Err(e) = commands::workbuddy::migrate_wb_global_accounts(&st) {
                    fs_utils::app_log(&st.data_dir, &format!("buddy-ai: 存量迁移失败（下次启动重试）: {e}"));
                }
            }

            // buddy-ai 启动打卡补跑（阶段 3b，对齐 startup_auto_checkin 形态；
            // 独立开关 buddy_ai_checkin_enabled 默认关，抢不到轮次锁幂等跳过）
            {
                let app2 = app.handle().clone();
                let st = app.state::<AppState>();
                commands::workbuddy::startup_auto_checkin_buddy_ai(&app2, &st);
            }

            // Qoder 启动自动补签（F-80，F-55 同款模式）：独立开关，与 WB 补签互不影响
            {
                let app2 = app.handle().clone();
                let st = app.state::<AppState>();
                commands::qoder::startup_auto_checkin(&app2, &st);
            }

            // CodeBuddy CLI 五重防护自动轮换（F-59）：独立后台线程按检查间隔执行，
            // 开关关闭时空转；decide_target 纯函数判定，切号写 ~/.codebuddy/settings.json
            commands::workbuddy::start_cli_rotate_thread();

            // 应用内定时调度器（Rust 原生方案，补充 Windows schtasks）：
            // 每日签到/巡检/续期到点补跑 + 积分余额每日快照（新增任务，补齐近 7 日消耗时序）
            tasks::scheduler::start(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭即退出应用（前端已弹确认框；退出时 RunEvent::Exit 自动清理代理与 API 服务）
            // 先隐藏窗口再退出：exit(0) 内部的 WebView2 销毁可能耗时数秒（运行越久越明显），
            // 若直接退出，用户会看到窗口冻结「卡死」。隐藏后清理再慢也无感（issue：关闭卡死）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                let st = window.app_handle().state::<AppState>();
                fs_utils::app_log(&st.data_dir, "用户确认退出应用");
                let _ = window.hide();
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // 应用退出时停止进程内代理（P4 Rust 化），防止端口占用
            commands::proxy::mark_intentional_stop();
            let mut g = commands::proxy::proxy_handle_lock();
            let mut proxy_was_running = false;
            if let Some(h) = g.take() {
                proxy_was_running = true;
                let state = app_handle.state::<AppState>();
                fs_utils::app_log(&state.data_dir, "应用退出：正在停止进程内代理");
                h.server.stop(); // 发送 shutdown 信号；句柄 drop 亦触发退出
            }
            // 应用退出时停止 API 服务
            let api_state = app_handle
                .state::<Mutex<Option<commands::api_server::ApiServerRuntime>>>();
            let mut ag = api_state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(mut rt) = ag.take() {
                let state = app_handle.state::<AppState>();
                fs_utils::app_log(&state.data_dir, "应用退出：正在停止 API 服务");
                rt.handle.stop();
                // 批次 C/E：退出前排空用量脏队列、api_keys 计数与日志队列
                rt.shared.flush_pending_writes();
            }
            // 还原系统代理（#14）：仅当「我们曾接管系统代理」时才还原——
            // 有用户 VPN 原值则原样还原（原 clear_win_proxy 会把用户梯子一并清掉）；
            // 代理从未启动/已正常停止则不触碰，避免误关用户自己的 VPN
            if let Err(e) = commands::proxy::restore_system_proxy_on_exit(proxy_was_running) {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    fs_utils::app_log(&state.data_dir, &format!("应用退出：还原系统代理失败(可手动关闭): {e}"));
                }
            }
            // 兜底强制退出（Python 版为独立进程 kill 瞬退、无此问题；Rust 进程内化后，
            // 析构阶段的 WebView2 销毁/异步运行时 drop 可能卡死——实测退出停留在
            // 「正在停止进程内代理」后进程挂死，用户重复点关闭 9 次）。上方清理均为
            // 同步快操作且已完成，2 秒后无条件 process::exit 保证必然退出。
            if let Some(state) = app_handle.try_state::<AppState>() {
                fs_utils::app_log(&state.data_dir, "应用退出：清理完成，2 秒内强制退出（兜底防析构卡死）");
            }
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(2));
                std::process::exit(0);
            });
        }
    });
}

#[cfg(test)]
mod geometry_tests {
    use super::*;

    fn mon(x: i32, y: i32, w: i32, h: i32) -> MonitorGeom {
        MonitorGeom {
            x,
            y,
            w,
            h,
            scale: 1.0,
        }
    }

    /// issue #183：正常窗口（完全落在工作区内 / 跨屏两侧均有足够交叠）不误判
    #[test]
    fn valid_window_not_misjudged() {
        let monitors = vec![mon(0, 0, 1920, 1040), mon(1920, 0, 1920, 1040)];
        assert!(geometry_valid(100, 100, 1280, 800, &monitors));
        // 跨屏窗口：对主屏交叠恰为 150px（阈值边界含等号）
        assert!(geometry_valid(1770, 100, 300, 800, &monitors));
    }

    /// issue #183：整窗挂在已断开的显示器坐标上 → 无足够交叠 → 失效；
    /// 仅露出一条边（< 150px，任务栏缩略图一条线形态）同样失效
    #[test]
    fn offscreen_or_sliver_window_invalid() {
        let monitors = vec![mon(0, 0, 1920, 1040)];
        assert!(!geometry_valid(-4000, 0, 1280, 800, &monitors));
        assert!(!geometry_valid(1910, 100, 1280, 800, &monitors));
    }

    /// 退化尺寸（一条线窗口）直接判失效，与位置无关
    #[test]
    fn degenerate_size_invalid_even_on_screen() {
        let monitors = vec![mon(0, 0, 1920, 1040)];
        assert!(!geometry_valid(100, 100, 120, 800, &monitors));
        assert!(!geometry_valid(100, 100, 1280, 5, &monitors));
    }

    /// 修复目标显示器：有交叠 → 面积最大者；全部无交叠 → 中心距离最近者
    #[test]
    fn best_monitor_by_overlap_then_distance() {
        let monitors = vec![mon(0, 0, 1920, 1040), mon(1920, 0, 1920, 1040)];
        // 窗口整体在双屏之外右侧：无交叠 → 距中心更近的副屏
        assert_eq!(pick_best_monitor(4000, 100, 800, 600, &monitors).x, 1920);
        // 跨屏窗口：主屏交叠 220px > 副屏 80px → 主屏
        assert_eq!(pick_best_monitor(1700, 100, 300, 600, &monitors).x, 0);
    }

    /// 修复几何：屏外窗口仅平移保留用户尺寸；超大窗口钳制到工作区；
    /// 退化尺寸按目标显示器 DPI 重置默认尺寸并钳制
    #[test]
    fn repaired_geometry_clamps_into_work_area() {
        let m = mon(0, 0, 1920, 1040);
        // 屏外窗口：仅平移回工作区原点，尺寸原样保留
        assert_eq!(repaired_geometry(-4000, -3000, 1280, 800, &m), (0, 0, 1280, 800));
        // 超大窗口：尺寸钳制到工作区，位置钳到原点（nw == mw 时 clamp 区间收缩为单点，合法）
        assert_eq!(repaired_geometry(-500, -500, 4000, 3000, &m), (0, 0, 1920, 1040));
        // 退化尺寸：1180*1.5=1770 > 1360 → 按工作区钳制；760*1.5=1140 > 768 同理
        let hidpi = MonitorGeom {
            scale: 1.5,
            ..mon(0, 0, 1360, 768)
        };
        assert_eq!(repaired_geometry(100, 100, 100, 800, &hidpi), (0, 0, 1360, 768));
        // 未越界窗口不改变位置（保留用户相对摆放）
        assert_eq!(repaired_geometry(300, 200, 1280, 800, &m), (300, 200, 1280, 800));
    }

    /// 托盘恢复缩放闪烁：尺寸与隐藏时记录的最大化尺寸一致 → 无需重建；
    /// 明显变小（视觉已还原而状态仍称最大化）→ 判定失同步需要重建
    #[test]
    fn recorded_size_identifies_maximized_desync() {
        let recorded = (1920u64 << 32) | 1040u64;
        assert!(size_matches_recorded(recorded, 1920, 1040));
        // 容差内（DPI 取整差异）仍视为一致，避免误触发重建
        assert!(size_matches_recorded(recorded, 1926, 1046));
        // 还原尺寸（1180x760）明显偏小 → 失同步
        assert!(!size_matches_recorded(recorded, 1180, 760));
        // 未记录时一律视为一致，不做无谓重建
        assert!(size_matches_recorded(0, 1180, 760));
    }
}

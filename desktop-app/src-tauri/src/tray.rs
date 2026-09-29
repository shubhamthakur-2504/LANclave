//! Run in the background from the system tray, like Slack or Docker Desktop.
//!
//! Closing the window hides it: the server keeps answering paired peers, so
//! they can still pull from this computer, and transfers carry on. The app
//! ends only from the tray's "Quit LANclave".
//!
//! A window left hidden for [`GRACE`] is destroyed, releasing the webview
//! (~160 MB, against ~6 MB for everything else; docs/transfer-plan P7), and
//! made again from the tray. Nothing lives only in the page: transfers,
//! offers and a pending pairing request are all held in Rust, and the page
//! reads them when it loads.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, Window, WindowEvent};

const MAIN_WINDOW: &str = "main";

/// How long a hidden window keeps its page, so a quick close and reopen
/// stays instant. After that, reopening takes a second to load the page.
const GRACE: Duration = Duration::from_secs(5 * 60);

/// Bumped whenever the window is shown or hidden: a release timer from an
/// earlier hide finds it changed and leaves the window alone.
static VISIBILITY: AtomicU64 = AtomicU64::new(0);

/// Marker file: present once the "still running" notice has been shown.
/// A file rather than a settings field, because saving settings from the UI
/// replaces the whole settings object and would reset such a flag.
const NOTICE_MARKER: &str = "tray_notice_shown";

/// Bring the window back, making it again if it was released: from the
/// tray, or when the app is launched again while already running (see the
/// single-instance plugin in `lib.rs`).
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    VISIBILITY.fetch_add(1, Ordering::SeqCst);
    let window = match app.get_webview_window(MAIN_WINDOW) {
        Some(window) => window,
        None => match create_main_window(app) {
            Ok(window) => window,
            Err(e) => {
                eprintln!("[lanclave] could not open the window: {e}");
                return;
            }
        },
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// The window as `tauri.conf.json` describes it.
fn create_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let windows = &app.config().app.windows;
    let config = windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .or(windows.first())
        .cloned()
        .unwrap_or_default();
    tauri::WebviewWindowBuilder::from_config(app, &config)?.build()
}

/// The close button hides instead of quitting; the page is released later
/// if the window stays hidden.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == MAIN_WINDOW {
            api.prevent_close();
            let _ = window.hide();
            notify_first_hide(window.app_handle());
            release_later(window.app_handle().clone());
        }
    }
}

/// Destroy the hidden window after [`GRACE`], unless it was shown since.
/// The app keeps running without it (see `RunEvent::ExitRequested` in
/// `lib.rs`).
fn release_later<R: Runtime>(app: AppHandle<R>) {
    let hidden_at = VISIBILITY.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(GRACE).await;
        if VISIBILITY.load(Ordering::SeqCst) != hidden_at {
            return;
        }
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            if !window.is_visible().unwrap_or(true) {
                let _ = window.destroy();
            }
        }
    });
}

/// A system notification, unless the window is on screen to say it --
/// hidden, or released altogether.
pub fn notify_if_hidden<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    let visible = app
        .get_webview_window(MAIN_WINDOW)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if !visible {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

/// The first time × hides the window, say where the app went -- otherwise it
/// looks like it quit, and peers pulling from it later is a surprise.
fn notify_first_hide<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<crate::commands::CliState>() else {
        return;
    };
    let marker = state.app_data_dir.join(NOTICE_MARKER);
    if marker.exists() {
        return;
    }

    use tauri_plugin_notification::NotificationExt;
    let shown = app
        .notification()
        .builder()
        .title("LANclave is still running")
        .body("Paired devices can still reach this computer. Quit from the tray icon.")
        .show();
    if shown.is_ok() {
        let _ = std::fs::write(&marker, b"");
    }
}

/// Tray icon: left click opens the window; the menu opens or quits.
pub fn install<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open LANclave", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit LANclave", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::with_id("lanclave")
        .tooltip("LANclave: sharing with your paired devices")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            // Goes through RunEvent::ExitRequested, which says goodbye to
            // peers so they mark us offline at once rather than by timeout.
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // The tray gets the mark drawn on the 16-px grid (at 2x), not the app
    // icon shrunk: its tile and fine arrows turned to mush at tray size. The
    // accent reads on both light and dark taskbars. Built by branding/gen.mjs.
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
        Ok(icon) => tray = tray.icon(icon),
        Err(_) => {
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
        }
    }
    tray.build(app)?;
    Ok(())
}

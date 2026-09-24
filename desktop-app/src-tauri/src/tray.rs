//! Run in the background from the system tray, like Slack or Docker Desktop.
//!
//! Closing the window only hides it: the server keeps answering paired
//! peers, so they can still pull from this computer, and transfers already
//! running carry on. The app ends only from the tray's "Quit LANclave".

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};

const MAIN_WINDOW: &str = "main";

/// Marker file: present once the "still running" notice has been shown.
/// A file rather than a settings field, because saving settings from the UI
/// replaces the whole settings object and would reset such a flag.
const NOTICE_MARKER: &str = "tray_notice_shown";

/// Bring the window back: from the tray, or when the app is launched again
/// while already running (see the single-instance plugin in `lib.rs`).
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The close button hides instead of quitting. Hiding keeps the webview
/// alive, so the UI resumes exactly where it was.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == MAIN_WINDOW {
            api.prevent_close();
            let _ = window.hide();
            notify_first_hide(window.app_handle());
        }
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

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

//! Developer tools (dev builds only): this computer's terminal reaches a
//! paired phone's logs and package installer, with no USB cable.
//!
//! A plain-HTTP server on `127.0.0.1:8378`, for `curl.exe` in any terminal:
//!
//! ```text
//! curl.exe http://localhost:8378                       # help, phones, status
//! curl.exe -N "http://localhost:8378/logs?pkg=com.x"   # live logcat
//! curl.exe -T app-debug.apk http://localhost:8378/install
//! ```
//!
//! Each call is forwarded to the phone over the same signed, paired-only
//! TLS connection everything else uses (`/api/dev/*` on the phone). Log
//! streams survive the phone dropping off the network: they reconnect and
//! pick up after the last line received.

use crate::pairing::{sign_request, HEADER_DEVICE_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP};
use crate::presence::PresenceContext;
use axum::body::Body;
use axum::extract::{Query, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine;
use bytes::Bytes;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;
use tokio::sync::mpsc;

/// The port this computer's terminal talks to. Next to LANclave's own 8377.
pub const DEV_PORT: u16 = 8378;

/// No bytes from the phone for this long means the link is dead. The phone
/// sends an empty line every 10 s when nothing else is happening.
const STALL: Duration = Duration::from_secs(30);

/// Put `lanclave-run` on this user's PATH, so any terminal can run it.
///
/// The scripts go in `%LOCALAPPDATA%\LANclave\bin`, rewritten every start so
/// they always match this build. The folder is added to the *user* PATH once
/// (no admin rights). Terminals opened afterwards see it; ones already open,
/// and VS Code's, need a restart.
#[cfg(windows)]
fn install_cli() -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let dir = dirs_next::data_local_dir()
        .ok_or("no local app data folder")?
        .join("LANclave")
        .join("bin");
    // The script goes in lib\, off PATH: PowerShell would otherwise run the
    // .ps1 directly, which Windows' default script policy blocks.
    std::fs::create_dir_all(dir.join("lib")).map_err(|e| e.to_string())?;
    let write = |name: &str, body: &str| std::fs::write(dir.join(name), body).map_err(|e| e.to_string());
    write("lib\\lanclave-run.ps1", include_str!("../../../tools/lanclave-run.ps1"))?;
    write("lanclave-run.cmd", include_str!("../../../tools/lanclave-run.cmd"))?;
    // Where an earlier build put it.
    let _ = std::fs::remove_file(dir.join("lanclave-run.ps1"));

    let dir_text = dir.to_string_lossy().to_string();
    let already = std::env::var("PATH")
        .unwrap_or_default()
        .split(';')
        .any(|p| p.trim_end_matches('\\').eq_ignore_ascii_case(&dir_text));
    if already {
        return Ok(());
    }

    // Through the registry rather than [Environment]::SetEnvironmentVariable:
    // that would expand the %VARIABLES% in the user's other PATH entries and
    // save them as fixed text. The variable set last tells Windows (Explorer,
    // new terminals) that the environment changed.
    let script = format!(
        r#"$dir = '{dir}'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$path = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$kind = if ($key.GetValueNames() -contains 'Path') {{ $key.GetValueKind('Path') }} else {{ 'ExpandString' }}
$parts = $path -split ';' | Where-Object {{ $_ -ne '' }}
if (-not ($parts | Where-Object {{ $_.TrimEnd('\') -ieq $dir }})) {{
  $key.SetValue('Path', (@($parts) + $dir) -join ';', $kind)
}}
$key.Close()
[Environment]::SetEnvironmentVariable('LANCLAVE_TOOLS', $dir, 'User')"#,
        dir = dir_text.replace('\'', "''")
    );
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("powershell exited with {status}"))
    }
}

/// Start the local developer server. Logs and carries on if the port is taken.
pub fn spawn(ctx: PresenceContext) {
    #[cfg(windows)]
    tauri::async_runtime::spawn_blocking(|| {
        if let Err(e) = install_cli() {
            eprintln!("[lanclave] could not put lanclave-run on PATH: {e}");
        }
    });
    tauri::async_runtime::spawn(async move {
        let app = axum::Router::new()
            .route("/", get(help))
            .route("/logs", get(logs))
            .route("/install", axum::routing::put(install).post(install))
            .route("/launch", axum::routing::post(launch))
            .with_state(ctx);
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], DEV_PORT));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => {
                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("[lanclave] developer tools stopped: {e}");
                }
            }
            Err(e) => eprintln!("[lanclave] developer tools could not listen on {addr}: {e}"),
        }
    });
}

// ---------------------------------------------------------------------------
// Who may call
// ---------------------------------------------------------------------------

/// Only a terminal on this computer. A web page could otherwise reach
/// `127.0.0.1` from the browser: browsers send `Origin` on such requests,
/// and a `Host` other than ours means a DNS-rebinding attempt.
fn local_caller(headers: &HeaderMap) -> Result<(), Response> {
    if headers.contains_key(header::ORIGIN) {
        return Err(text(StatusCode::FORBIDDEN, "Not from a browser.\n"));
    }
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    let ok = [format!("localhost:{DEV_PORT}"), format!("127.0.0.1:{DEV_PORT}")]
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed));
    if ok {
        Ok(())
    } else {
        Err(text(StatusCode::FORBIDDEN, "Use http://localhost:8378\n"))
    }
}

fn text(status: StatusCode, body: impl Into<String>) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body.into()).into_response()
}

// ---------------------------------------------------------------------------
// Which phone
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Phone {
    id: String,
    name: String,
    online: bool,
}

/// Paired phones, online ones first.
fn phones(ctx: &PresenceContext) -> Vec<Phone> {
    let Ok(store) = ctx.device_store.read() else {
        return Vec::new();
    };
    let mut list: Vec<Phone> = store
        .devices
        .values()
        .filter(|d| d.device_id != ctx.device_id)
        // Other computers have no developer tools; unknown types may be phones.
        .filter(|d| d.device_type.as_deref() != Some("laptop"))
        .map(|d| Phone {
            id: d.device_id.clone(),
            name: d.device_name.clone().unwrap_or_else(|| "Unnamed phone".into()),
            online: ctx.presence.is_online(&d.device_id),
        })
        .collect();
    list.sort_by_key(|p| !p.online);
    list
}

/// The phone `?phone=` names (part of its name, or the start of its id).
/// Otherwise the only one online; with several online, the only one whose
/// developer tools are on, so a phone running normal LANclave never counts.
async fn pick_phone(ctx: &PresenceContext, wanted: Option<&str>) -> Result<Phone, String> {
    let all = phones(ctx);
    if let Some(q) = wanted.filter(|q| !q.is_empty()) {
        let q_lower = q.to_lowercase();
        return all
            .into_iter()
            .find(|p| p.name.to_lowercase().contains(&q_lower) || p.id.starts_with(q))
            .ok_or_else(|| format!("No paired phone matches \"{q}\"."));
    }
    let online: Vec<Phone> = all.iter().filter(|p| p.online).cloned().collect();
    match online.len() {
        1 => return Ok(online[0].clone()),
        0 if all.len() == 1 => return Ok(all[0].clone()),
        0 if all.is_empty() => return Err("No phone is paired with this computer.".into()),
        0 => return Err("No paired phone is online. Is LANclave open on it?".into()),
        _ => {}
    }

    let checks = online.iter().map(|p| dev_tools_on(ctx, p));
    let on: Vec<Phone> = futures_util::future::join_all(checks)
        .await
        .into_iter()
        .zip(online.iter())
        .filter(|(is_on, _)| *is_on)
        .map(|(_, p)| p.clone())
        .collect();
    let names = |list: &[Phone]| list.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ");
    match on.len() {
        1 => Ok(on[0].clone()),
        0 => Err(format!(
            "None of the online phones has developer tools on ({}). On yours: LANclave > Settings > Developer tools.",
            names(&online)
        )),
        _ => Err(format!(
            "More than one phone has developer tools on: {}. Pick one with phone=<name> (lanclave-run -Phone <name>).",
            names(&on)
        )),
    }
}

/// Whether a phone answers `/api/dev/status` with its tools on.
async fn dev_tools_on(ctx: &PresenceContext, phone: &Phone) -> bool {
    let Some(addr) = addr_of(ctx, &phone.id) else {
        return false;
    };
    let Ok(reply) = signed(ctx, reqwest::Method::GET, &addr, "/api/dev/status")
        .timeout(Duration::from_secs(3))
        .send()
        .await
    else {
        return false;
    };
    reply
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|s| s.get("enabled").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

fn addr_of(ctx: &PresenceContext, phone_id: &str) -> Option<String> {
    ctx.presence.addr_of(phone_id).or_else(|| {
        ctx.device_store
            .read()
            .ok()?
            .devices
            .get(phone_id)?
            .last_addr
            .clone()
    })
}

/// A signed request to the phone.
fn signed(ctx: &PresenceContext, method: reqwest::Method, addr: &str, path: &str) -> reqwest::RequestBuilder {
    let (ts, sig) = sign_request(&ctx.identity_key, &ctx.device_id);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
    crate::tls::paired()
        .request(method, format!("https://{addr}{path}"))
        .header(HEADER_DEVICE_ID, &ctx.device_id)
        .header(HEADER_TIMESTAMP, ts.to_string())
        .header(HEADER_SIGNATURE, sig_b64)
}

/// What a phone's `/api/dev/status` says, as one line for the help page.
async fn phone_status_line(ctx: &PresenceContext, phone: &Phone) -> String {
    if !phone.online {
        return "offline".into();
    }
    let Some(addr) = addr_of(ctx, &phone.id) else {
        return "address unknown".into();
    };
    let reply = signed(ctx, reqwest::Method::GET, &addr, "/api/dev/status")
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    let Ok(reply) = reply else {
        return "not answering".into();
    };
    if reply.status() == reqwest::StatusCode::NOT_FOUND {
        return "runs the normal LANclave build (no developer tools)".into();
    }
    let Ok(s) = reply.json::<serde_json::Value>().await else {
        return "unexpected reply".into();
    };
    let flag = |k: &str| s.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    if !flag("enabled") {
        return "developer tools are off (phone: Settings > Developer tools)".into();
    }
    let logs = if !flag("readLogsGranted") {
        "logs: LANclave's own only (needs the one-time adb grant)"
    } else if !flag("seesOtherApps") {
        "logs: waiting for Android's access prompt"
    } else {
        "logs: all apps"
    };
    let installs = if flag("canInstall") { "installs: allowed" } else { "installs: need permission on the phone" };
    format!("ready, {logs}, {installs}")
}

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

async fn help(State(ctx): State<PresenceContext>, headers: HeaderMap) -> Response {
    if let Err(r) = local_caller(&headers) {
        return r;
    }
    let mut out = String::from("LANclave developer tools\n\nPhones:\n");
    let list = phones(&ctx);
    if list.is_empty() {
        out.push_str("  none paired\n");
    }
    for p in &list {
        let status = phone_status_line(&ctx, p).await;
        out.push_str(&format!("  {}  ({})\n", p.name, status));
    }
    out.push_str(&format!(
        r#"
Logs (Ctrl+C to stop; reconnects by itself if the phone drops off):
  curl.exe -N "http://localhost:{port}/logs"                       everything
  curl.exe -N "http://localhost:{port}/logs?pkg=com.example.app"   one app, across restarts
  curl.exe -N "http://localhost:{port}/logs?pkg=com.example.app&level=W&color=1"

  pkg=    package to follow (its crashes included)
  level=  V D I W E F, the lowest to show (default V)
  tag=    only these tags, comma separated
  tail=   earlier lines to show first (default 200, 0 for none)
  color=1 colour by level
  raw=1   keep logcat's uid column
  phone=  which phone, by part of its name, when more than one is online

Install a build (Android asks to confirm the first install of an app):
  curl.exe -T android\app\build\outputs\apk\debug\app-debug.apk http://localhost:{port}/install

Open an app (scheme + port: an Expo dev client, connected to Metro here):
  curl.exe -X POST "http://localhost:{port}/launch?pkg=com.example.app"
  curl.exe -X POST "http://localhost:{port}/launch?pkg=com.example.app&scheme=exp%2Bmy-slug&port=8081"

Build, install, open and follow logs in one go, from your project folder:
  lanclave-run
(LANclave puts it on your PATH; open a new terminal if it isn't found.)

In PowerShell type curl.exe, not curl: plain curl there is a different command.
"#,
        port = DEV_PORT
    ));
    text(StatusCode::OK, out)
}

// ---------------------------------------------------------------------------
// GET /logs
// ---------------------------------------------------------------------------

async fn logs(
    State(ctx): State<PresenceContext>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Err(r) = local_caller(&headers) {
        return r;
    }
    let phone = match pick_phone(&ctx, q.get("phone").map(String::as_str)).await {
        Ok(p) => p,
        Err(e) => return text(StatusCode::NOT_FOUND, format!("{e}\n")),
    };

    let (tx, rx) = mpsc::channel::<Bytes>(64);
    tauri::async_runtime::spawn(follow(ctx, phone, q, tx));
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|b| (Ok::<_, Infallible>(b), rx))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        // Keep proxies and curl from holding lines back.
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| text(StatusCode::INTERNAL_SERVER_ERROR, "could not start\n"))
}

/// One line of our own in the log output.
fn note(color: bool, msg: &str) -> Bytes {
    if color {
        Bytes::from(format!("\x1b[36m-- {msg}\x1b[0m\n"))
    } else {
        Bytes::from(format!("-- {msg}\n"))
    }
}

/// Stream the phone's log into `tx` until the terminal goes away, reconnecting
/// whenever the phone does.
async fn follow(ctx: PresenceContext, phone: Phone, q: HashMap<String, String>, tx: mpsc::Sender<Bytes>) {
    let color = q.get("color").is_some_and(|v| v == "1");
    let raw = q.get("raw").is_some_and(|v| v == "1");

    let mut base = String::from("/api/dev/logs?");
    for key in ["pkg", "level", "tag"] {
        if let Some(v) = q.get(key).filter(|v| !v.is_empty()) {
            base.push_str(&format!("{key}={}&", urlencoding::encode(v)));
        }
    }
    let first_tail = q.get("tail").cloned().unwrap_or_else(|| "200".into());

    let what = match q.get("pkg").filter(|p| !p.is_empty()) {
        Some(pkg) => format!("{pkg} on {}", phone.name),
        None => format!("all of {}", phone.name),
    };
    if tx.send(note(color, &format!("logs from {what}"))).await.is_err() {
        return;
    }

    // `capture` + `after` from the caller (the run script, right after a
    // launch): start at that line instead of showing a tail.
    let mut capture: Option<String> = q.get("capture").filter(|c| !c.is_empty()).cloned();
    let mut after: Option<u64> = capture.as_ref().and(q.get("after").and_then(|a| a.parse().ok()));
    let mut connected_before = false;
    // Say a problem once, not on every retry.
    let mut last_problem = String::new();

    loop {
        if tx.is_closed() {
            return;
        }
        let problem = match connect_once(&ctx, &phone, &base, &first_tail, &mut capture, &mut after, &mut connected_before, color, raw, &tx).await {
            Flow::TerminalGone => return,
            Flow::Fatal(msg) => {
                let _ = tx.send(note(color, &msg)).await;
                return;
            }
            Flow::Retry(msg) => msg,
        };
        if problem != last_problem {
            if tx.send(note(color, &problem)).await.is_err() {
                return;
            }
            last_problem = problem;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

enum Flow {
    TerminalGone,
    Fatal(String),
    Retry(String),
}

#[allow(clippy::too_many_arguments)]
async fn connect_once(
    ctx: &PresenceContext,
    phone: &Phone,
    base: &str,
    first_tail: &str,
    capture: &mut Option<String>,
    after: &mut Option<u64>,
    connected_before: &mut bool,
    color: bool,
    raw: bool,
    tx: &mpsc::Sender<Bytes>,
) -> Flow {
    let Some(addr) = addr_of(ctx, &phone.id) else {
        return Flow::Retry("waiting for the phone to come online".into());
    };
    let path = match (capture.as_ref(), *after) {
        (Some(c), Some(seq)) => format!("{base}capture={}&after={seq}&tail=0", urlencoding::encode(c)),
        // Reconnected before any line: nothing to resume, nothing to repeat.
        (Some(_), None) => format!("{base}tail=0"),
        (None, _) => format!("{base}tail={first_tail}"),
    };
    let reply = match signed(ctx, reqwest::Method::GET, &addr, &path).send().await {
        Ok(r) => r,
        Err(_) => return Flow::Retry("can't reach the phone, retrying".into()),
    };
    match reply.status().as_u16() {
        200 => {}
        404 => return Flow::Fatal("this phone runs the normal LANclave build, which has no developer tools".into()),
        401 => return Flow::Fatal("the phone does not trust this computer any more; pair them again".into()),
        409 => {
            let msg = reply
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
                .unwrap_or_else(|| "log capture is off on the phone".into());
            return Flow::Retry(msg);
        }
        code => return Flow::Retry(format!("the phone answered {code}, retrying")),
    }

    let this_capture = reply
        .headers()
        .get("x-lanclave-capture")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    if capture.is_some() && this_capture != *capture {
        // The phone restarted capture (or the app): its line numbers began
        // again, and what it holds now is its whole log buffer from scratch.
        *after = None;
        if tx.send(note(color, "capture restarted on the phone")).await.is_err() {
            return Flow::TerminalGone;
        }
    } else if *connected_before {
        if tx.send(note(color, "reconnected")).await.is_err() {
            return Flow::TerminalGone;
        }
    }
    *capture = this_capture;
    *connected_before = true;
    if reply.headers().get("x-lanclave-sees-all").and_then(|v| v.to_str().ok()) == Some("false") {
        let _ = tx
            .send(note(color, "only LANclave's own lines so far: allow log access on the phone (Settings > Developer tools)"))
            .await;
    }

    let mut body = reply.bytes_stream();
    let mut partial: Vec<u8> = Vec::new();
    loop {
        let chunk = match tokio::time::timeout(STALL, body.next()).await {
            Err(_) => return Flow::Retry("the phone went quiet, reconnecting".into()),
            Ok(None) => return Flow::Retry("the phone closed the log stream, reconnecting".into()),
            Ok(Some(Err(_))) => return Flow::Retry("lost the phone, reconnecting".into()),
            Ok(Some(Ok(c))) => c,
        };
        partial.extend_from_slice(&chunk);
        let Some(last_nl) = partial.iter().rposition(|&b| b == b'\n') else {
            continue;
        };
        let complete: Vec<u8> = partial.drain(..=last_nl).collect();
        let mut out = String::new();
        for line in String::from_utf8_lossy(&complete).split('\n') {
            // Empty: the phone's keepalive.
            let Some((seq, text)) = line.split_once('\t') else {
                continue;
            };
            if let Ok(seq) = seq.parse::<u64>() {
                *after = Some(seq);
            }
            out.push_str(&format_line(text, color, raw));
            out.push('\n');
        }
        if !out.is_empty() && tx.send(Bytes::from(out)).await.is_err() {
            return Flow::TerminalGone;
        }
    }
}

/// `MM-DD HH:MM:SS.mmm <uid>:<pid> <tid> <L> <tag>: <msg>` from the phone.
/// Without `raw` the uid column goes, leaving `adb logcat -v threadtime`'s
/// usual layout.
fn format_line(line: &str, color: bool, raw: bool) -> String {
    const TS: usize = 18;
    let parsed = line.get(..TS).zip(line.get(TS..)).and_then(|(ts, rest)| {
        let colon = rest.find(':')?;
        let after_uid = &rest[colon + 1..];
        let level = after_uid.split_whitespace().nth(2)?.chars().next()?;
        Some((ts, after_uid, level))
    });
    let Some((ts, after_uid, level)) = parsed else {
        return line.to_string();
    };
    let shown = if raw { line.to_string() } else { format!("{ts} {after_uid}") };
    if !color {
        return shown;
    }
    let code = match level {
        'V' | 'D' => "90",
        'W' => "33",
        'E' => "31",
        'F' | 'A' => "1;31",
        _ => return shown,
    };
    format!("\x1b[{code}m{shown}\x1b[0m")
}

// ---------------------------------------------------------------------------
// PUT /install
// ---------------------------------------------------------------------------

async fn install(State(ctx): State<PresenceContext>, Query(q): Query<HashMap<String, String>>, req: Request) -> Response {
    if let Err(r) = local_caller(req.headers()) {
        return r;
    }
    let Some(length) = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    else {
        return text(
            StatusCode::LENGTH_REQUIRED,
            "Send the APK as a file: curl.exe -T app-debug.apk http://localhost:8378/install\n",
        );
    };
    let phone = match pick_phone(&ctx, q.get("phone").map(String::as_str)).await {
        Ok(p) => p,
        Err(e) => return text(StatusCode::NOT_FOUND, format!("{e}\n")),
    };
    let Some(addr) = addr_of(&ctx, &phone.id) else {
        return text(StatusCode::BAD_GATEWAY, format!("Don't know where {} is yet. Is LANclave open on it?\n", phone.name));
    };

    let mut path = String::from("/api/dev/install");
    if let Some(name) = q.get("name").filter(|n| !n.is_empty()) {
        path.push_str(&format!("?name={}", urlencoding::encode(name)));
    }
    let body = reqwest::Body::wrap_stream(req.into_body().into_data_stream());
    let reply = signed(&ctx, reqwest::Method::PUT, &addr, &path)
        .header(reqwest::header::CONTENT_LENGTH, length)
        .body(body)
        .send()
        .await;
    let reply = match reply {
        Ok(r) => r,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Could not reach {}: {e}\n", phone.name)),
    };
    match reply.status().as_u16() {
        200 => {}
        404 => {
            return text(
                StatusCode::NOT_IMPLEMENTED,
                format!("{} runs the normal LANclave build, which has no developer tools.\n", phone.name),
            )
        }
        code => return text(StatusCode::BAD_GATEWAY, format!("{} answered {code}.\n", phone.name)),
    }
    let result: serde_json::Value = reply.json().await.unwrap_or_default();
    let field = |k: &str| result.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let size = crate::fmt_bytes(length);
    match field("status") {
        "installed" => {
            let pkg = field("package");
            let what = if pkg.is_empty() { "the app".to_string() } else { pkg.to_string() };
            text(StatusCode::OK, format!("Installed {what} on {} ({size}).\n", phone.name))
        }
        "cancelled" => text(StatusCode::CONFLICT, format!("Cancelled on {}.\n", phone.name)),
        "waiting" => text(StatusCode::REQUEST_TIMEOUT, format!("{}\n", field("message"))),
        _ => text(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("Install failed on {}: {}\n", phone.name, field("message")),
        ),
    }
}

// ---------------------------------------------------------------------------
// POST /launch
// ---------------------------------------------------------------------------

/// Open an app on the phone; with `scheme` and `port`, an Expo dev client
/// connected to Metro on this computer. The reply's headers say where its
/// logs start, for `/logs?capture=..&after=..`.
async fn launch(
    State(ctx): State<PresenceContext>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Err(r) = local_caller(&headers) {
        return r;
    }
    let Some(pkg) = q.get("pkg").filter(|p| !p.is_empty()) else {
        return text(StatusCode::BAD_REQUEST, "Which app? Add ?pkg=com.example.app\n");
    };
    let phone = match pick_phone(&ctx, q.get("phone").map(String::as_str)).await {
        Ok(p) => p,
        Err(e) => return text(StatusCode::NOT_FOUND, format!("{e}\n")),
    };
    let Some(addr) = addr_of(&ctx, &phone.id) else {
        return text(StatusCode::BAD_GATEWAY, format!("Don't know where {} is yet. Is LANclave open on it?\n", phone.name));
    };

    let mut path = format!("/api/dev/launch?pkg={}", urlencoding::encode(pkg));
    for key in ["scheme", "port"] {
        if let Some(v) = q.get(key).filter(|v| !v.is_empty()) {
            path.push_str(&format!("&{key}={}", urlencoding::encode(v)));
        }
    }
    let reply = match signed(&ctx, reqwest::Method::POST, &addr, &path)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return text(StatusCode::BAD_GATEWAY, format!("Could not reach {}: {e}\n", phone.name)),
    };
    let code = reply.status().as_u16();
    if code == 404 && reply.headers().get(header::CONTENT_TYPE).is_some_and(|v| v != "application/json") {
        return text(
            StatusCode::NOT_IMPLEMENTED,
            format!("{} runs a LANclave build without launching; install the newest dev build.\n", phone.name),
        );
    }
    let result: serde_json::Value = reply.json().await.unwrap_or_default();
    let field = |k: &str| result.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (status, message) = match (code, field("status").as_str()) {
        (200, "opened") => (StatusCode::OK, format!("Opened {pkg} on {}.\n", phone.name)),
        (200, "notified") => (
            StatusCode::OK,
            format!(
                "Tap the notification on {} to open {pkg}. To skip that next time, allow LANclave to display over other apps (Settings > Developer tools).\n",
                phone.name
            ),
        ),
        _ => (StatusCode::UNPROCESSABLE_ENTITY, format!("Could not open {pkg}: {}\n", field("message"))),
    };
    let mut response = text(status, message);
    if let Some(seq) = result.get("seq").and_then(|v| v.as_u64()) {
        if let Ok(v) = seq.to_string().parse() {
            response.headers_mut().insert("x-lanclave-seq", v);
        }
    }
    if let Ok(v) = field("capture").parse() {
        response.headers_mut().insert("x-lanclave-capture", v);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::format_line;

    #[test]
    fn drops_the_uid_column() {
        let line = "10-19 14:03:12.345 10250: 4567  4580 I MyTag   : hello";
        assert_eq!(format_line(line, false, false), "10-19 14:03:12.345  4567  4580 I MyTag   : hello");
        assert_eq!(format_line(line, false, true), line);
    }

    #[test]
    fn five_digit_pids_and_named_users_keep_their_layout() {
        let line = "10-19 14:03:12.345  root:12345 12345 W init    : x";
        assert_eq!(format_line(line, false, false), "10-19 14:03:12.345 12345 12345 W init    : x");
    }

    #[test]
    fn colours_by_level() {
        let line = "10-19 14:03:12.345 10250: 4567  4580 E MyTag   : boom";
        assert!(format_line(line, true, false).starts_with("\x1b[31m"));
    }

    #[test]
    fn leaves_other_lines_alone() {
        assert_eq!(format_line("--------- beginning of main", true, false), "--------- beginning of main");
    }
}

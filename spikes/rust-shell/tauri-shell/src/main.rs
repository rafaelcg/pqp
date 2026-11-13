//! SPIKE, not product code. The pqp web client in a Tauri 2 window, which on
//! macOS is the system WKWebView instead of a bundled Chromium. It exists to
//! measure startup and memory next to the Electron shell and to probe what the
//! system webview can do for voice (see src/probe.js).
//!
//! Env: PQP_APP_URL (page to load), PQP_COLLECTOR (bench collector base URL),
//! PQP_MARKER (text that means "the channel rendered"), PQP_JOIN=1 (also try to
//! join the Lobby voice channel).

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    let url = std::env::var("PQP_APP_URL").unwrap_or_else(|_| "http://127.0.0.1:4183/app".into());
    let script = include_str!("probe.js")
        .replace(
            "__PQP_COLLECTOR__",
            &std::env::var("PQP_COLLECTOR").unwrap_or_else(|_| "http://127.0.0.1:47999".into()),
        )
        .replace(
            "__PQP_MARKER__",
            &std::env::var("PQP_MARKER").unwrap_or_else(|_| "o estrela é esse".into()),
        )
        .replace("__PQP_JOIN__", &std::env::var("PQP_JOIN").unwrap_or_default())
        .replace("__PQP_SCENARIO__", &std::env::var("PQP_SCENARIO").unwrap_or_default());

    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("pqp (tauri spike)")
                .inner_size(1280.0, 800.0)
                .initialization_script(&script)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri spike failed to start");
}

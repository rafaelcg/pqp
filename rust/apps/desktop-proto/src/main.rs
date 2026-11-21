//! pqp desktop prototype (docs/plans/RUST.md, step D2). A prototype to measure,
//! not a product. What it does and does not do: docs/plans/RUST.md, D2.
//!
//! Environment (all optional; the defaults are the desktop-bench stack):
//!   PQP_API_URL      http://127.0.0.1:3971
//!   PQP_WS_URL       derived from PQP_API_URL, path /ws
//!   PQP_TOKEN        dev-local-token (the LOCAL dev auth bypass; never a real credential)
//!   PQP_SERVER_NAME  Sandbox
//!   PQP_CHANNEL      general
//!   PQP_JOIN         a voice channel to join at start (name or id)
//!   PQP_REAL_MIC=1   publish the platform microphone instead of the synthetic one
//!
//! Stdin, one command per line: join [name] | leave | mute | unmute | deafen |
//! undeafen | status | quit. Stdout, one line per event, for the bench driver:
//! FIRST_CONTENT <unix ms> | READY | SEATED {..} | IN_CALL {..} |
//! REMOTE_AUDIO <peer> | STATUS {..} | ERROR <text> | BYE.

use gpui::{App, Application, Bounds, WindowBounds, WindowOptions, prelude::*, px, size};
use pqp_desktop_proto::controller::{self, Command, Config};
use pqp_desktop_proto::state::Shared;
use pqp_desktop_proto::ui::ChatView;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

fn main() {
    if std::env::var("RUST_LOG").is_ok() {
        env_logger::init();
    }
    let api_url = env_or("PQP_API_URL", "http://127.0.0.1:3971");
    let ws_default = format!("{}/ws", api_url.replacen("http", "ws", 1));
    let cfg = Config {
        ws_url: env_or("PQP_WS_URL", &ws_default),
        api_url,
        token: env_or("PQP_TOKEN", "dev-local-token"),
        server_name: env_or("PQP_SERVER_NAME", "Sandbox"),
        text_channel: env_or("PQP_CHANNEL", "general"),
    };

    let (changed_tx, changed_rx) = futures::channel::mpsc::unbounded::<()>();
    let shared = Shared::new(changed_tx);
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel::<Command>();

    // The network side: its own runtime on its own threads, so GPUI's main
    // thread never waits on a socket and the SDK gets the tokio it expects.
    {
        let shared = shared.clone();
        let self_tx = cmd_tx.clone();
        std::thread::Builder::new()
            .name("pqp-net".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .expect("tokio runtime");
                rt.block_on(controller::run(cfg, shared, cmd_rx, self_tx));
            })
            .expect("network thread");
    }

    // Commands from the bench driver.
    {
        let cmd_tx = cmd_tx.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut line = String::new();
            while stdin.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                if let Some(cmd) = Command::parse(line.trim()) {
                    let _ = cmd_tx.send(cmd);
                }
                line.clear();
            }
        });
    }
    if let Ok(room) = std::env::var("PQP_JOIN")
        && !room.is_empty()
    {
        let _ = cmd_tx.send(Command::Join(room));
    }

    Application::new().run(move |cx: &mut App| {
        // The Electron shell's window size on the bench machine (1280x800),
        // so both draw the same number of pixels.
        let bounds = Bounds::centered(None, size(px(1280.), px(800.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            move |_, cx| cx.new(|cx| ChatView::new(shared, cmd_tx, changed_rx, cx)),
        )
        .expect("open window");
        cx.activate(true);
    });
}

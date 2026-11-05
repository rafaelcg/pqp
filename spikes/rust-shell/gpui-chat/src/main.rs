//! SPIKE, not product code. A native GPUI window that reads a real pqp server
//! from the local API (dev auth bypass) and draws its channel list and message
//! list, so its startup, memory and scrolling can be measured next to the
//! Electron shell on the same machine and the same data.
//!
//! What it deliberately does NOT do: markdown beyond code fences, reactions,
//! embeds, attachments, hover toolbars, tooltips, composer, IME, accessibility,
//! i18n, voice. It is a lower bound for "a native client", not an estimate.
//!
//! Driven over stdin by `spikes/rust-shell/bench/gpui-bench.mjs`:
//!   switch <channel-name> | loadall <rows> | sweep | quit
//! and answers on stdout with `FIRST_CONTENT <unix ms>` and `DONE ...` lines.

use futures::{StreamExt, channel::mpsc};
use gpui::{
    App, Application, Bounds, ClickEvent, Context, ListAlignment, ListOffset, ListState,
    SharedString, Window, WindowBounds, WindowOptions, div, list, prelude::*, px, rgb, size,
};
use serde::Deserialize;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Deserialize, Clone)]
struct ApiChannel {
    id: String,
    name: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct ChannelsResponse {
    channels: Vec<ApiChannel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiMessage {
    id: String,
    author_name: Option<String>,
    body: String,
    created_at: String,
}

#[derive(Deserialize)]
struct MessagesResponse {
    messages: Vec<ApiMessage>,
}

/// A message prepared off the main thread: everything render needs, nothing it
/// has to compute per frame.
struct Row {
    id: String,
    author: SharedString,
    initial: SharedString,
    time: SharedString,
    color: u32,
    /// (is_code, text) blocks, from splitting on ``` fences.
    blocks: Vec<(bool, SharedString)>,
}

const PALETTE: [u32; 8] = [
    0xf97316, 0x22c55e, 0x3b82f6, 0xa855f7, 0xec4899, 0x14b8a6, 0xeab308, 0xef4444,
];

fn prepare(m: ApiMessage) -> Row {
    let author = m.author_name.unwrap_or_else(|| "?".into());
    let color = PALETTE[author.bytes().map(|b| b as usize).sum::<usize>() % PALETTE.len()];
    let initial: String = author.chars().next().unwrap_or('?').to_uppercase().collect();
    let time = m.created_at.get(11..16).unwrap_or("").to_string();
    let mut blocks = Vec::new();
    for (i, part) in m.body.split("```").enumerate() {
        let text = part.trim_matches('\n');
        if text.is_empty() {
            continue;
        }
        let is_code = i % 2 == 1;
        let text = if is_code {
            // Drop the language tag line.
            text.split_once('\n').map(|(_, rest)| rest).unwrap_or(text)
        } else {
            text
        };
        blocks.push((is_code, SharedString::from(text.to_string())));
    }
    Row {
        id: m.id,
        author: author.into(),
        initial: initial.into(),
        time: time.into(),
        color,
        blocks,
    }
}

#[derive(Clone)]
struct Api {
    base: String,
    token: String,
}

impl Api {
    fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, String> {
        ureq::get(&format!("{}{}", self.base, path))
            .set("Authorization", &format!("Bearer {}", self.token))
            .call()
            .map_err(|e| e.to_string())?
            .into_json::<T>()
            .map_err(|e| e.to_string())
    }
    fn channels(&self, server: &str) -> Result<Vec<ApiChannel>, String> {
        Ok(self
            .get::<ChannelsResponse>(&format!("/api/servers/{server}/channels"))?
            .channels)
    }
    fn page(&self, channel: &str, before: Option<&str>, limit: usize) -> Result<Vec<Row>, String> {
        let mut path = format!("/api/channels/{channel}/messages?limit={limit}");
        if let Some(b) = before {
            path.push_str(&format!("&before={b}"));
        }
        Ok(self
            .get::<MessagesResponse>(&path)?
            .messages
            .into_iter()
            .map(prepare)
            .collect())
    }
}

struct Sweep {
    last: Instant,
    frames: Vec<f32>,
    last_top: (usize, f32),
    still: u32,
}

struct ChatView {
    api: Api,
    channels: Vec<ApiChannel>,
    current: Option<usize>,
    rows: Vec<Row>,
    list_state: ListState,
    generation: u64,
    pending_mark: Option<(String, Instant)>,
    first_content_printed: bool,
    sweep: Option<Sweep>,
}

fn unix_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

impl ChatView {
    fn new(api: Api, server: String, cx: &mut Context<Self>) -> Self {
        let boot_api = api.clone();
        cx.spawn(async move |this, cx| {
            let fetched = cx
                .background_executor()
                .spawn(async move {
                    let channels = boot_api.channels(&server)?;
                    let first = channels
                        .iter()
                        .find(|c| c.kind == "text")
                        .cloned()
                        .ok_or("no text channel")?;
                    let rows = boot_api.page(&first.id, None, 50)?;
                    Ok::<_, String>((channels, first.id, rows))
                })
                .await;
            match fetched {
                Ok((channels, first_id, rows)) => {
                    this.update(cx, |view, cx| {
                        view.current = channels.iter().position(|c| c.id == first_id);
                        view.channels = channels;
                        view.set_rows(rows);
                        view.pending_mark = Some(("first".into(), Instant::now()));
                        cx.notify();
                    })
                    .ok();
                }
                Err(e) => eprintln!("boot failed: {e}"),
            }
        })
        .detach();

        // Commands from the benchmark driver.
        let (tx, mut rx) = mpsc::unbounded::<String>();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            let mut line = String::new();
            while stdin.read_line(&mut line).map(|n| n > 0).unwrap_or(false) {
                let _ = tx.unbounded_send(line.trim().to_string());
                line.clear();
            }
        });
        cx.spawn(async move |this, cx| {
            while let Some(cmd) = rx.next().await {
                if this.update(cx, |view, cx| view.command(&cmd, cx)).is_err() {
                    break;
                }
            }
        })
        .detach();

        Self {
            api,
            channels: Vec::new(),
            current: None,
            rows: Vec::new(),
            list_state: ListState::new(0, ListAlignment::Bottom, px(800.)),
            generation: 0,
            pending_mark: None,
            first_content_printed: false,
            sweep: None,
        }
    }

    fn set_rows(&mut self, rows: Vec<Row>) {
        self.rows = rows;
        self.list_state.reset(self.rows.len());
    }

    fn command(&mut self, cmd: &str, cx: &mut Context<Self>) {
        let mut parts = cmd.split_whitespace();
        match parts.next() {
            Some("switch") => {
                let name = parts.next().unwrap_or("");
                if let Some(ix) = self.channels.iter().position(|c| c.name == name) {
                    self.open_channel(ix, Some(format!("switch {name}")), cx);
                }
            }
            Some("loadall") => {
                let target: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(2000);
                self.load_history(target, cx);
            }
            Some("sweep") => {
                // A lazily measured list only knows the heights of rows it has
                // laid out, so a pixel scroll clamps at that extent. Measure
                // every row first (the first frame pays for it, reported as
                // firstFrameMs) and then scroll the whole height, like the
                // browser does with a fully mounted transcript.
                self.list_state =
                    ListState::new(self.rows.len(), ListAlignment::Bottom, px(800.)).measure_all();
                self.list_state.scroll_to(ListOffset {
                    item_ix: 0,
                    offset_in_item: px(0.),
                });
                self.sweep = Some(Sweep {
                    last: Instant::now(),
                    frames: Vec::new(),
                    last_top: (usize::MAX, 0.),
                    still: 0,
                });
                cx.notify();
            }
            Some("quit") => cx.quit(),
            _ => {}
        }
    }

    fn open_channel(&mut self, ix: usize, mark: Option<String>, cx: &mut Context<Self>) {
        let started = Instant::now();
        self.generation += 1;
        let generation = self.generation;
        self.current = Some(ix);
        let channel = self.channels[ix].id.clone();
        let api = self.api.clone();
        cx.spawn(async move |this, cx| {
            let rows = cx
                .background_executor()
                .spawn(async move { api.page(&channel, None, 50) })
                .await;
            if let Ok(rows) = rows {
                this.update(cx, |view, cx| {
                    if view.generation != generation {
                        return;
                    }
                    view.set_rows(rows);
                    if let Some(label) = mark {
                        view.pending_mark = Some((label, started));
                    }
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
        cx.notify();
    }

    /// Page backwards 100 at a time until `target` rows are held, the way the
    /// web client does on scroll-to-top (it pages by 50).
    fn load_history(&mut self, target: usize, cx: &mut Context<Self>) {
        let started = Instant::now();
        let Some(ix) = self.current else { return };
        let channel = self.channels[ix].id.clone();
        let api = self.api.clone();
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            let mut pages = 0;
            loop {
                let Ok(Some((oldest, have))) = this.update(cx, |view, _| {
                    view.rows.first().map(|r| (r.id.clone(), view.rows.len()))
                }) else {
                    break;
                };
                if have >= target {
                    break;
                }
                let api = api.clone();
                let channel = channel.clone();
                let older = cx
                    .background_executor()
                    .spawn(async move { api.page(&channel, Some(&oldest), 100) })
                    .await;
                let Ok(older) = older else { break };
                if older.is_empty() {
                    break;
                }
                pages += 1;
                let ok = this.update(cx, |view, cx| {
                    if view.generation != generation {
                        return false;
                    }
                    let n = older.len();
                    view.rows.splice(0..0, older);
                    view.list_state.splice(0..0, n);
                    cx.notify();
                    true
                });
                if !matches!(ok, Ok(true)) {
                    break;
                }
            }
            this.update(cx, |view, cx| {
                view.pending_mark = Some((format!("loadall {} pages={pages}", view.rows.len()), started));
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn render_row(&mut self, ix: usize, _window: &mut Window, _cx: &mut Context<Self>) -> gpui::AnyElement {
        let row = &self.rows[ix];
        let mut body = div().flex().flex_col().gap_1();
        for (is_code, text) in &row.blocks {
            if *is_code {
                body = body.child(
                    div()
                        .font_family("Menlo")
                        .text_sm()
                        .bg(rgb(0x1e1f22))
                        .rounded_md()
                        .p_2()
                        .child(text.clone()),
                );
            } else {
                body = body.child(div().text_color(rgb(0xdbdee1)).child(text.clone()));
            }
        }
        div()
            .px_4()
            .py_1()
            .flex()
            .gap_3()
            .child(
                div()
                    .size(px(36.))
                    .flex_none()
                    .rounded_full()
                    .bg(rgb(row.color))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(rgb(0xffffff))
                    .child(row.initial.clone()),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w(px(0.))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .items_center()
                            .child(div().text_color(rgb(row.color)).child(row.author.clone()))
                            .child(div().text_xs().text_color(rgb(0x949ba4)).child(row.time.clone())),
                    )
                    .child(body),
            )
            .into_any_element()
    }
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some((label, started)) = self.pending_mark.take() {
            let first = label == "first" && !self.first_content_printed;
            if label == "first" {
                self.first_content_printed = true;
            }
            window.on_next_frame(move |_, _| {
                if first {
                    println!("FIRST_CONTENT {}", unix_ms());
                } else {
                    println!("DONE {label} {}", started.elapsed().as_millis());
                }
            });
        }

        let mut sweep_done = None;
        if let Some(sweep) = self.sweep.as_mut() {
            let now = Instant::now();
            sweep.frames.push((now - sweep.last).as_secs_f32() * 1000.);
            sweep.last = now;
            let top = self.list_state.logical_scroll_top();
            let key = (top.item_ix, f32::from(top.offset_in_item));
            if key == sweep.last_top {
                sweep.still += 1;
            } else {
                sweep.still = 0;
                sweep.last_top = key;
            }
            if sweep.still >= 5 || sweep.frames.len() > 20_000 {
                sweep_done = Some(std::mem::take(&mut sweep.frames));
            } else {
                self.list_state.scroll_by(px(120.));
                window.request_animation_frame();
            }
        }
        if let Some(mut frames) = sweep_done {
            self.sweep = None;
            // frames[0] is the command-to-first-frame gap; frames[1] is the
            // frame that measured every row.
            frames.remove(0);
            let first_frame = if frames.is_empty() { 0. } else { frames.remove(0) };
            let mut sorted = frames.clone();
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let pct = |p: f32| sorted[((sorted.len() as f32 * p) as usize).min(sorted.len() - 1)];
            println!(
                "DONE sweep {{\"firstFrameMs\":{:.1},\"frames\":{},\"p50\":{:.1},\"p95\":{:.1},\"max\":{:.1},\"over33ms\":{}}}",
                first_frame,
                frames.len(),
                pct(0.5),
                pct(0.95),
                sorted.last().copied().unwrap_or(0.),
                frames.iter().filter(|f| **f > 33.4).count()
            );
        }

        let sidebar = div()
            .w(px(240.))
            .h_full()
            .flex_none()
            .bg(rgb(0x2b2d31))
            .flex()
            .flex_col()
            .p_2()
            .gap_1()
            .child(div().px_2().py_2().text_color(rgb(0xffffff)).child("Sandbox"))
            .children(self.channels.iter().enumerate().filter(|(_, c)| c.kind == "text").map(|(ix, c)| {
                let selected = self.current == Some(ix);
                div()
                    .id(SharedString::from(format!("chan-{}", c.id)))
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .when(selected, |d| d.bg(rgb(0x404249)))
                    .hover(|d| d.bg(rgb(0x35373c)))
                    .text_color(rgb(if selected { 0xffffff } else { 0x949ba4 }))
                    .child(format!("# {}", c.name))
                    .on_click(cx.listener(move |view, _: &ClickEvent, _, cx| {
                        view.open_channel(ix, None, cx);
                    }))
            }));

        let title = self
            .current
            .and_then(|ix| self.channels.get(ix))
            .map(|c| format!("# {}", c.name))
            .unwrap_or_default();

        div()
            .size_full()
            .flex()
            .bg(rgb(0x313338))
            .text_color(rgb(0xdbdee1))
            .child(sidebar)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .h_full()
                    .min_w(px(0.))
                    .child(div().px_4().py_3().text_color(rgb(0xffffff)).child(title))
                    .child(
                        list(self.list_state.clone(), cx.processor(Self::render_row))
                            .flex_1()
                            .size_full(),
                    ),
            )
    }
}

fn main() {
    let api = Api {
        base: std::env::var("PQP_API_URL").unwrap_or_else(|_| "http://localhost:3011".into()),
        token: std::env::var("PQP_TOKEN").unwrap_or_else(|_| "dev-local-token".into()),
    };
    let server = std::env::var("PQP_SERVER_ID").expect("PQP_SERVER_ID");
    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1200.), px(800.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            move |_, cx| cx.new(|cx| ChatView::new(api, server, cx)),
        )
        .unwrap();
        cx.activate(true);
    });
}

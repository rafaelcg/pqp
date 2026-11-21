//! The window: one server, its channel list with who is in each voice room,
//! the latest messages of one text channel (read only), and the call controls.
//! Deliberately plain: no markdown, avatars, reactions, composer, IME or
//! accessibility work. A lower bound for a native client, not an estimate.

use crate::controller::Command;
use crate::state::{CallPhase, Shared, SocketState, bench_line};
use futures::StreamExt;
use futures::channel::mpsc::UnboundedReceiver;
use gpui::{
    ClickEvent, Context, ListAlignment, ListState, SharedString, Window, div, list, prelude::*, px,
    rgb,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::UnboundedSender;

const PALETTE: [u32; 8] = [
    0xf97316, 0x22c55e, 0x3b82f6, 0xa855f7, 0xec4899, 0x14b8a6, 0xeab308, 0xef4444,
];

fn color_for(name: &str) -> u32 {
    PALETTE[name.bytes().map(|b| b as usize).sum::<usize>() % PALETTE.len()]
}

pub struct ChatView {
    shared: Shared,
    commands: UnboundedSender<Command>,
    list_state: ListState,
    rows: usize,
    first_content_printed: bool,
}

impl ChatView {
    pub fn new(
        shared: Shared,
        commands: UnboundedSender<Command>,
        mut changed: UnboundedReceiver<()>,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.spawn(async move |this, cx| {
            while changed.next().await.is_some() {
                // Coalesce a burst of pings into one redraw.
                while changed.try_recv().is_ok() {}
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            shared,
            commands,
            list_state: ListState::new(0, ListAlignment::Bottom, px(800.)),
            rows: 0,
            first_content_printed: false,
        }
    }

    fn send(&self, cmd: Command) {
        let _ = self.commands.send(cmd);
    }

    fn render_row(
        &mut self,
        ix: usize,
        _w: &mut Window,
        _cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let s = self.shared.read();
        let Some(m) = s.messages.get(ix) else {
            return div().into_any_element();
        };
        let color = color_for(&m.author);
        let initial: String = m
            .author
            .chars()
            .next()
            .unwrap_or('?')
            .to_uppercase()
            .collect();
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
                    .bg(rgb(color))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(rgb(0xffffff))
                    .child(initial),
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
                            .child(div().text_color(rgb(color)).child(m.author.clone()))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(rgb(0x949ba4))
                                    .child(m.time.clone()),
                            ),
                    )
                    .child(div().text_color(rgb(0xdbdee1)).child(m.body.clone())),
            )
            .into_any_element()
    }
}

fn button(id: &str, label: &str, on: bool) -> gpui::Stateful<gpui::Div> {
    div()
        .id(SharedString::from(id.to_string()))
        .px_2()
        .py_1()
        .rounded_md()
        .cursor_pointer()
        .bg(rgb(if on { 0xda373c } else { 0x404249 }))
        .hover(|d| d.bg(rgb(0x4e5058)))
        .text_sm()
        .text_color(rgb(0xffffff))
        .child(label.to_string())
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let s = self.shared.read();
        if s.messages.len() != self.rows {
            self.rows = s.messages.len();
            self.list_state.reset(self.rows);
        }
        if !self.first_content_printed && self.rows > 0 {
            self.first_content_printed = true;
            window.on_next_frame(|_, _| {
                let ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis();
                bench_line("FIRST_CONTENT", ms);
            });
        }

        let in_room = s.call.voice_channel_id.clone();
        let mut sidebar = div()
            .w(px(240.))
            .h_full()
            .flex_none()
            .bg(rgb(0x2b2d31))
            .flex()
            .flex_col()
            .p_2()
            .gap_1()
            .child(
                div()
                    .px_2()
                    .py_2()
                    .text_color(rgb(0xffffff))
                    .child(s.server_name.clone()),
            );

        for c in &s.channels {
            let selected = s.text_channel_id.as_deref() == Some(c.id.as_str());
            match c.kind.as_str() {
                "text" => {
                    sidebar = sidebar.child(
                        div()
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .when(selected, |d| d.bg(rgb(0x404249)))
                            .text_color(rgb(if selected { 0xffffff } else { 0x949ba4 }))
                            .child(format!("# {}", c.name)),
                    );
                }
                "voice" => {
                    let id = c.id.clone();
                    let here = in_room.as_deref() == Some(c.id.as_str());
                    sidebar = sidebar.child(
                        div()
                            .id(SharedString::from(format!("voice-{}", c.id)))
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .cursor_pointer()
                            .when(here, |d| d.bg(rgb(0x404249)))
                            .hover(|d| d.bg(rgb(0x35373c)))
                            .text_color(rgb(if here { 0xffffff } else { 0x949ba4 }))
                            .child(format!("> {}", c.name))
                            .on_click(cx.listener(move |view, _: &ClickEvent, _, _| {
                                view.send(Command::Join(id.clone()));
                            })),
                    );
                    if let Some(room) = s.rosters.rooms.get(&c.id) {
                        for p in room.values() {
                            let speaking = s.call.speaking.contains(&p.peer_id);
                            let mut label = p.display_name.clone();
                            if p.deafened {
                                label.push_str("  (deafened)");
                            } else if p.muted {
                                label.push_str("  (muted)");
                            }
                            sidebar = sidebar.child(
                                div()
                                    .pl_6()
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .text_sm()
                                    .text_color(rgb(0xb5bac1))
                                    .child(div().size(px(8.)).rounded_full().bg(rgb(if speaking {
                                        0x23a55a
                                    } else {
                                        0x4e5058
                                    })))
                                    .child(label),
                            );
                        }
                    }
                }
                _ => {}
            }
        }

        // Call panel.
        let phase = match &s.call.phase {
            CallPhase::Idle => None,
            CallPhase::Joining => Some("Joining...".to_string()),
            CallPhase::Connecting => Some("Connecting to the SFU...".to_string()),
            CallPhase::Connected => Some("Voice connected".to_string()),
            CallPhase::Failed(e) => Some(format!("Voice failed: {e}")),
        };
        if let Some(phase) = phase {
            let level = if s.call.remote_level_dbfs.is_finite() {
                format!("others: {:.0} dBFS", s.call.remote_level_dbfs)
            } else {
                "others: silent".to_string()
            };
            let muted = s.call.muted;
            let deafened = s.call.deafened;
            sidebar = sidebar.child(div().flex_1()).child(
                div()
                    .p_2()
                    .rounded_md()
                    .bg(rgb(0x232428))
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(div().text_sm().text_color(rgb(0x23a55a)).child(phase))
                    .child(div().text_xs().text_color(rgb(0x949ba4)).child(level))
                    .child(
                        div()
                            .flex()
                            .gap_1()
                            .child(
                                button("mute", if muted { "Unmute" } else { "Mute" }, muted)
                                    .on_click(cx.listener(move |view, _: &ClickEvent, _, _| {
                                        view.send(Command::Mute(!muted))
                                    })),
                            )
                            .child(
                                button(
                                    "deafen",
                                    if deafened { "Undeafen" } else { "Deafen" },
                                    deafened,
                                )
                                .on_click(cx.listener(
                                    move |view, _: &ClickEvent, _, _| {
                                        view.send(Command::Deafen(!deafened))
                                    },
                                )),
                            )
                            .child(button("leave", "Leave", false).on_click(
                                cx.listener(|view, _: &ClickEvent, _, _| view.send(Command::Leave)),
                            )),
                    ),
            );
        }

        let title = s
            .text_channel_id
            .as_ref()
            .and_then(|id| s.channels.iter().find(|c| &c.id == id))
            .map(|c| format!("# {}", c.name))
            .unwrap_or_default();
        let socket = match &s.socket {
            SocketState::Ready => String::new(),
            SocketState::Connecting => "connecting...".into(),
            SocketState::Closed(e) => format!("offline: {e}"),
        };
        let error = s.error.clone().unwrap_or_default();
        drop(s);

        div()
            .size_full()
            .flex()
            .bg(rgb(0x313338))
            .text_color(rgb(0xdbdee1))
            .child(
                // Server rail: one hall.
                div()
                    .w(px(64.))
                    .h_full()
                    .flex_none()
                    .bg(rgb(0x1e1f22))
                    .flex()
                    .flex_col()
                    .items_center()
                    .pt_3()
                    .child(
                        div()
                            .size(px(44.))
                            .rounded_xl()
                            .bg(rgb(0x5865f2))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_color(rgb(0xffffff))
                            .child("S"),
                    ),
            )
            .child(sidebar)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .h_full()
                    .min_w(px(0.))
                    .child(
                        div()
                            .px_4()
                            .py_3()
                            .flex()
                            .gap_3()
                            .child(div().text_color(rgb(0xffffff)).child(title))
                            .child(div().text_xs().text_color(rgb(0x949ba4)).child(socket))
                            .child(div().text_xs().text_color(rgb(0xda373c)).child(error)),
                    )
                    .child(
                        list(self.list_state.clone(), cx.processor(Self::render_row))
                            .flex_1()
                            .size_full(),
                    ),
            )
    }
}

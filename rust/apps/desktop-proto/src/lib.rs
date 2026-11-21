//! pqp desktop prototype (docs/plans/RUST.md, step D2). The wire module builds
//! on its own (no features); everything else is the `app` feature.

pub mod wire;

#[cfg(feature = "app")]
pub mod call;
#[cfg(feature = "app")]
pub mod controller;
#[cfg(feature = "app")]
pub mod state;
#[cfg(feature = "app")]
pub mod ui;

//! Native voice engine: microphone capture and speaker playback.
//!
//! napi-free by design. `pi-natives` wraps these types in thin `#[napi]`
//! adapters so the engine rebuilds only when voice code changes.
//!
//! # Architecture
//! ```text
//! JS (packages/natives) -> #[napi] adapters (pi-natives audio.rs)
//!   -> pi_voice::audio (capture/playback engine over in-house OS backends)
//! ```

pub mod audio;
pub(crate) mod device;

/// Engine-level result: a human-readable failure message the N-API layer maps
/// to a JS error verbatim.
pub type VoiceResult<T> = std::result::Result<T, String>;

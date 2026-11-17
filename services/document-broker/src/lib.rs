//! Experimental IPC boundary. All real execution remains unavailable.
pub mod protocol;
pub mod systemd_probe;
pub mod transport;
pub use protocol::{decode_frame, validate_frame};

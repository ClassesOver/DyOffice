//! Experimental IPC boundary. All real execution remains unavailable.
pub mod protocol;
pub mod systemd_probe;
pub mod transport;
pub use protocol::{decode_frame, validate_frame};

// Mutating Manager calls exist ONLY in a private test model, never production builds.
#[cfg(test)]
mod manager_model;

pub mod unit_policy;

#[cfg(target_os = "linux")]
pub mod sealed_bytes;

#[cfg(target_os = "linux")]
pub mod sealed_transfer;

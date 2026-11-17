//! Experimental IPC boundary. All real execution remains unavailable.
//!
//! No external launch configuration or driver connection API:
//! ```compile_fail
//! use dyoffice_document_broker::launch_spec::LaunchSpec;
//! ```
//! ```compile_fail
//! use dyoffice_document_broker::systemd_driver::Attempt;
//! ```
pub mod protocol;
pub mod systemd_probe;
pub mod transport;
pub use protocol::{decode_frame, validate_frame};

// Historical offline model. The private production-compiled driver below remains
// unreachable without an approved runtime; no public launch API is exposed.
#[cfg(test)]
mod manager_model;

pub mod unit_policy;

#[cfg(target_os = "linux")]
pub mod sealed_bytes;

#[cfg(target_os = "linux")]
pub mod sealed_transfer;

pub mod manager_diagnostic;

#[allow(dead_code)]
mod launch_spec;
#[allow(dead_code)]
mod systemd_driver;

// Private restricted database observations, not runtime admission.
#[allow(dead_code)]
mod dispatch_ledger;

#[cfg(test)]
mod container_probe;

#[allow(dead_code)]
mod unit_binding;

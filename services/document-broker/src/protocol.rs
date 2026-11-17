use serde::{Deserialize, Serialize};
pub const MAX_FRAME: usize = 64 * 1024;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Protocol,
    Limit,
    Identity,
    Peer,
    Timeout,
    Disconnected,
    Busy,
    Replay,
    Disabled,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextRef {
    pub id: String,
    pub version: u64,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentRequest {
    pub protocol_version: u8,
    pub deployment_id: String,
    pub tenant_id: String,
    pub actor_id: String,
    pub session_binding_digest: String,
    pub file_id: String,
    pub editor_id: String,
    pub lease_epoch: u64,
    pub base_revision: String,
    pub generation: u64,
    pub job_id: String,
    pub attempt: u64,
    pub job_epoch: u64,
    pub input_sha256: String,
    pub input_size: u64,
    pub profile_id: String,
    pub runtime_digest: String,
    pub policy_version: u64,
    pub deadline_at: String,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Probe,
    Start,
    Stop,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlFrame {
    pub protocol_version: u8,
    pub request_id: String,
    pub broker_boot_id: String,
    pub context: ContextRef,
    pub operation: Operation,
    pub request: DocumentRequest,
}
pub fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
}
fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn positive(n: u64) -> bool {
    (1..=MAX_SAFE_INTEGER).contains(&n)
}
pub fn decode_frame(bytes: &[u8]) -> Result<ControlFrame, Error> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(Error::Limit);
    }
    let f: ControlFrame = serde_json::from_slice(bytes).map_err(|_| Error::Protocol)?;
    let r = &f.request;
    if f.protocol_version != 1
        || r.protocol_version != 1
        || !uuid(&f.request_id)
        || !uuid(&f.broker_boot_id)
        || !uuid(&f.context.id)
        || !positive(f.context.version)
        || [
            &r.deployment_id,
            &r.tenant_id,
            &r.actor_id,
            &r.file_id,
            &r.editor_id,
            &r.base_revision,
            &r.job_id,
        ]
        .iter()
        .any(|s| !uuid(s))
        || [
            &r.session_binding_digest,
            &r.input_sha256,
            &r.runtime_digest,
        ]
        .iter()
        .any(|s| !digest(s))
        || !positive(r.lease_epoch)
        || !positive(r.attempt)
        || !positive(r.job_epoch)
        || r.generation != 0
        || r.policy_version != 1
        || r.profile_id != "pptx-edit-v1"
        || r.input_size == 0
        || r.input_size > 32 * 1024 * 1024
    {
        return Err(Error::Protocol);
    }
    let d = &r.deadline_at;
    if d.len() != 24
        || !d.is_ascii()
        || d.as_bytes()[10] != b'T'
        || d.as_bytes()[19] != b'.'
        || !d.ends_with('Z')
        || &d[17..19] > "59"
        || time::OffsetDateTime::parse(d, &time::format_description::well_known::Rfc3339).is_err()
    {
        return Err(Error::Protocol);
    }
    Ok(f)
}
pub fn validate_frame(bytes: &[u8]) -> bool {
    decode_frame(bytes).is_ok()
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Denial {
    pub protocol_version: u8,
    pub request_id: String,
    pub broker_boot_id: String,
    pub status: Status,
    pub reason: Reason,
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Status {
    #[serde(rename = "disabled")]
    Disabled,
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Reason {
    #[serde(rename = "REAL_BACKEND_UNAVAILABLE")]
    RealBackendUnavailable,
}

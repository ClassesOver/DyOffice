//! Real socketpair IPC, not a deployed listener or tenant authorizer.
//! FD transfer is unsupported: read() discards ancillary messages; no FD is adopted.
use crate::protocol::{ControlFrame, Denial, Error, MAX_FRAME, Reason, Status, decode_frame};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    sync::Semaphore,
    time::timeout,
};
#[derive(Clone)]
pub struct ProbeBroker {
    binding: ControlFrame,
    uid: u32,
    slots: Arc<Semaphore>,
    seen: Arc<Mutex<HashSet<String>>>,
}
impl ProbeBroker {
    pub fn new(binding: ControlFrame, uid: u32) -> Result<Self, Error> {
        decode_frame(&serde_json::to_vec(&binding).map_err(|_| Error::Protocol)?)?;
        if uid == 0 {
            return Err(Error::Peer);
        }
        Ok(Self {
            binding,
            uid,
            slots: Arc::new(Semaphore::new(2)),
            seen: Arc::new(Mutex::new(HashSet::new())),
        })
    }
    pub async fn serve_one(&self, mut stream: UnixStream, budget: Duration) -> Result<(), Error> {
        if budget.is_zero() || budget > Duration::from_secs(5) {
            return Err(Error::Limit);
        }
        let _slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        if stream.peer_cred().map_err(|_| Error::Peer)?.uid() != self.uid {
            return Err(Error::Peer);
        }
        // One absolute deadline includes the length header, body, EOF and response.
        timeout(budget, async {
            let length = stream.read_u32().await.map_err(|_| Error::Disconnected)? as usize;
            if length == 0 || length > MAX_FRAME {
                return Err(Error::Limit);
            }
            let mut body = vec![0; length];
            stream
                .read_exact(&mut body)
                .await
                .map_err(|_| Error::Disconnected)?;
            let mut extra = [0; 1];
            if stream
                .read(&mut extra)
                .await
                .map_err(|_| Error::Disconnected)?
                != 0
            {
                return Err(Error::Protocol);
            }
            let frame = decode_frame(&body)?;
            if frame.broker_boot_id != self.binding.broker_boot_id
                || frame.context != self.binding.context
                || frame.request != self.binding.request
            {
                return Err(Error::Identity);
            }
            {
                let mut seen = self.seen.lock().map_err(|_| Error::Busy)?;
                if seen.contains(&frame.request_id) {
                    return Err(Error::Replay);
                }
                if seen.len() >= 1024 {
                    return Err(Error::Busy);
                }
                seen.insert(frame.request_id.clone());
            }
            let denied = Denial {
                protocol_version: 1,
                request_id: frame.request_id,
                broker_boot_id: self.binding.broker_boot_id.clone(),
                status: Status::Disabled,
                reason: Reason::RealBackendUnavailable,
            };
            let response = serde_json::to_vec(&denied).map_err(|_| Error::Protocol)?;
            if response.len() > 1024 {
                return Err(Error::Limit);
            }
            stream
                .write_u32(response.len() as u32)
                .await
                .map_err(|_| Error::Disconnected)?;
            stream
                .write_all(&response)
                .await
                .map_err(|_| Error::Disconnected)?;
            stream.shutdown().await.map_err(|_| Error::Disconnected)
        })
        .await
        .map_err(|_| Error::Timeout)?
    }
}

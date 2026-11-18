//! Private request/content binding only, not authenticated admission or execution.

use crate::{
    protocol::{ControlFrame, Error, Operation, decode_frame},
    sealed_transfer::{ReceivedSealedBytes, SealedReceiver},
};
use sha2::{Digest, Sha256};

// Fields cannot be constructed externally and there is no conversion to ApprovedRuntime.
pub(crate) struct BoundInput {
    frame: ControlFrame,
    bytes: ReceivedSealedBytes,
}
impl BoundInput {
    pub(crate) fn receive(
        receiver: SealedReceiver,
        expected: ControlFrame,
        wire: &[u8],
    ) -> Result<Self, Error> {
        let frame = decode_frame(wire)?;
        if frame.operation != Operation::Start || frame != expected {
            return Err(Error::Identity);
        }
        // The existing receiver enforces nonempty <=64KiB, exactly one regular
        // readable fd, CLOEXEC, and WRITE/GROW/SHRINK/SEAL before any content read.
        // Owning receiver ensures queued descriptors also close on early errors.
        let bytes = receiver.receive().map_err(|_| Error::Protocol)?;
        let content = bytes.read_bytes().map_err(|_| Error::Protocol)?;
        if content.len() as u64 != frame.request.input_size
            || Sha256::digest(&content)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
                != frame.request.input_sha256
        {
            return Err(Error::Identity);
        }
        Ok(Self { frame, bytes })
    }
    pub(crate) fn read_for(&self, frame: &ControlFrame) -> Result<Vec<u8>, Error> {
        if frame != &self.frame {
            return Err(Error::Identity);
        }
        self.bytes.read_bytes().map_err(|_| Error::Protocol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        protocol::{ControlFrame, Operation},
        sealed_bytes::SealedBytes,
        sealed_transfer::sealed_socketpair,
    };
    fn expected() -> ControlFrame {
        let mut f: ControlFrame =
            serde_json::from_str(include_str!("../tests/fixtures/control-frame.json")).unwrap();
        f.operation = Operation::Start;
        // NIST SHA-256 vector for ASCII abc.
        f.request.input_sha256 =
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into();
        f
    }
    fn bind(
        bytes: &[u8],
        expected: ControlFrame,
        wire: &ControlFrame,
    ) -> Result<BoundInput, crate::protocol::Error> {
        let (sender, receiver) = sealed_socketpair().unwrap();
        sender.send(&SealedBytes::new(bytes).unwrap()).unwrap();
        BoundInput::receive(receiver, expected, &serde_json::to_vec(wire).unwrap())
    }
    #[test]
    fn real_sealed_transfer_binds_content_and_exact_request_identity() {
        if std::env::var_os("DYOFFICE_BOUND_INPUT_CHILD").is_none() {
            let status=std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "bound_input::tests::real_sealed_transfer_binds_content_and_exact_request_identity"])
                .env("DYOFFICE_BOUND_INPUT_CHILD", "1").status().unwrap();
            assert!(status.success());
            return;
        }
        let before = std::fs::read_dir("/proc/self/fd").unwrap().count();
        {
            let f = expected();
            let input = bind(b"abc", f.clone(), &f).unwrap();
            assert_eq!(input.read_for(&f).unwrap(), b"abc");
            // A shared open-file offset cannot affect hashing or subsequent reads.
            let mut duplicate = std::fs::File::from(rustix::io::dup(&input.bytes).unwrap());
            use std::io::{Seek, SeekFrom};
            duplicate.seek(SeekFrom::Start(2)).unwrap();
            assert_eq!(input.read_for(&f).unwrap(), b"abc");
            assert_eq!(duplicate.stream_position().unwrap(), 2);
            assert_eq!(
                rustix::io::pwrite(&input.bytes, b"x", 0),
                Err(rustix::io::Errno::PERM)
            );
            let large = vec![b'x'; crate::sealed_bytes::MAX_SEALED_BYTES];
            let mut limit = f.clone();
            limit.request.input_size = large.len() as u64;
            limit.request.input_sha256 = Sha256::digest(&large)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(
                bind(&large, limit.clone(), &limit)
                    .unwrap()
                    .read_for(&limit)
                    .unwrap(),
                large
            );
            limit.request.input_size += 1;
            assert!(bind(&large, limit.clone(), &limit).is_err());
            let (sender, receiver) = sealed_socketpair().unwrap();
            drop(sender);
            assert!(
                BoundInput::receive(receiver, f.clone(), &serde_json::to_vec(&f).unwrap()).is_err()
            );
            let mut changed = f.clone();
            changed.request_id = "dddddddd-dddd-dddd-dddd-dddddddddddd".into();
            assert!(input.read_for(&changed).is_err());
            assert!(
                bind(b"abd", f.clone(), &f).is_err(),
                "same-length substitution"
            );
            assert!(bind(b"ab", f.clone(), &f).is_err(), "size mismatch");
            for field in [
                "requestId",
                "brokerBootId",
                "context",
                "tenantId",
                "fileId",
                "attempt",
            ] {
                let mut v = serde_json::to_value(&f).unwrap();
                match field {
                    "context" => v["context"]["version"] = 2.into(),
                    "tenantId" | "fileId" => {
                        v["request"][field] = "dddddddd-dddd-dddd-dddd-dddddddddddd".into()
                    }
                    "attempt" => v["request"][field] = 2.into(),
                    _ => v[field] = "dddddddd-dddd-dddd-dddd-dddddddddddd".into(),
                }
                let changed = serde_json::from_value(v).unwrap();
                assert!(bind(b"abc", f.clone(), &changed).is_err(), "{field}");
            }
            let mut probe = f.clone();
            probe.operation = Operation::Probe;
            assert!(bind(b"abc", probe.clone(), &probe).is_err());
            let (sender, receiver) = sealed_socketpair().unwrap();
            sender.send(&SealedBytes::new(b"abc").unwrap()).unwrap();
            assert!(BoundInput::receive(receiver, f.clone(), &vec![b' '; 65537]).is_err());
        }
        assert_eq!(std::fs::read_dir("/proc/self/fd").unwrap().count(), before);
    }
}

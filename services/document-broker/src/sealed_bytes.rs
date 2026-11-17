//! Bounded immutable bytes, not provenance, authorization, or an execution grant.
use rustix::fs::{MemfdFlags, SealFlags, fcntl_add_seals, fcntl_get_seals, memfd_create};
use std::fs::File;
use std::io::{self, Write};
use std::os::fd::{AsFd, BorrowedFd};

/// Conservative prototype cap, not an approved document upload limit.
pub const MAX_SEALED_BYTES: usize = 65_536;

/// Owns a sealed anonymous Linux file. No pathname or execution interface.
#[derive(Debug)]
pub struct SealedBytes {
    file: File,
    len: usize,
}

impl SealedBytes {
    /// Copies bytes before publishing the descriptor. Any failure drops the fd;
    /// there is deliberately no temporary-file fallback.
    pub fn new(bytes: &[u8]) -> io::Result<Self> {
        if bytes.is_empty() || bytes.len() > MAX_SEALED_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "sealed bytes limit",
            ));
        }
        let fd = memfd_create(
            "dyoffice-sealed-bytes",
            MemfdFlags::CLOEXEC | MemfdFlags::ALLOW_SEALING,
        )?;
        let mut file = File::from(fd);
        file.write_all(bytes)?;
        let required = SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::SEAL;
        fcntl_add_seals(&file, required)?;
        if !fcntl_get_seals(&file)?.contains(required)
            || file.metadata()?.len() != bytes.len() as u64
        {
            return Err(io::Error::other("sealed bytes verification failed"));
        }
        Ok(Self {
            file,
            len: bytes.len(),
        })
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

impl AsFd for SealedBytes {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.file.as_fd()
    }
}

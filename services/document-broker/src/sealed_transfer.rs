//! Experimental local descriptor handoff. Not an authenticated broker protocol.
use crate::sealed_bytes::{MAX_SEALED_BYTES, SealedBytes};
use rustix::fs::{FileType, SealFlags, fcntl_get_seals, fstat};
use rustix::net::{
    AddressFamily, RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, ReturnFlags,
    SendAncillaryBuffer, SendAncillaryMessage, SendFlags, SocketFlags, SocketType, recvmsg,
    sendmsg, socketpair,
};
use std::{
    fs::File,
    io::{self, IoSlice, IoSliceMut},
    mem::MaybeUninit,
    os::{
        fd::{AsFd, BorrowedFd, OwnedFd},
        unix::fs::FileExt,
    },
};

#[derive(Debug)]
pub struct SealedSender(OwnedFd);
#[derive(Debug)]
pub struct SealedReceiver(OwnedFd);
#[derive(Debug)]
pub struct ReceivedSealedBytes {
    file: File,
    len: usize,
}

pub fn sealed_socketpair() -> io::Result<(SealedSender, SealedReceiver)> {
    let (a, b) = socketpair(
        AddressFamily::UNIX,
        SocketType::SEQPACKET,
        SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
        None,
    )?;
    Ok((SealedSender(a), SealedReceiver(b)))
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid sealed descriptor packet",
    )
}

impl SealedSender {
    pub fn send(&self, bytes: &SealedBytes) -> io::Result<()> {
        let mut frame = [0; 12];
        frame[..4].copy_from_slice(b"DSB1");
        frame[4..].copy_from_slice(&(bytes.len() as u64).to_be_bytes());
        let fds = [bytes.as_fd()];
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(1))];
        let mut control = SendAncillaryBuffer::new(&mut space);
        if !control.push(SendAncillaryMessage::ScmRights(&fds)) {
            return Err(invalid());
        }
        let sent = sendmsg(
            self,
            &[IoSlice::new(&frame)],
            &mut control,
            SendFlags::DONTWAIT | SendFlags::NOSIGNAL,
        )?;
        if sent != frame.len() {
            return Err(invalid());
        }
        Ok(())
    }
}
impl SealedReceiver {
    pub fn receive(&self) -> io::Result<ReceivedSealedBytes> {
        let mut frame = [0; 12];
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(2))];
        let mut control = RecvAncillaryBuffer::new(&mut space);
        let result = recvmsg(
            self,
            &mut [IoSliceMut::new(&mut frame)],
            &mut control,
            RecvFlags::DONTWAIT | RecvFlags::CMSG_CLOEXEC,
        )?;
        // Drain before checking the packet: all materialized descriptors are owned
        // and every error path drops them. Undrained descriptors also have RAII.
        let mut fds = Vec::new();
        let mut other = false;
        for message in control.drain() {
            match message {
                RecvAncillaryMessage::ScmRights(rights) => fds.extend(rights),
                _ => other = true,
            }
        }
        if result
            .flags
            .intersects(ReturnFlags::CTRUNC | ReturnFlags::TRUNC)
            || result.bytes != 12
            || &frame[..4] != b"DSB1"
            || other
            || fds.len() != 1
        {
            return Err(invalid());
        }
        let len = u64::from_be_bytes(frame[4..].try_into().map_err(|_| invalid())?);
        if len == 0 || len > MAX_SEALED_BYTES as u64 {
            return Err(invalid());
        }
        let fd = fds.pop().ok_or_else(invalid)?;
        let required = SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::SEAL;
        let access = rustix::fs::fcntl_getfl(&fd)?;
        let mode = access & rustix::fs::OFlags::ACCMODE;
        if access.contains(rustix::fs::OFlags::PATH)
            || (mode != rustix::fs::OFlags::RDONLY && mode != rustix::fs::OFlags::RDWR)
        {
            return Err(invalid());
        }
        // Confirm immutable size/content BEFORE observing metadata. A sender
        // could otherwise resize an unsealed inode between stat and sealing.
        if !fcntl_get_seals(&fd)?.contains(required) {
            return Err(invalid());
        }
        let stat = fstat(&fd)?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
            || stat.st_size < 0
            || stat.st_size as u64 != len
            || !rustix::io::fcntl_getfd(&fd)?.contains(rustix::io::FdFlags::CLOEXEC)
        {
            return Err(invalid());
        }
        Ok(ReceivedSealedBytes {
            file: File::from(fd),
            len: len as usize,
        })
    }
}
impl ReceivedSealedBytes {
    pub fn read_bytes(&self) -> io::Result<Vec<u8>> {
        let mut bytes = vec![0; self.len];
        self.file.read_exact_at(&mut bytes, 0)?;
        Ok(bytes)
    }
}
impl AsFd for SealedSender {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }
}
impl AsFd for SealedReceiver {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }
}
impl AsFd for ReceivedSealedBytes {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.file.as_fd()
    }
}

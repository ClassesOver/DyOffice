#![cfg(target_os = "linux")]
use dyoffice_document_broker::{sealed_bytes::SealedBytes, sealed_transfer::sealed_socketpair};
use rustix::net::{SendAncillaryBuffer, SendAncillaryMessage, SendFlags, sendmsg};
use std::{
    io::IoSlice,
    mem::MaybeUninit,
    os::fd::{AsFd, AsRawFd, BorrowedFd},
};

fn frame(n: u64) -> Vec<u8> {
    let mut data = b"DSB1".to_vec();
    data.extend(n.to_be_bytes());
    data
}
fn inject(socket: impl AsFd, bytes: &[u8], fds: &[BorrowedFd<'_>]) {
    let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(8))];
    let mut control = SendAncillaryBuffer::new(&mut space);
    if !fds.is_empty() {
        assert!(control.push(SendAncillaryMessage::ScmRights(fds)));
    }
    sendmsg(
        socket,
        &[IoSlice::new(bytes)],
        &mut control,
        SendFlags::NOSIGNAL,
    )
    .unwrap();
}

#[test]
fn transfer_and_all_rejection_paths_are_bounded_and_fd_clean() {
    // One test isolates /proc descriptor counts from parallel tests in this binary.
    let count = || std::fs::read_dir("/proc/self/fd").unwrap().count();
    let before = count();
    {
        let value = SealedBytes::new(&[0, 255, 9]).unwrap();
        let (sender, receiver) = sealed_socketpair().unwrap();
        assert_eq!(
            receiver.receive().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        sender.send(&value).unwrap();
        let got = receiver.receive().unwrap();
        assert_eq!(got.read_bytes().unwrap(), [0, 255, 9]);
        assert!(
            rustix::io::fcntl_getfd(&got)
                .unwrap()
                .contains(rustix::io::FdFlags::CLOEXEC)
        );
        assert_eq!(
            rustix::io::pwrite(&got, b"x", 0),
            Err(rustix::io::Errno::PERM)
        );
        let mut duplicate = std::fs::File::from(rustix::io::dup(&got).unwrap());
        use std::io::{Read, Seek, SeekFrom};
        duplicate.seek(SeekFrom::Start(1)).unwrap();
        assert_eq!(got.read_bytes().unwrap(), [0, 255, 9]);
        assert_eq!(duplicate.stream_position().unwrap(), 1);
        let mut next = [0];
        duplicate.read_exact(&mut next).unwrap();
        assert_eq!(next, [255]);
        drop(duplicate);

        let path = format!("/proc/self/fd/{}", value.as_fd().as_raw_fd());
        let write_only = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        inject(&sender, &frame(3), &[write_only.as_fd()]);
        assert!(receiver.receive().is_err(), "write-only sealed fd");
        let path_only = rustix::fs::open(
            &path,
            rustix::fs::OFlags::PATH | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .unwrap();
        inject(&sender, &frame(3), &[path_only.as_fd()]);
        assert!(receiver.receive().is_err(), "O_PATH sealed fd");
        for n in [0, 2, 8] {
            let fds = vec![value.as_fd(); n];
            inject(&sender, &frame(3), &fds);
            assert!(receiver.receive().is_err(), "fd count {n}");
        }
        for data in [
            b"bad".to_vec(),
            frame(0),
            frame(65537),
            frame(2),
            vec![1; 13],
        ] {
            inject(&sender, &data, &[value.as_fd()]);
            assert!(receiver.receive().is_err(), "bad frame");
        }
        let unsealed =
            rustix::fs::memfd_create("test", rustix::fs::MemfdFlags::ALLOW_SEALING).unwrap();
        rustix::fs::ftruncate(&unsealed, 3).unwrap();
        inject(&sender, &frame(3), &[unsealed.as_fd()]);
        assert!(receiver.receive().is_err(), "missing seals");
        // Queued metadata is untrusted: resize and seal AFTER send but before
        // receive. Final sealed size, not sender's earlier claimed size, wins.
        inject(&sender, &frame(3), &[unsealed.as_fd()]);
        rustix::fs::ftruncate(&unsealed, 4).unwrap();
        rustix::fs::fcntl_add_seals(
            &unsealed,
            rustix::fs::SealFlags::WRITE
                | rustix::fs::SealFlags::GROW
                | rustix::fs::SealFlags::SHRINK
                | rustix::fs::SealFlags::SEAL,
        )
        .unwrap();
        assert!(
            receiver.receive().is_err(),
            "resized then sealed mismatched size"
        );
        inject(&sender, &frame(3), &[sender.as_fd()]);
        assert!(receiver.receive().is_err(), "socket not regular file");
        drop(sender);
        drop(value);
        assert_eq!(got.read_bytes().unwrap(), [0, 255, 9]);
        drop(got);
        assert!(receiver.receive().is_err(), "disconnect");
    }
    assert_eq!(count(), before, "received descriptors leaked");
}

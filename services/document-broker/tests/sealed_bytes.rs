#![cfg(target_os = "linux")]
use dyoffice_document_broker::sealed_bytes::{MAX_SEALED_BYTES, SealedBytes};
use rustix::fs::{SealFlags, fcntl_add_seals, fcntl_get_seals};
use rustix::io::{FdFlags, dup, fcntl_getfd};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::FileExt;

fn read_all(value: &SealedBytes) -> Vec<u8> {
    let file = File::from(dup(value).unwrap());
    let mut bytes = vec![0; value.len()];
    file.read_exact_at(&mut bytes, 0).unwrap();
    bytes
}

#[test]
fn exact_bytes_and_offset_independent_reads() {
    let bytes = vec![0, 255, 1, 0, 9];
    let sealed = SealedBytes::new(&bytes).unwrap();
    assert_eq!(sealed.len(), bytes.len());
    assert!(!sealed.is_empty());
    assert_eq!(read_all(&sealed), bytes);
    let mut duplicate = File::from(dup(&sealed).unwrap());
    duplicate.seek(SeekFrom::Start(1)).unwrap();
    assert_eq!(read_all(&sealed), bytes);
    assert_eq!(duplicate.stream_position().unwrap(), 1);
    let mut tail = [0; 1];
    assert_eq!(duplicate.read(&mut tail).unwrap(), 1);
    assert_eq!(tail, [255]);
}

#[test]
fn kernel_seals_and_cloexec_are_present() {
    let sealed = SealedBytes::new(b"abc").unwrap();
    let required = SealFlags::WRITE | SealFlags::GROW | SealFlags::SHRINK | SealFlags::SEAL;
    assert!(fcntl_get_seals(&sealed).unwrap().contains(required));
    assert!(fcntl_getfd(&sealed).unwrap().contains(FdFlags::CLOEXEC));
    assert_eq!(
        fcntl_add_seals(&sealed, SealFlags::FUTURE_WRITE),
        Err(rustix::io::Errno::PERM)
    );
}

#[test]
fn writes_pwrite_grow_and_shrink_fail_even_via_duplicate() {
    let sealed = SealedBytes::new(b"abc").unwrap();
    let mut file = File::from(dup(&sealed).unwrap());
    assert_eq!(file.write(b"z").unwrap_err().raw_os_error(), Some(1));
    assert_eq!(file.write_at(b"z", 0).unwrap_err().raw_os_error(), Some(1));
    assert_eq!(file.set_len(2).unwrap_err().raw_os_error(), Some(1));
    assert_eq!(file.set_len(4).unwrap_err().raw_os_error(), Some(1));
    assert_eq!(read_all(&sealed), b"abc");
}

#[test]
fn empty_maximum_and_over_limit() {
    assert_eq!(
        SealedBytes::new(b"").unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    let maximum = vec![7; MAX_SEALED_BYTES];
    assert_eq!(read_all(&SealedBytes::new(&maximum).unwrap()), maximum);
    assert_eq!(
        SealedBytes::new(&vec![7; MAX_SEALED_BYTES + 1])
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::InvalidInput
    );
}

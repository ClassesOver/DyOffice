//! Private, point-in-time content observation, NOT immutable-rootfs admission.
//! No reviewed installed artifact exists yet. No conversion to ApprovedRuntime.
use rustix::fs::{FileType, Mode, OFlags, open, openat};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, Metadata},
    io,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::fs::{FileExt, MetadataExt},
    },
};
const MAX_BYTES: u64 = 16 * 1024 * 1024;
struct ExpectedArtifact {
    components: &'static [&'static str],
    size: u64,
    sha256: [u8; 32],
}
// Populating this registry requires separately reviewed provenance and installation.
const REVIEWED_ARTIFACT: Option<ExpectedArtifact> = None;
#[derive(Debug)]
pub(super) enum ObservationError {
    Unavailable,
    Invalid,
    Io,
}
impl From<io::Error> for ObservationError {
    fn from(_: io::Error) -> Self {
        Self::Io
    }
}
impl From<rustix::io::Errno> for ObservationError {
    fn from(_: rustix::io::Errno) -> Self {
        Self::Io
    }
}
pub(super) struct ArtifactObservation {
    file: File,
    metadata: Metadata,
    sha256: [u8; 32],
}
pub(super) fn observe_installed_runtime() -> Result<ArtifactObservation, ObservationError> {
    let expected = REVIEWED_ARTIFACT
        .as_ref()
        .ok_or(ObservationError::Unavailable)?;
    let root = open(
        "/",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    observe_from(root, expected, 0)
}
fn directory(file: &File, owner: u32) -> Result<(), ObservationError> {
    let m = file.metadata()?;
    if !m.is_dir() || m.uid() != owner || m.mode() & 0o022 != 0 {
        return Err(ObservationError::Invalid);
    }
    Ok(())
}
fn observe_from(
    root: OwnedFd,
    expected: &ExpectedArtifact,
    owner: u32,
) -> Result<ArtifactObservation, ObservationError> {
    if expected.components.is_empty()
        || expected.components.len() > 8
        || expected.size == 0
        || expected.size > MAX_BYTES
    {
        return Err(ObservationError::Invalid);
    }
    for part in expected.components {
        if part.is_empty()
            || part.len() > 128
            || *part == "."
            || *part == ".."
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(ObservationError::Invalid);
        }
    }
    let mut parent = File::from(root);
    directory(&parent, owner)?;
    for part in &expected.components[..expected.components.len() - 1] {
        let fd = openat(
            &parent,
            *part,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        parent = File::from(fd);
        directory(&parent, owner)?;
    }
    // Pin without opening device/FIFO contents; reject nonregular inodes first.
    let fd = openat(
        &parent,
        *expected.components.last().unwrap(),
        OFlags::PATH | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let pinned = File::from(fd);
    let metadata = pinned.metadata()?;
    if FileType::from_raw_mode(metadata.mode()) != FileType::RegularFile
        || metadata.uid() != owner
        || metadata.mode() & 0o222 != 0
        || metadata.nlink() != 1
        || metadata.len() != expected.size
    {
        return Err(ObservationError::Invalid);
    }
    // Reopen only this held descriptor via kernel procfs, not the install path.
    // A missing or non-proc mount is unsupported. The mount namespace is trusted.
    let proc_fd = open(
        "/proc/self/fd",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    if rustix::fs::fstatfs(&proc_fd)?.f_type != rustix::fs::PROC_SUPER_MAGIC {
        return Err(ObservationError::Invalid);
    }
    let file = File::from(openat(
        &proc_fd,
        pinned.as_raw_fd().to_string(),
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let observation = ArtifactObservation {
        file,
        metadata,
        sha256: expected.sha256,
    };
    observation.recheck()?;
    Ok(observation)
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    (
        a.dev(),
        a.ino(),
        a.mode(),
        a.uid(),
        a.gid(),
        a.nlink(),
        a.len(),
        a.mtime(),
        a.mtime_nsec(),
        a.ctime(),
        a.ctime_nsec(),
    ) == (
        b.dev(),
        b.ino(),
        b.mode(),
        b.uid(),
        b.gid(),
        b.nlink(),
        b.len(),
        b.mtime(),
        b.mtime_nsec(),
        b.ctime(),
        b.ctime_nsec(),
    )
}
impl ArtifactObservation {
    fn recheck(&self) -> Result<(), ObservationError> {
        if !same(&self.metadata, &self.file.metadata()?) {
            return Err(ObservationError::Invalid);
        }
        let mut hash = Sha256::new();
        let mut offset = 0;
        let mut buffer = [0u8; 32768];
        while offset < self.metadata.len() {
            let limit = (self.metadata.len() - offset).min(buffer.len() as u64) as usize;
            let n = self.file.read_at(&mut buffer[..limit], offset)?;
            if n == 0 {
                return Err(ObservationError::Invalid);
            }
            hash.update(&buffer[..n]);
            offset += n as u64;
        }
        if hash.finalize().as_slice() != self.sha256
            || !same(&self.metadata, &self.file.metadata()?)
        {
            return Err(ObservationError::Invalid);
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "runtime-observation-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&p).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self(p)
        }
        fn root(&self) -> OwnedFd {
            open(
                &self.0,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .unwrap()
        }
        fn write(&self) {
            std::fs::write(self.0.join("worker"), b"abc").unwrap();
            std::fs::set_permissions(
                self.0.join("worker"),
                std::fs::Permissions::from_mode(0o444),
            )
            .unwrap()
        }
        fn owner(&self) -> u32 {
            std::fs::metadata(&self.0).unwrap().uid()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn expected() -> ExpectedArtifact {
        ExpectedArtifact {
            components: &["worker"],
            size: 3,
            sha256: Sha256::digest(b"abc").into(),
        }
    }
    #[test]
    fn installed_registry_is_closed() {
        assert!(matches!(
            observe_installed_runtime(),
            Err(ObservationError::Unavailable)
        ))
    }
    #[test]
    fn actual_file_hash_and_retained_descriptor() {
        let f = Fixture::new();
        f.write();
        let o = observe_from(f.root(), &expected(), f.owner()).unwrap();
        o.recheck().unwrap();
        std::fs::rename(f.0.join("worker"), f.0.join("old")).unwrap();
        std::fs::write(f.0.join("worker"), b"xyz").unwrap();
        let mut bytes = [0; 3];
        o.file.read_at(&mut bytes, 0).unwrap();
        assert_eq!(&bytes, b"abc");
        assert!(observe_from(f.root(), &expected(), f.owner()).is_err());
    }
    #[test]
    fn bad_hash_size_and_owner_fail() {
        let f = Fixture::new();
        f.write();
        let mut e = expected();
        e.sha256 = [0; 32];
        assert!(observe_from(f.root(), &e, f.owner()).is_err());
        e = expected();
        e.size = 2;
        assert!(observe_from(f.root(), &e, f.owner()).is_err());
        assert!(observe_from(f.root(), &expected(), f.owner() + 1).is_err())
    }
    #[test]
    fn writable_artifact_and_parent_fail() {
        let f = Fixture::new();
        f.write();
        std::fs::set_permissions(f.0.join("worker"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        assert!(observe_from(f.root(), &expected(), f.owner()).is_err());
        std::fs::set_permissions(f.0.join("worker"), std::fs::Permissions::from_mode(0o444))
            .unwrap();
        std::fs::set_permissions(&f.0, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(observe_from(f.root(), &expected(), f.owner()).is_err())
    }
    #[test]
    fn symlink_leaf_and_directory_fail() {
        let f = Fixture::new();
        f.write();
        std::fs::rename(f.0.join("worker"), f.0.join("actual")).unwrap();
        symlink("actual", f.0.join("worker")).unwrap();
        assert!(observe_from(f.root(), &expected(), f.owner()).is_err());
        symlink(".", f.0.join("dir")).unwrap();
        let e = ExpectedArtifact {
            components: &["dir", "actual"],
            ..expected()
        };
        assert!(observe_from(f.root(), &e, f.owner()).is_err())
    }
    #[test]
    fn traversal_empty_oversize_and_directory_leaf_fail() {
        let f = Fixture::new();
        f.write();
        for parts in [&[".."][..], &["/worker"], &["a/b"], &[""], &[]] {
            let e = ExpectedArtifact {
                components: parts,
                ..expected()
            };
            assert!(observe_from(f.root(), &e, f.owner()).is_err())
        }
        for size in [0, MAX_BYTES + 1] {
            assert!(
                observe_from(
                    f.root(),
                    &ExpectedArtifact { size, ..expected() },
                    f.owner()
                )
                .is_err()
            )
        }
        std::fs::create_dir(f.0.join("dir")).unwrap();
        assert!(
            observe_from(
                f.root(),
                &ExpectedArtifact {
                    components: &["dir"],
                    ..expected()
                },
                f.owner()
            )
            .is_err()
        )
    }
    #[test]
    fn hardlinks_and_later_write_reject() {
        let f = Fixture::new();
        f.write();
        std::fs::hard_link(f.0.join("worker"), f.0.join("alias")).unwrap();
        assert!(observe_from(f.root(), &expected(), f.owner()).is_err());
        std::fs::remove_file(f.0.join("alias")).unwrap();
        let o = observe_from(f.root(), &expected(), f.owner()).unwrap();
        std::fs::set_permissions(f.0.join("worker"), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        std::fs::write(f.0.join("worker"), b"xyz").unwrap();
        std::fs::set_permissions(f.0.join("worker"), std::fs::Permissions::from_mode(0o444))
            .unwrap();
        assert!(o.recheck().is_err())
    }
    #[test]
    fn fifo_leaf_is_rejected_without_waiting_for_a_writer() {
        let f = Fixture::new();
        rustix::fs::mknodat(
            f.root(),
            "worker",
            FileType::Fifo,
            Mode::from_raw_mode(0o444),
            0,
        )
        .unwrap();
        assert!(observe_from(f.root(), &expected(), f.owner()).is_err());
    }
}

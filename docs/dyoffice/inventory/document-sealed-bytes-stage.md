# Sealed bytes primitive (experimental, Linux only)

This stage uses rustix 1.1.6 filesystem APIs to create a fixed-name anonymous
memfd with CLOEXEC and ALLOW_SEALING. The constructor accepts 1–65,536 bytes;
this conservative prototype bound is not an approved document upload limit.
It checks the bound before creation, writes all bytes, applies WRITE, GROW,
SHRINK and SEAL together, then verifies seals and size before publishing its
borrowed descriptor. Errors propagate and File/OwnedFd ownership closes the
descriptor. There is no temporary-file fallback.

The descriptor's shared stream offset is not an identity or integrity check.
Consumers must use positional reads when they need repeatable reads. A duplicate
descriptor refers to the same sealed inode and cannot modify its contents.

## Evidence and limits

Real Linux kernel tests exercise exact byte equality, offset-independent reads,
CLOEXEC, all four seals, dup, write, pwrite, shrink, grow and additional seal
attempts. Empty and oversized input are rejected; the exact cap is accepted.
A temporary omitted-seals mutation makes the protection assertions fail;
the mutation was restored before the full regression. A separate empty-input
RED test preceded rejecting empty input.

These tests do not prove provenance, hashing, authorization, trusted engine
execution, kernel isolation, or an OS stop. No hash algorithm is implemented.
CLOEXEC is not NOEXEC: this primitive does not claim the inode cannot execute.
The primitive itself has no transport; the separate restricted SCM_RIGHTS
experiment is described below. No production broker admission, document
input/output assembly or positive T06 save is connected. The default binary still exits 78.
Actual target-host Ubuntu/openEuler x86_64 acceptance remains outstanding.
No kernel/security settings are changed when a syscall fails.

## Reproduction

From the broker crate, with the existing toolchain:

    cargo test --locked --offline
    cargo fmt --check
    cargo clippy --locked --offline --features unsafe-test-harness --all-targets -- -D warnings

The crate's Linux-only sealed_bytes module and tests are absent on non-Linux
builds; this does not expand the supported deployment matrix.

## Restricted local descriptor handoff

The implementation sequence is test-first socketpair roundtrip and negative
frames, then a rustix-backed receiver, then omitted-seal mutation verification
and full regression. No production control interface is extended.

Linux sealed_transfer creates privately constructed sender/receiver endpoints
using AF_UNIX SEQPACKET, CLOEXEC and NONBLOCK. Neither endpoint can be constructed
from a caller-provided socket. The borrowed AsFd interface permits inspection
and adversarial test injection; holders of an endpoint are not authenticated
authorities. Each operation is one nonblocking syscall; WouldBlock propagates
without a spin or fallback. No filesystem listener or changed host settings.

The separate experimental packet is exactly 12 bytes: DSB1 followed by a
big-endian u64 length. It carries exactly one SCM_RIGHTS descriptor. The receiver
uses MSG_CMSG_CLOEXEC, rejects data/control truncation, drains owned descriptors
before validating, and relies on rustix RAII for unread ancillary descriptors.
It checks 1–65,536 size, regular inode type, matching fstat size and all four
seals before returning a positional-read interface. This validates a sealed
regular inode, not necessarily its creation with memfd or its source.

The ancillary buffer has fixed space for two descriptors, allowing explicit
extra-descriptor rejection; larger arrays trigger control truncation. rustix
exposes rights and credentials and may ignore unknown ancillary types. We do
not claim generic detection of all unknown control messages. The private pair
does not enable PASSCRED/PASSPIDFD or other ancillary-producing options; exposed
non-rights messages are rejected. No unsafe custom cmsghdr parser is used.

Real kernel tests cover exact bytes, CLOEXEC, pwrite rejection, no data,
disconnect, absent/two/eight descriptors, malformed/short/oversized packets,
bad size, unsealed inode and socket-as-file rejection. Descriptor counts before
and after the entire sequential test verify no leaked received descriptors.
This is a same-process kernel transport test, not cross-UID authentication,
trusted broker certification, an execution grant or a T06 save path.

Receiver ordering is significant: full immutable-content/size seals are
confirmed **before** fstat. Taking size first could race a sender resizing and
then sealing between the checks. The final-sealed-size negative case queues a
descriptor, resizes/seals it before receive, and checks claimed size mismatch.
That test covers a real mutable queued descriptor; it is not a deterministic
reproduction of a scheduler pause between the two individual receiver syscalls.

The receiver also checks fcntl access mode before exposing a readable object:
only RDONLY or RDWR are allowed, never WRONLY or O_PATH. A real regression
reopens only the test's own sealed memfd via /proc/self/fd as write-only and
shows the pre-fix receiver incorrectly accepted it. The fixed receiver rejects
both non-readable modes. Positional reads preserve a deliberately changed shared
offset; received bytes remain readable after dropping sender and original fd.

AsFd permits trusted in-process Rust callers to use raw syscalls on the
endpoints. The wrapper is not a security boundary against such code.
NONBLOCK bounds waiting for an operation; it is not a global connection,
descriptor, queued-packet or memory quota.

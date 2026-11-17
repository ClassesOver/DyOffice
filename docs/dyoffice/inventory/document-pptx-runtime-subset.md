# Nonlaunchable PPTX/Node runtime subset

This stage actually prepares and verifies a bounded file subset. It is not a
rootfs, installation, certified interpreter or executable sandbox.

## Fixed inputs and artifacts

Input is the previous PPTX module candidate plus an independently held expected
content digest. The only native binary source is the already trusted tool
process's process.execPath on Linux x86_64. There is no caller binary path, argv,
loader or library search parameter.

The new directory contains:

- session.cjs: copied from the verified module, with matching upstream hash/size.
- module-manifest.json: the upstream canonical manifest, bound by its externally
  supplied digest and rechecked against the copied module.
- node.elf: a stream copy of the current Node binary, treated as data.
- closure.json: canonical, domain-separated content manifest for this subset.

All files have mode 0644. This is an artifact policy, not a security boundary:
a loader could explicitly read such a file. No produced file is executed.
Source files are opened no-follow/nonblocking, must be regular, single-link,
nonempty and without SUID/SGID/sticky bits. Streaming uses 64 KiB buffers and
handles short reads/writes. Source metadata is checked before and after the copy.
Node is limited to 256 MiB, module to 16 MiB, each manifest to 1 MiB, with a total
bound equal to those maxima. No full Node-sized allocation is performed.

## Actual static observation, not a closure claim

The fixed installed /usr/bin/readelf target is resolved and hashed. It runs with
fixed --wide/--file-header/--program-headers/--dynamic arguments against the
newly copied node.elf, no shell, LC_ALL=C only, a 5-second timeout and 1 MiB output
bound. No LD_PRELOAD or LD_LIBRARY_PATH is inherited. Tool identity and copied
Node identity are checked again after observation. Parse failure rejects the
candidate; incomplete metadata is not accepted as proof of no dependencies.
The script never invokes ldd, the copied Node, a document engine or a loader.

Current host Node observation is ELF64 x86_64, interpreter
/lib64/ld-linux-x86-64.so.2, with seven DT_NEEDED entries: libdl.so.2,
libstdc++.so.6, libm.so.6, libgcc_s.so.1, libpthread.so.0, libc.so.6 and
ld-linux-x86-64.so.2. No RPATH/RUNPATH was observed. These are declarations
in this binary, not a recursively resolved or authenticated library closure.
No host libraries, loader or fonts are copied.

This host observation is not Ubuntu/openEuler provenance. Those remain future
target distributions, not certifications of the local bytes. Dynamic dlopen,
NSS, timezone/locales/configuration, kernel requirements and runtime resources
are not enumerated by readelf. Tool hashes identify observed tool bytes, not
supply-chain certification.

## Font scope from actual code

The source checked for the module candidate at commit
e0d5be4201ed4f90595a3664b05eb4e5101d9257 shows:

- worker/src/native/pptx-session.ts:374 and :449 call buildRenderSlide without
  supplying a metrics provider.
- packages/pptx-render/src/build-slide.ts:143 chooses
  opts.metrics ?? new HeuristicMetrics().
- packages/pptx-render/src/metrics.ts defines both the deterministic heuristic
  and separately injected OpentypeMetrics.

Thus this current default module path does not request a system font file.
It does not prove PowerPoint/desktop text-metric fidelity. A chosen, licensed
font set and actual metrics injection/rendering tests remain separate work.
No automatic collection of all host fonts is justified.

## Identity and validation

The new externally retained digest binds exact filenames, mode, size, SHA-256,
upstream module identity, fixed profile/policy/architecture/target intent, Node
version/static ELF observation, observer hash and explicit incomplete flags.
Verification requires an independent expected digest, exact file list and
canonical manifest, then rehashes real bounded files. A changed file and
self-consistently updated manifest still fail against the original digest.
Unknown fields, malformed ELF fields, nonregular/link/special-mode files and
unexpected flags are rejected.

These are multiple read snapshots, not an atomic source-tree capture. Ordinary
output directories remain mutable, and path-based hash-then-exec TOCTOU is not
solved. Successful verification does not authorize execution, mounting, runtime
registration or T06 commit. runtimeApproved/rootfsComplete/productionEnabled
remain false. Production factories and systemd resolver are unchanged.

## Commands and evidence

    node apps/web/scripts/prepare-pptx-runtime-subset.mjs prepare MODULE_DIRECTORY MODULE_DIGEST EXISTING_OUTPUT_PARENT
    node apps/web/scripts/prepare-pptx-runtime-subset.mjs verify SUBSET_DIRECTORY SUBSET_DIGEST
    node --test apps/web/test/runtime-artifacts/pptx-closure.test.mjs

Partial-workspace tests use the same explicit DYOFFICE_ARTIFACT_SOURCE_ROOT
materialized source tree as the preceding module tests. Two tests contain real
prepare/verify/CLI verification and negative assertions: two preparations have
the same identity; changed Node bytes, tail growth, file/manifest joint
replacement, wrong external digest, ordinary mode change, links and extra files
are rejected. Pure parser tests reject missing/duplicate fields and wrong
architecture. No actual special permissions are set for testing.

The aggregate limit is explicitly 274 MiB: 256 MiB Node + 16 MiB module +
two 1 MiB manifests, including closure.json. The full upstream fixed-manifest
validator is reused by export from the original candidate tool, without relaxing
its checks. Node24 is required before preparation. Metadata text reads reject
tail growth and compare inode/device/size/mode/link-count/nanosecond timestamps
before and after their bounded read.

Verification evidence includes 3 combined artifact tests (the earlier module
test plus 2 subset tests), actual prepare and verify CLI success, and a temporary
removed-external-digest mutation which failed the test. That mutation was
restored before final regression. No claim of runtime execution follows.

The automated subset test invokes CLI **verify**; CLI prepare was separately
run and checked as local evidence, not counted as an automated test. Parser
regressions include a valid entry mixed with malformed NEEDED/RPATH/RUNPATH:
each tag occurrence must correspond to a parsed value, so malformed declarations
cannot silently disappear from the incomplete-dependency report. Snapshot
cleanup uses nested finally blocks so a destination-close failure still closes
the input descriptor.

## Target-distribution material gate

A subsequent target rootfs cannot be produced from the files currently available.
A bounded workspace inventory found no Ubuntu/openEuler official image, RPM
package set, signatures or target SBOM. Existing Debian trixie package material
is not a substitute. The current Node byte snapshot lacks its corresponding
verified official release signature and complete redistribution-license material.
This is a material/provenance blocker, not a failed isolation test.

Before constructing a target runtime, pin and obtain:

1. Exact distribution release/patch, x86_64, repository snapshot or image digest.
2. Ubuntu image and signed checksums, or openEuler repository metadata and the
   complete RPM dependency set, verified using independently confirmed official
   signing-key fingerprints. A key supplied alongside the download is not by
   itself a trust anchor.
3. Exact Node linux-x64 release and signed checksums, verified with independently
   confirmed release keys; record the original artifact and verification result.
4. Recursive interpreter/shared-library package closure, symbol-version
   compatibility and fixed runtime paths. DT_NEEDED alone misses dlopen, NSS,
   locales and other dynamic resources; host search paths are not an approved
   package resolver.
5. File-to-source-package/version/hash mapping, licenses and required NOTICEs;
   selected fonts/resources need their own provenance and licensing review.
6. Separate Ubuntu/openEuler actual execution and isolation acceptance. A valid
   package signature cannot certify runtime behavior or kernel isolation.

Official verification references:
- [Ubuntu image verification](https://documentation.ubuntu.com/security/software-integrity/image-verification/)
- [openEuler repository configuration](https://docs.openeuler.org/en/docs/25.09/server/administration/administrator/configuring_the_repo_server.html)
- [Node release keys](https://github.com/nodejs/release-keys)

These links identify verification procedures, not a selected/approved target
version. The openEuler documentation version is not a deployment decision.
No package or image was downloaded, no host library was collected, and no
signing key was enrolled by this inventory step. Production remains disabled.

Target-platform acceptance must also enumerate reachable native addons and their
shared-library dependencies. Node can load addons after initial startup, so
initial DT_NEEDED does not prove the complete execution closure. Verify actual
resolution with the intended cleared environment, fixed paths and target loader
configuration/cache, and require rejection when a pinned artifact is missing or
replaced. This is a planned acceptance requirement, not evidence of an observed
vulnerability or a completed target-platform test.

References: [Node process.dlopen](https://nodejs.org/docs/latest-v24.x/api/process.html#processdlopenmodule-filename-flags)
and [Linux dynamic-loader behavior](https://man7.org/linux/man-pages/man8/ld.so.8.html).
The Node 24 documentation describes the mechanism, not certification of the
specific Node bytes or their reachable addon dependency closure.

### Located official inputs, not acquired or approved

A follow-up read-only metadata search located these concrete preparation
candidates. They are not production-version approvals or verified downloads:

- Ubuntu 24.04 amd64 snapshot:
  https://cloud-images.ubuntu.com/releases/noble/release-20261017/
  Obtain `ubuntu-24.04-server-cloudimg-amd64-root.tar.xz`, its `root.manifest`,
  `SHA256SUMS` and `SHA256SUMS.gpg`. The browsed checksum table lists
  `ec6972af8ea2bd05c55299d204e5ae3f91769b84cfaec7395639d236a39f9a03`
  for the root tar. This transcribed digest is not an independently verified
  signing anchor; verify the signed table before trusting it.
- openEuler 24.03 LTS SP1 x86_64:
  https://repo.openeuler.org/openEuler-24.03-LTS-SP1/ISO/x86_64/
  Directory entries include the DVD ISO, `.iso.sha256sum`, `.rpmlist` and
  `baseos_bin_2_src.csv`. Official repository key location:
  https://repo.openeuler.org/openEuler-24.03-LTS-SP1/OS/x86_64/RPM-GPG-KEY-openEuler
  The available web reader could not read the octet-stream key/checksum files;
  no key fingerprint, ISO hash or signed ISO chain was established. A checksum
  file alone is not a signature. Verify independently anchored package signatures
  and preserve the exact repository/package source mapping.
- Node fixed candidate v24.22.3:
  https://nodejs.org/download/release/v24.22.3/
  Obtain `node-v24.22.3-linux-x64.tar.xz`, `SHASUMS256.txt` and its `.asc` or
  `.sig`, plus the complete version-matched LICENSE:
  https://github.com/nodejs/node/blob/v24.22.3/LICENSE
  The fixed-version checksum could not be read by the available web channel;
  no download hash or release signature has been verified.

The current execution environment's allowed domains do not include these
three binary-download hosts. No proxy, mirror rehosting or network-setting
change was attempted. Browsable metadata cannot supply original binary/signature
bytes for local verification. An authorized material-transfer channel and
independently established trust anchors are still needed. Preserve each selected
package's copyright, license, NOTICE and applicable source obligations; a
website footer license or a generic MIT label does not cover the runtime tree.

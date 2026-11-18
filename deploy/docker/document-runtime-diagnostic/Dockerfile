# syntax=docker/dockerfile:1
# Both input images MUST be audited Ubuntu 24.04 amd64 images, pinned by digest.
ARG UBUNTU_IMAGE
ARG RUST_BUILD_IMAGE
FROM ${RUST_BUILD_IMAGE} AS build
ARG RUST_BUILD_IMAGE
ARG APT_MIRROR=https://repo.huaweicloud.com/ubuntu/
USER root
COPY deploy/docker/document-runtime-diagnostic/configure-apt.sh /opt/configure-apt.sh
COPY deploy/docker/document-runtime-diagnostic/validate-inputs.sh /opt/validate-inputs.sh
RUN sh /opt/configure-apt.sh "$RUST_BUILD_IMAGE" "$APT_MIRROR" \
 && apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config libssl-dev python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY services/document-broker/ ./services/document-broker/
COPY deploy/docker/document-runtime-diagnostic/select-test-binary.py /opt/select-test-binary.py
# Builder must already contain the exact Rust toolchain and locked Cargo cache.
# Never invoke rustup downloads or silently fall back to an unverified mirror.
ENV RUSTUP_TOOLCHAIN=1.93.0 CARGO_TARGET_DIR=/build/services/document-broker/target
RUN --network=none rustc --version | grep '^rustc 1.93.0 ' \
 && cargo test --offline --locked --manifest-path services/document-broker/Cargo.toml \
      --lib --no-run --message-format=json > /tmp/cargo-artifacts.jsonl \
 && python3 /opt/select-test-binary.py /tmp/cargo-artifacts.jsonl /out
FROM ${UBUNTU_IMAGE}
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.revision=${SOURCE_COMMIT}
ARG UBUNTU_IMAGE
ARG APT_MIRROR=https://repo.huaweicloud.com/ubuntu/
USER root
COPY deploy/docker/document-runtime-diagnostic/configure-apt.sh /opt/configure-apt.sh
COPY deploy/docker/document-runtime-diagnostic/validate-inputs.sh /opt/validate-inputs.sh
RUN test "${#SOURCE_COMMIT}" -eq 40 \
 && case "$SOURCE_COMMIT" in *[!0-9a-f]*) exit 78 ;; esac \
 && sh /opt/configure-apt.sh "$UBUNTU_IMAGE" "$APT_MIRROR" \
 && apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus coreutils libssl3t64 libgcc-s1 ca-certificates \
 && rm -rf /var/lib/apt/lists/* /opt/configure-apt.sh /opt/validate-inputs.sh \
 && truncate -s 0 /etc/machine-id
COPY --from=build /out/ /opt/dyoffice-diagnostic/
COPY deploy/docker/document-runtime-diagnostic/run-probe.sh /opt/dyoffice-diagnostic/run-probe.sh
COPY deploy/docker/document-runtime-diagnostic/dyoffice-probe.service /etc/systemd/system/
COPY deploy/docker/document-runtime-diagnostic/dyoffice-diagnostic.target /etc/systemd/system/
ENV container=docker
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]
CMD ["--unit=dyoffice-diagnostic.target"]

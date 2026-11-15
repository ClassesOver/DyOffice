FROM debian@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
COPY sandbox-probe /usr/local/bin/sandbox-probe
COPY artifact-io /usr/local/bin/artifact-io
COPY supervisor /usr/local/bin/supervisor
USER 10001:10001
WORKDIR /work
ENV LANG=C.UTF-8 TMPDIR=/work
ENTRYPOINT ["/usr/local/bin/supervisor"]
CMD ["probe"]

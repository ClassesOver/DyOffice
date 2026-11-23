# Build context must be the repository root. No published DyOffice image is assumed.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=https://repo.huaweicloud.com/repository/npm/
WORKDIR /app
COPY . .
# Fail before downloading dependencies if the mirror points at a different Node release.
RUN test "$(node -p 'process.versions.node')" = "$(cat .nvmrc)" \
 && NPM_REGISTRY="${NPM_REGISTRY}" node deploy/docker/rewrite-lock.mjs \
 && npm ci --ignore-scripts --include=dev --registry="${NPM_REGISTRY}" --no-audit --no-fund \
 && npm cache clean --force
# The Sheets bundle exceeds Node's automatic heap limit on small build hosts.
ARG BUILD_HEAP_MIB=2800
RUN NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MIB}" npm run build:saas \
 && mkdir -p /data/objects && chown node:node /data/objects
# Asset availability does not enable native runtimes; their safety gates remain unchanged.
# tsx is a runtime dependency of the existing start script, so dev deps are retained.
USER node
ENTRYPOINT ["sh", "/app/deploy/docker/entrypoint.sh"]
CMD ["web"]

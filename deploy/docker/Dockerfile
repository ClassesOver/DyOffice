# Build context must be the repository root. No published DyOffice image is assumed.
ARG NODE_IMAGE
ARG RUST_IMAGE
FROM ${NODE_IMAGE} AS node-base
FROM ${RUST_IMAGE} AS wasi-build
ENV RUSTUP_DIST_SERVER=https://repo.huaweicloud.com/rustup
WORKDIR /src
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY apps/sheets/native/xlsx-engine/ apps/sheets/native/xlsx-engine/
COPY tools/dyoffice/build-xlsx-refresh-wasi.mjs tools/dyoffice/
RUN rustc --version | grep -q '^rustc 1\.93\.0 ' \
 && rustup target add wasm32-wasip1 \
 && CARGO_TARGET_DIR=/tmp/wasi-target node tools/dyoffice/build-xlsx-refresh-wasi.mjs \
 && rm -rf /tmp/wasi-target "$CARGO_HOME/registry"

FROM node-base AS runtime-base
# Provide complete CJK and Latin fallback fonts for container-side rendering.
RUN sed -i 's|^URIs: http://deb.debian.org/|URIs: http://repo.huaweicloud.com/|' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends fontconfig fonts-noto-cjk fonts-liberation \
 && fc-cache -f \
 && for family in 'Noto Sans CJK SC' 'Noto Serif CJK SC' 'Liberation Serif' 'Liberation Sans' 'Liberation Mono'; do \
      test "$(fc-match -f '%{family}' "$family")" = "$family" || exit 1; \
    done \
 && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS web
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
RUN NODE_OPTIONS="--max-old-space-size=${BUILD_HEAP_MIB}" npm run build:saas:assets \
 && node --input-type=module -e "import {createStaticAssets} from './apps/web/server/static-assets.mjs'; for (const editor of ['docs','sheets','slides']) await createStaticAssets({assetMode:'built',assetDirectory:'apps/web/dist-'+editor,pages:['index.html'],assetInventory:'.vite/native-assets.json'})" \
 && mkdir -p /data/objects && chown node:node /data/objects
# Asset availability does not enable native runtimes; their safety gates remain unchanged.
# tsx is a runtime dependency of the existing start script, so dev deps are retained.
COPY --from=wasi-build /src/apps/web/dist-sheets-server/xlsx-refresh-wasi.mjs /app/apps/web/dist-sheets-server/
USER node
ENTRYPOINT ["sh", "/app/deploy/docker/entrypoint.sh"]
CMD ["web"]

# Build context must be the repository root. No published DyOffice image is assumed.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG NPM_REGISTRY=https://repo.huaweicloud.com/repository/npm/
WORKDIR /app
COPY . .
RUN NPM_REGISTRY="${NPM_REGISTRY}" node deploy/docker/rewrite-lock.mjs \
 && npm ci --ignore-scripts --include=dev --registry="${NPM_REGISTRY}" \
 && npm run build:web && npm run build:web:docs \
 && mkdir -p /data/objects && chown node:node /data/objects
# tsx is a runtime dependency of the existing start script, so dev deps are retained.
USER node
ENTRYPOINT ["sh", "/app/deploy/docker/entrypoint.sh"]
CMD ["web"]

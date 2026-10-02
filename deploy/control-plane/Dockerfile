FROM node:24.21.0-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /build
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm build:protocol && pnpm build:web \
    && pnpm --filter @mate/control-plane run build \
    && mkdir -p /output/apps/control-plane /output/apps/web /output/packages/protocol \
    && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /output/ \
    && cp apps/control-plane/package.json /output/apps/control-plane/ \
    && cp apps/web/package.json apps/web/assets.mjs /output/apps/web/ \
    && cp packages/protocol/package.json /output/packages/protocol/ \
    && cp -r apps/control-plane/dist /output/apps/control-plane/ \
    && cp -r apps/web/dist /output/apps/web/ \
    && cp -r packages/protocol/dist /output/packages/protocol/ \
    && cd /output && pnpm install --prod --offline --frozen-lockfile

FROM node:24.21.0-bookworm-slim AS runtime
ARG MATE_VERSION
ARG MATE_REVISION
RUN test -n "$MATE_VERSION" && rm -rf /usr/local/lib/node_modules /opt/yarn* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
LABEL org.opencontainers.image.title="Mate control plane" \
      org.opencontainers.image.version="$MATE_VERSION" \
      org.opencontainers.image.revision="$MATE_REVISION"
WORKDIR /opt/mate
COPY --from=build /output/ ./
WORKDIR /opt/mate/apps/control-plane
COPY deploy/control-plane/entrypoint.mjs ./entrypoint.mjs
ENV NODE_ENV=production MATE_CONTROL_PLANE_DATA_DIR=/var/lib/mate/control-plane
USER 65532:65532
EXPOSE 8787
ENTRYPOINT ["node", "entrypoint.mjs"]

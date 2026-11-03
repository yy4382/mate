# The control-plane image: `docker build --file deploy/control-plane/Dockerfile .` from the repo root.
# Dependencies are installed on the target platform so native packages match the runtime image.
FROM node:24.21.0-trixie-slim AS build
RUN npm install --global pnpm@10.33.0
# The pnpm store is a build cache, so dependencies are not downloaded again after a source change.
ENV npm_config_store_dir=/pnpm-store
WORKDIR /src
COPY . .
# Install only what the image builds, so client apps' dependencies (Expo, React Native) never enter the image build.
# `pnpm fetch` cannot be filtered, so the install downloads them itself. Enable pnpm 10's lockfile-backed deploy
# without changing development's linked workspace install.
RUN --mount=type=cache,id=palace-pnpm-store,target=/pnpm-store \
  pnpm install --frozen-lockfile --filter "@palace/control-plane..." --filter "@palace/web..." \
  && pnpm --filter "@palace/control-plane..." build \
  && pnpm --filter @palace/web build \
  && test -f apps/web/dist/index.html \
  && pnpm --config.inject-workspace-packages=true --filter @palace/control-plane deploy --prod --offline /out/control-plane \
  && cp -R apps/web/dist /out/web \
  && mkdir /out/data

FROM node:24.21.0-trixie-slim
ARG PALACE_VERSION=dev
LABEL org.opencontainers.image.title="Palace control plane" \
      org.opencontainers.image.version="$PALACE_VERSION" \
      org.opencontainers.image.source="https://github.com/yy4382/mate"
COPY --from=build /out/control-plane /opt/palace/control-plane
COPY --from=build /out/web /opt/palace/web
COPY --from=build --chown=node:node --chmod=700 /out/data /var/lib/palace
ENV NODE_ENV=production \
    PALACE_DATA_DIRECTORY=/var/lib/palace \
    PALACE_WEB_DIRECTORY=/opt/palace/web \
    PALACE_HOST=0.0.0.0 \
    PALACE_PORT=8787
USER node
VOLUME /var/lib/palace
EXPOSE 8787
# Any API path answers 401 without a session once the server is up; that is the whole check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PALACE_PORT}/api/chat/unread`).then((r) => process.exit(r.status === 401 ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/opt/palace/control-plane/dist/src/main.js"]

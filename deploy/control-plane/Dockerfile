# The control-plane image: `docker build --file deploy/control-plane/Dockerfile .` from the repo root.
# Dependencies are installed on the target platform so native packages match the runtime image.
FROM node:24.21.0-trixie-slim AS build
RUN npm install --global pnpm@10.33.0
WORKDIR /src
COPY . .
# Install only what the image builds, so client apps' dependencies (Expo, React Native) never enter the image build.
# `pnpm fetch` cannot be filtered, so the install downloads them itself. Enable pnpm 10's lockfile-backed deploy
# without changing development's linked workspace install.
RUN pnpm install --frozen-lockfile --filter "@mate/control-plane..." --filter "@mate/web..." \
  && pnpm --filter "@mate/control-plane..." build \
  && pnpm --filter @mate/web build \
  && test -f apps/web/dist/index.html \
  && pnpm --config.inject-workspace-packages=true --filter @mate/control-plane deploy --prod --offline /out/control-plane \
  && cp -R apps/web/dist /out/web \
  && mkdir /out/data

FROM node:24.21.0-trixie-slim
ARG MATE_VERSION=dev
LABEL org.opencontainers.image.title="Mate control plane" \
      org.opencontainers.image.version="$MATE_VERSION" \
      org.opencontainers.image.source="https://github.com/yy4382/mate"
COPY --from=build /out/control-plane /opt/mate/control-plane
COPY --from=build /out/web /opt/mate/web
COPY --from=build --chown=node:node --chmod=700 /out/data /var/lib/mate
ENV NODE_ENV=production \
    MATE_DATA_DIRECTORY=/var/lib/mate \
    MATE_WEB_DIRECTORY=/opt/mate/web \
    MATE_HOST=0.0.0.0 \
    MATE_PORT=8787
USER node
VOLUME /var/lib/mate
EXPOSE 8787
# Any API path answers 401 without a session once the server is up; that is the whole check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.MATE_PORT}/api/chat/unread`).then((r) => process.exit(r.status === 401 ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/opt/mate/control-plane/dist/src/main.js"]

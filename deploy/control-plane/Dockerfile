# The control-plane image: `docker build --file deploy/control-plane/Dockerfile .` from the repo root.
# The build stage runs on the builder's own platform: its output is one JavaScript file and static web files, the
# same on every architecture, so a multi-platform build never emulates pnpm.
FROM --platform=$BUILDPLATFORM node:24.21.0-trixie-slim AS build
RUN npm install --global pnpm@10.33.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline \
  && pnpm --filter @mate/web build \
  && test -f apps/web/dist/index.html \
  && pnpm exec esbuild apps/control-plane/src/main.ts --bundle --platform=node --format=esm \
    --target=node24 --conditions=mate-source --log-level=warning --outfile=/out/control-plane.mjs \
    "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  && cp -R apps/web/dist /out/web \
  && mkdir /out/data

FROM node:24.21.0-trixie-slim
ARG MATE_VERSION=dev
LABEL org.opencontainers.image.title="Mate control plane" \
      org.opencontainers.image.version="$MATE_VERSION" \
      org.opencontainers.image.source="https://github.com/yy4382/mate"
COPY --from=build /out/control-plane.mjs /opt/mate/
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
ENTRYPOINT ["node", "/opt/mate/control-plane.mjs"]

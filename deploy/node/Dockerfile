# Both native architectures compile against Debian 12 glibc, then run on the explicit targets.
FROM node:24.21.0-bookworm AS build
WORKDIR /source
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY . .
ENV npm_config_build_from_source=true
RUN pnpm install --frozen-lockfile && pnpm build:node

# Assemble production packages with the native addons built above.
RUN mkdir -p /production/apps/node /production/packages/protocol && \
    cp package.json pnpm-lock.yaml pnpm-workspace.yaml /production/ && \
    cp apps/node/package.json /production/apps/node/ && \
    cp packages/protocol/package.json /production/packages/protocol/ && \
    cp -r apps/node/dist /production/apps/node/ && \
    cp -r packages/protocol/dist /production/packages/protocol/ && \
    cd /production && pnpm install --prod --offline --frozen-lockfile --ignore-scripts && \
    rm -f /production/node_modules/.pnpm/node_modules/@mate/node && \
    cp -r /source/apps/node/node_modules/better-sqlite3/build /production/apps/node/node_modules/better-sqlite3/ && \
    cp -r /source/apps/node/node_modules/fs-ext/build /production/apps/node/node_modules/fs-ext/

# Include the dedicated runtime, then describe and archive the complete bundle.
ARG MATE_VERSION
RUN mkdir -p /artifact/mate-node/app /artifact/mate-node/node/bin /artifact/mate-node/bin /out && \
    tar --hard-dereference -chf /production.tar -C /production . && \
    tar -xf /production.tar -C /artifact/mate-node/app && \
    cp /usr/local/bin/node /artifact/mate-node/node/bin/node && \
    cp /usr/local/LICENSE /artifact/mate-node/node/LICENSE && \
    cp deploy/node/mate-entry.sh /artifact/mate-node/bin/mate && \
    chmod 755 /artifact/mate-node/bin/mate && \
    node deploy/node/create-metadata.mjs /artifact/mate-node "$MATE_VERSION" && \
    tar --hard-dereference -czf "/out/mate-node-$MATE_VERSION-linux-$(node -p process.arch).tar.gz" -C /artifact mate-node

FROM scratch AS artifact
COPY --from=build /out/ /

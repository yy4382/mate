# The Linux host the node test suite runs on (MODULE_TESTS §8): the repo's Node version, an
# ordinary non-root account, and the sources copied in so Linux dependencies never touch the
# host's node_modules.
FROM node:24.21.0-bookworm
RUN npm install --global pnpm@10.33.0 \
  && mkdir -p /work /home/node/.pnpm-store \
  && chown node:node /work /home/node/.pnpm-store
USER node
WORKDIR /work

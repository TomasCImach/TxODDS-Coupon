FROM node:24-alpine AS builder
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/service/package.json apps/service/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/solana-client/package.json packages/solana-client/package.json
COPY packages/txline-adapter/package.json packages/txline-adapter/package.json
RUN pnpm install --frozen-lockfile
COPY apps/service apps/service
COPY packages packages
RUN pnpm --filter @goaldrop/service... build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
RUN corepack enable
COPY --from=builder /workspace/package.json /workspace/pnpm-lock.yaml /workspace/pnpm-workspace.yaml ./
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/apps ./apps
COPY --from=builder /workspace/packages ./packages
USER node
CMD ["node", "apps/service/dist/cli.js", "api"]

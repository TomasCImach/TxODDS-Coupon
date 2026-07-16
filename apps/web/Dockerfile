FROM node:24-alpine AS builder
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/solana-client/package.json packages/solana-client/package.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages/ui packages/ui
ARG NEXT_PUBLIC_API_ORIGIN
ARG NEXT_PUBLIC_WEB_ORIGIN
ARG NEXT_PUBLIC_SOLANA_RPC_URL
ARG NEXT_PUBLIC_REWARD_MINT
ARG NEXT_PUBLIC_REWARD_DECIMALS=6
ARG NEXT_PUBLIC_DEPLOYMENT_TIER=devnet
ARG NEXT_PUBLIC_PASSKEY_APP_ID
ARG NEXT_PUBLIC_DEMO_CAMPAIGN
ENV NEXT_PUBLIC_API_ORIGIN=$NEXT_PUBLIC_API_ORIGIN \
    NEXT_PUBLIC_WEB_ORIGIN=$NEXT_PUBLIC_WEB_ORIGIN \
    NEXT_PUBLIC_SOLANA_RPC_URL=$NEXT_PUBLIC_SOLANA_RPC_URL \
    NEXT_PUBLIC_REWARD_MINT=$NEXT_PUBLIC_REWARD_MINT \
    NEXT_PUBLIC_REWARD_DECIMALS=$NEXT_PUBLIC_REWARD_DECIMALS \
    NEXT_PUBLIC_DEPLOYMENT_TIER=$NEXT_PUBLIC_DEPLOYMENT_TIER \
    NEXT_PUBLIC_PASSKEY_APP_ID=$NEXT_PUBLIC_PASSKEY_APP_ID \
    NEXT_PUBLIC_DEMO_CAMPAIGN=$NEXT_PUBLIC_DEMO_CAMPAIGN
RUN pnpm --filter @goaldrop/web build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=builder /workspace/apps/web/.next/standalone ./
COPY --from=builder /workspace/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

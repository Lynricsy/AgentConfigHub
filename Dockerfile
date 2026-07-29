# syntax=docker/dockerfile:1.7

FROM node:24-bookworm AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @agent-config-hub/server deploy --legacy --prod /output/server

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV AGENT_CONFIG_HUB_DATA_DIR=/data

RUN groupadd --gid 10001 agent-config-hub \
  && useradd --uid 10001 --gid agent-config-hub --create-home --shell /usr/sbin/nologin agent-config-hub \
  && install --directory --owner agent-config-hub --group agent-config-hub --mode 0700 /data

WORKDIR /opt/agent-config-hub/server
COPY --from=builder --chown=agent-config-hub:agent-config-hub /output/server ./
COPY --from=builder --chown=agent-config-hub:agent-config-hub /workspace/apps/web/dist ../web/dist

USER agent-config-hub
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]

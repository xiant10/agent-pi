# Build from the repository root (the workspace): docker build -f apps/assistant/Dockerfile .
# Runs the TypeScript sources directly: Node 24 strips types natively, so there is no build step.
FROM node:24.21.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json .npmrc ./
COPY packages/agent-pi/package.json packages/agent-pi/
COPY apps/assistant/package.json apps/assistant/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The harness package, then the app: its code, configuration, prompts, skills, and content.
COPY packages/agent-pi/src packages/agent-pi/src
COPY apps/assistant/src apps/assistant/src
COPY apps/assistant/config apps/assistant/config
COPY apps/assistant/prompts apps/assistant/prompts
COPY apps/assistant/skills apps/assistant/skills
COPY apps/assistant/content apps/assistant/content

# SQLite storage lives on a volume so sessions and unfinished runs survive restarts.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
ENV AGENT_CONFIG=/app/apps/assistant/config/agent.json \
    AGENT_DATA_DIR=/data \
    PORT=9800

USER node
EXPOSE 9800

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9800)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# SIGTERM ends event streams, finishes commits, and closes storage; give it time before SIGKILL (compose: stop_grace_period).
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/assistant/src/main.ts"]

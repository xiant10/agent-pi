# The shared runtime: every agent's config, prompts, skills, and content in one image. AGENT_CONFIG picks which one a
# container runs, one agent per process, so deploying another agent is another container of this image.
#   docker build -t agent-pi .
#   docker run -e AGENT_CONFIG=/app/apps/assistant/config/agent.json -v assistant-data:/data agent-pi
# Runs the TypeScript sources directly: Node 24 strips types natively, so there is no build step.
FROM node:24.21.0-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json .npmrc ./
COPY packages/agent-pi/package.json packages/agent-pi/
# Before the install: apps are workspaces, and an app with plugins of its own may have dependencies.
COPY apps apps
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY packages/agent-pi/src packages/agent-pi/src

# SQLite storage lives on a volume so sessions and unfinished runs survive restarts. Give each agent its own volume.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
ENV AGENT_DATA_DIR=/data \
    PORT=18100

USER node
EXPOSE 18100

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||18100)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# SIGTERM ends event streams, finishes commits, and closes storage; give it time before SIGKILL (compose: stop_grace_period).
STOPSIGNAL SIGTERM
# An app with plugins of its own overrides this with its entry point.
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/agent-pi/src/main.ts"]

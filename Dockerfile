# ==============================================================================
# lg-api Docker Image (Multi-Stage Build)
# ==============================================================================
# Produces a lean production image with the lg-api Fastify server and the
# pre-compiled passthrough agent.  No tsx runtime -- agents run as plain Node.js.
#
# Build:  docker build -t lg-api:base .
# Run:    docker run -p 8123:8123 -e LG_API_AUTH_ENABLED=false lg-api:base
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: builder -- install ALL deps, compile TypeScript, build native modules
# ------------------------------------------------------------------------------
FROM node:22-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Server dependencies (layer cache: only re-install when package files change) ---
COPY package.json package-lock.json ./
RUN npm ci

# --- Passthrough agent dependencies ---
COPY agents/passthrough/package.json agents/passthrough/package-lock.json agents/passthrough/
RUN cd agents/passthrough && npm ci

# --- Server source & compile ---
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Passthrough agent source & compile ---
COPY agents/passthrough/tsconfig.json agents/passthrough/
COPY agents/passthrough/src/ agents/passthrough/src/
RUN cd agents/passthrough && npm run build

# ------------------------------------------------------------------------------
# Stage 2: deps -- production-only node_modules (with native modules rebuilt)
# ------------------------------------------------------------------------------
FROM node:22-slim AS deps

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Server production deps ---
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- Passthrough agent production deps ---
COPY agents/passthrough/package.json agents/passthrough/package-lock.json agents/passthrough/
RUN cd agents/passthrough && npm ci --omit=dev && npm cache clean --force

# ------------------------------------------------------------------------------
# Stage 3: production -- minimal runtime image
# ------------------------------------------------------------------------------
FROM node:22-slim AS production

# Create a dedicated non-root user
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

WORKDIR /app

# --- Compiled server ---
COPY --from=builder --chown=appuser:appuser /app/dist ./dist

# --- Compiled passthrough agent ---
COPY --from=builder --chown=appuser:appuser /app/agents/passthrough/dist ./agents/passthrough/dist

# --- Production node_modules (server) ---
COPY --from=deps --chown=appuser:appuser /app/node_modules ./node_modules

# --- Production node_modules (passthrough agent) ---
COPY --from=deps --chown=appuser:appuser /app/agents/passthrough/node_modules ./agents/passthrough/node_modules

# --- package.json files (required for ESM "type": "module" resolution) ---
COPY --chown=appuser:appuser package.json ./
COPY --chown=appuser:appuser agents/passthrough/package.json ./agents/passthrough/

# --- Docker-specific agent registry (pre-compiled paths, no tsx) ---
COPY --chown=appuser:appuser docker/agent-registry.yaml ./agent-registry.yaml

# --- LLM config (uses ${ENV_VAR} references -- no secrets baked in) ---
COPY --chown=appuser:appuser agents/passthrough/llm-config.yaml ./agents/passthrough/

# Switch to non-root user
USER appuser

# --- Environment defaults ---
# NODE_ENV: signals production mode to Node.js and dependencies
ENV NODE_ENV=production
# LG_API_PORT / LG_API_HOST: server listen address inside the container
ENV LG_API_PORT=8123
ENV LG_API_HOST=0.0.0.0
# LG_API_AUTH_ENABLED: default to disabled for standalone / dev usage
ENV LG_API_AUTH_ENABLED=false
# STORAGE_CONFIG_PATH=memory: approved exception to "no fallback" rule.
# The base image must be functional without a storage config file.
# Override at runtime for persistent storage (sqlite, sqlserver, azure-blob).
ENV STORAGE_CONFIG_PATH=memory

EXPOSE 8123

# Health check: lightweight HTTP probe against /ok
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "const http = require('http'); http.get('http://localhost:8123/ok', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["node", "dist/index.js"]

# OCI labels
LABEL org.opencontainers.image.title="lg-api"
LABEL org.opencontainers.image.description="LangGraph-compatible API server with passthrough agent"

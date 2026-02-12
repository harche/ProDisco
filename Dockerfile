# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./
COPY packages/search-libs/package.json ./packages/search-libs/
COPY packages/prometheus-client/package.json ./packages/prometheus-client/
COPY packages/loki-client/package.json ./packages/loki-client/
COPY packages/sandbox-server/package.json ./packages/sandbox-server/

# Install dependencies (ignore prepare scripts like husky)
RUN npm ci --ignore-scripts

# Copy source files
COPY packages/search-libs/ ./packages/search-libs/
COPY packages/prometheus-client/ ./packages/prometheus-client/
COPY packages/loki-client/ ./packages/loki-client/
COPY packages/sandbox-server/ ./packages/sandbox-server/
COPY src/ ./src/
COPY tsconfig.json ./

# Generate proto files and build (dependencies must be built before sandbox-server)
RUN npm run build -w @prodisco/search-libs
RUN npm run build -w @prodisco/prometheus-client
RUN npm run build -w @prodisco/loki-client
RUN npm run proto:generate -w @prodisco/sandbox-server
RUN npm run build -w @prodisco/sandbox-server
RUN npm run build
RUN npm run build:app

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json ./
COPY packages/search-libs/package.json ./packages/search-libs/
COPY packages/prometheus-client/package.json ./packages/prometheus-client/
COPY packages/loki-client/package.json ./packages/loki-client/
COPY packages/sandbox-server/package.json ./packages/sandbox-server/

RUN npm ci --omit=dev --ignore-scripts

# Optional: install additional libraries (from user config) into node_modules at build time
# Example: --build-arg EXTRA_NPM_PACKAGES="@aws-sdk/client-s3 @google-cloud/storage"
ARG EXTRA_NPM_PACKAGES=""
RUN if [ -n "$EXTRA_NPM_PACKAGES" ]; then npm install --omit=dev --no-audit --no-fund --ignore-scripts $EXTRA_NPM_PACKAGES; fi

# Copy config file if provided (build script creates .prodisco-config.yaml in build context)
# This file contains library descriptions for runtime
COPY .prodisco-config.yam[l] /app/

# Copy built files from builder
COPY --from=builder /app/packages/search-libs/dist ./packages/search-libs/dist
COPY --from=builder /app/packages/prometheus-client/dist ./packages/prometheus-client/dist
COPY --from=builder /app/packages/loki-client/dist ./packages/loki-client/dist
COPY --from=builder /app/packages/sandbox-server/dist ./packages/sandbox-server/dist
COPY --from=builder /app/dist ./dist

# Create cache directory for scripts
RUN mkdir -p /tmp/prodisco-scripts

# Set environment variables
ENV NODE_ENV=production
ENV SCRIPTS_CACHE_DIR=/tmp/prodisco-scripts

# Expose HTTP port (default MCP HTTP port)
EXPOSE 3000

# Default to HTTP transport mode
ENV MCP_TRANSPORT=http
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3000

# Run the MCP server (use config file if present for library descriptions)
CMD ["sh", "-c", "if [ -f /app/.prodisco-config.yaml ]; then node dist/server.js --config /app/.prodisco-config.yaml; else node dist/server.js; fi"]

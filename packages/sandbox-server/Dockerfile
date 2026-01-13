# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json ./
COPY package-lock.json ./
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

# Build dependencies first (sandbox-server depends on them)
RUN npm run build --workspace=@prodisco/search-libs
RUN npm run build --workspace=@prodisco/prometheus-client
RUN npm run build --workspace=@prodisco/loki-client

# Build the sandbox-server
RUN npm run build --workspace=@prodisco/sandbox-server

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install only production dependencies (ignore prepare scripts)
COPY package.json ./
COPY package-lock.json ./
COPY packages/search-libs/package.json ./packages/search-libs/
COPY packages/prometheus-client/package.json ./packages/prometheus-client/
COPY packages/loki-client/package.json ./packages/loki-client/
COPY packages/sandbox-server/package.json ./packages/sandbox-server/

RUN npm ci --omit=dev --ignore-scripts

# Optional: install additional libraries (from user config) into node_modules at build time
ARG EXTRA_NPM_PACKAGES=""
RUN if [ -n "$EXTRA_NPM_PACKAGES" ]; then npm install --omit=dev --no-audit --no-fund --ignore-scripts $EXTRA_NPM_PACKAGES; fi

# Copy config file if provided (build script creates .prodisco-config.yaml in build context)
# This file contains library names for SANDBOX_ALLOWED_MODULES
COPY .prodisco-config.yam[l] /app/

# Copy built files from builder
COPY --from=builder /app/packages/search-libs/dist ./packages/search-libs/dist
COPY --from=builder /app/packages/prometheus-client/dist ./packages/prometheus-client/dist
COPY --from=builder /app/packages/loki-client/dist ./packages/loki-client/dist
COPY --from=builder /app/packages/sandbox-server/dist ./packages/sandbox-server/dist

# Create cache directory for scripts
RUN mkdir -p /tmp/prodisco-scripts

# Set environment variables
ENV NODE_ENV=production
ENV SANDBOX_USE_TCP=true
ENV SANDBOX_TCP_HOST=0.0.0.0
ENV SANDBOX_TCP_PORT=50051
ENV SCRIPTS_CACHE_DIR=/tmp/prodisco-scripts

# Expose gRPC port
EXPOSE 50051

# Run the sandbox server
CMD ["node", "packages/sandbox-server/dist/server/index.js"]

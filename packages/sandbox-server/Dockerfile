# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json ./
COPY packages/loki-client/package.json ./packages/loki-client/
COPY packages/sandbox-server/package.json ./packages/sandbox-server/

# Install dependencies (ignore prepare scripts like husky)
RUN npm install --workspace=@prodisco/loki-client --workspace=@prodisco/sandbox-server --ignore-scripts

# Copy source files
COPY packages/loki-client/ ./packages/loki-client/
COPY packages/sandbox-server/ ./packages/sandbox-server/

# Build loki-client first (sandbox-server depends on it)
RUN npm run build --workspace=@prodisco/loki-client

# Build the sandbox-server
RUN npm run build --workspace=@prodisco/sandbox-server

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install only production dependencies (ignore prepare scripts)
COPY package.json ./
COPY packages/loki-client/package.json ./packages/loki-client/
COPY packages/sandbox-server/package.json ./packages/sandbox-server/

RUN npm install --workspace=@prodisco/loki-client --workspace=@prodisco/sandbox-server --omit=dev --ignore-scripts

# Copy built files from builder
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

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for dependency installation
COPY package.json package-lock.json ./
COPY packages/loki-client/package.json ./packages/loki-client/
COPY packages/sandbox-server/package.json ./packages/sandbox-server/

# Install dependencies (ignore prepare scripts like husky)
RUN npm ci --ignore-scripts

# Copy source files
COPY packages/loki-client/ ./packages/loki-client/
COPY packages/sandbox-server/ ./packages/sandbox-server/
COPY src/ ./src/
COPY tsconfig.json ./

# Generate proto files and build (loki-client must be built before sandbox-server)
RUN npm run build -w @prodisco/loki-client
RUN npm run proto:generate -w @prodisco/sandbox-server
RUN npm run build -w @prodisco/sandbox-server
RUN npm run build

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json ./
COPY packages/sandbox-server/package.json ./packages/sandbox-server/

RUN npm ci --omit=dev --ignore-scripts

# Copy built files from builder
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

# Run the MCP server
CMD ["node", "dist/server.js"]

FROM node:20-alpine

# Install build dependencies and pip for mediasoup
RUN apk add --no-cache \
    make \
    gcc \
    g++ \
    python3 \
    py3-pip \
    linux-headers

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy app source code
COPY . .

# Create non-root user and set ownership
RUN addgroup -g 1001 -S nodejs \
 && adduser -S nodejs -u 1001 \
 && chown -R nodejs:nodejs /app

USER nodejs

# Expose your app port
EXPOSE 3000

# Optional health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js || exit 1

# Start app
CMD ["node", "server.js"]

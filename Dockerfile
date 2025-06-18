# --- Base Stage ---
FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./

# Add required system libraries for onnxruntime-node
RUN apk add --no-cache \
    libc6-compat \
    gcompat

# --- Dependencies Stage ---
FROM base AS dependencies
# Install dependencies with cache optimization
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund \
    && npm cache clean --force

# --- Development Dependencies Stage ---
FROM base AS dev-dependencies  
RUN npm install --legacy-peer-deps --no-audit --no-fund \
    && npm cache clean --force

# --- Development Stage ---
FROM dev-dependencies AS development
COPY src src
COPY .env* ./
ENV NODE_ENV=development
ENV PORT=3100
EXPOSE 3100
CMD ["npm", "run", "dev"]

# --- Production Stage ---
FROM node:22-alpine AS production
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodejs -u 1001 \
    && apk add --no-cache \
    libc6-compat \
    gcompat

# Copy only production dependencies from dependencies stage
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package*.json ./

# Copy source code
COPY src src
COPY .env* ./

# Set proper ownership
RUN chown -R nodejs:nodejs /app
USER nodejs

ENV NODE_ENV=production
ENV PORT=3100
EXPOSE 3100

# Use exec form for better signal handling
CMD ["node", "src/index.js"]

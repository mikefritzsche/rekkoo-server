# --- Base Stage ---
FROM node:20-bullseye AS base

# Install Chromium, editors, and dependencies for both ARM64 and x86_64
RUN apt-get update && \
    apt-get install -y \
    chromium \
    nano \
    vim \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set Puppeteer to skip downloading Chromium (we use system Chromium)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# --- Dependencies Stage ---
FROM base AS dependencies
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund && npm cache clean --force

# --- Development Stage ---
FROM base AS development
COPY package*.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund && npm cache clean --force
COPY . .
ENV NODE_ENV=development
EXPOSE 3100
CMD ["npm", "run", "dev"]

# --- Production Stage ---
FROM base AS production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package*.json ./
COPY . .
ENV NODE_ENV=production
EXPOSE 3100
CMD ["node", "src/index.js"]

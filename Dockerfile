# --- Base Stage ---
FROM node:18-alpine AS base
WORKDIR /app
COPY package*.json ./

# --- Dependencies Stage (used by both dev and prod) ---
FROM base AS deps
RUN npm install --omit=dev # Install only production deps first (layer caching)
RUN npm install # Install all deps including devDependencies

FROM base AS development
RUN npm install nodemon
COPY src src
COPY .env* ./
ENV PORT=3100
EXPOSE 3100
CMD ["npm", "run", "dev"]

FROM base AS production
RUN npm install --omit=dev
COPY src src
COPY .env* ./
ENV PORT=3100
EXPOSE 3100
CMD ["node", "src/index.js"]

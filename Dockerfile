FROM node:18-alpine AS base
WORKDIR /app
COPY package*.json ./

FROM base AS development
RUN npm install
COPY src src
COPY .env* ./
EXPOSE 3000
CMD ["npm", "run", "dev"]

FROM base AS production
RUN npm install --omit=dev
COPY src src
COPY .env* ./
EXPOSE 3000
CMD ["node", "src/index.js"]

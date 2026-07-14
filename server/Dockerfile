FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts

EXPOSE 3001
CMD ["node", "src/index.js"]

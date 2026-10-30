FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=4096

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

EXPOSE 4000
CMD ["node", "src/server.js"]

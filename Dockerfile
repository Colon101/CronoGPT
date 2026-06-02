FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CRONOMETER_LOCAL_CHROMIUM=true

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production

EXPOSE 10000

CMD ["npm", "start"]

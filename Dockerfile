FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CRONOMETER_LOCAL_CHROMIUM=true

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 10000

CMD ["npm", "start"]

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN ls -la node_modules/.bin && chmod -R +x node_modules/.bin

# ✅ compila TypeScript a /app/dist
RUN npm run build

RUN ls -la && ls -la dist && find dist -maxdepth 3 -type f -name "server.js" -print

CMD ["npm", "run", "start"]

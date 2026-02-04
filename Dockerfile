FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN ls -la node_modules/.bin && chmod -R +x node_modules/.bin

# ✅ compila TypeScript a /app/dist
RUN npm run build

CMD ["npm", "run", "start"]

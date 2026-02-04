FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# ✅ compila TypeScript a /app/dist
RUN npm run build

CMD ["npm", "run", "start"]

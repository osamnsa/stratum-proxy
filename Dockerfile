FROM node:18-alpine

# Install build tools needed for native modules and WASM
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./

RUN npm install --verbose

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]

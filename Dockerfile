FROM node:20-alpine

WORKDIR /app

# Copiar temp-libsignal primeiro (usado como override)
COPY temp-libsignal/ ./temp-libsignal/

# Copiar package.json e instalar deps
COPY package.json ./
RUN npm install --production && rm -rf ./node_modules/libsignal && cp -r ./temp-libsignal ./node_modules/libsignal

# Copiar código fonte
COPY src/ ./src/
COPY eng.traineddata ./

# Copiar sessão de autenticação Baileys (se existir)
COPY auth_info/ ./auth_info/

EXPOSE 3333

CMD ["node", "src/bot.js"]

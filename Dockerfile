FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY public ./public
COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV HTTP_PORT=8080
ENV DEVICE_MQTT_PORT=8885

EXPOSE 8080 8885

CMD ["node", "src/index.js"]

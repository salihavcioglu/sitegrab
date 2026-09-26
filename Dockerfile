FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY bin ./bin
COPY public ./public

RUN mkdir -p data/tmp data/zips \
    && addgroup -S sitegrab \
    && adduser -S sitegrab -G sitegrab \
    && chown -R sitegrab:sitegrab /app

USER sitegrab

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server/index.js"]

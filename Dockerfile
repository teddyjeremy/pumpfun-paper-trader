FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/src/server.js"]

# Optional container build (works on Fly.io, Render, Cloud Run, etc.).
# Railway/Render can also build from source without this file.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Host injects PORT and the CLICKBANK_CLERK_KEY / MCP_AUTH_TOKEN secrets.
EXPOSE 3000
CMD ["node", "dist/index.js"]

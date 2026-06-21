# ---- build stage: compile TypeScript ----
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build   # → dist/src/**

# ---- runtime stage: lean image, production deps only ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled app. server.js resolves the demo UI at ../demo relative to dist/src,
# i.e. dist/demo — so place the demo there.
COPY --from=builder /app/dist ./dist
COPY demo ./dist/demo

EXPOSE 3000
# Configure at runtime, e.g.:
#   docker run -p 3000:3000 -e OPENAI_API_KEY=sk-... ct-viz-agent
CMD ["node", "dist/src/index.js"]

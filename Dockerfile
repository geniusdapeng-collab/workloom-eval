FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=4317 EVAL_AUTH_MODE=password EVAL_DB_PATH=/data/eval.sqlite
EXPOSE 4317
VOLUME ["/data"]
CMD ["node","server/index.mjs"]

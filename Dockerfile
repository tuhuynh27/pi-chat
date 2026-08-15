# syntax=docker/dockerfile:1

ARG NODE_VERSION=22-bookworm-slim
ARG PNPM_VERSION=11.5.3

FROM node:${NODE_VERSION} AS base

ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install --global "pnpm@${PNPM_VERSION}"

WORKDIR /app

FROM base AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm install --prod --frozen-lockfile

FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

FROM node:${NODE_VERSION} AS runtime

ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000 \
	PI_WEB_DATA_DIR=/data

WORKDIR /app

RUN mkdir -p /data /home/node/.pi/agent \
	&& chown -R node:node /data /home/node/.pi

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/api/auth/status').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "build"]

# molt-dispatch — broker (and worker) image.
# Single image; the ECS task definition CMD selects the role:
#   broker:  node bin/molt.mjs broker start
#   worker:  node bin/molt.mjs worker start --adapters bedrock
#
# Node 24 required: uses node:sqlite (built-in), requires Node >=24.
FROM node:24-alpine
WORKDIR /app

# No npm install — zero-dep project.
COPY package.json ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY dashboard/ ./dashboard/

# ECS/Fargate: listen on all interfaces; port forwarded through the ALB target group.
ENV MOLT_HOST=0.0.0.0
ENV MOLT_PORT=7077
EXPOSE 7077

# Broker health check — ALB also checks /grid/health (includes path prefix).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- "http://127.0.0.1:${MOLT_PORT}/health" || exit 1

CMD ["node", "bin/molt.mjs", "broker", "start"]

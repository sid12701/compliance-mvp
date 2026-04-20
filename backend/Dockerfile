FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    PYTHONUNBUFFERED=1 \
    PYTHON_SCRIPT_PATH=/app/backend/python \
    WORKERS_ENABLED=true

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json

RUN npm ci --omit=dev --workspace backend --include-workspace-root=false

COPY backend ./backend

RUN pip3 install --no-cache-dir -r backend/requirements.txt

WORKDIR /app/backend

EXPOSE 8080

CMD ["node", "src/index.js"]

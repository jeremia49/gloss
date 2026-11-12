# syntax=docker/dockerfile:1

# ---- Frontend build ---------------------------------------------------------
FROM node:22-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN npm ci --no-fund --no-audit
COPY frontend/ ./
RUN npm run build

# ---- Application ------------------------------------------------------------
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    GLOSS_DATA_DIR=/data \
    GLOSS_CACHE_DIR=/data/cache \
    GLOSS_FRONTEND_DIST=/app/frontend/dist

WORKDIR /app/backend

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY --from=frontend /build/frontend/dist /app/frontend/dist

RUN useradd --create-home --uid 10001 gloss \
    && mkdir -p /data/cache \
    && chown -R gloss:gloss /data /app
USER gloss

VOLUME ["/data"]
EXPOSE 8010

# --proxy-headers lets the login rate limiter and Secure cookies see the real
# client scheme/address from Caddy. Port 8010 is never published to the host.
CMD ["python", "-m", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8010", \
     "--proxy-headers", \
     "--forwarded-allow-ips", "*"]
# Build only from the generated, reviewed Space directory. No parent checkout.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN VITE_DEPLOYMENT_MODE=explorer npm run build

FROM python:3.11-slim@sha256:673719e071ecf27434fd2635bbd8d00f49f4fdd81f243143438a42ced8bedf60
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HF_HUB_DISABLE_XET=1 HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_ETAG_TIMEOUT=30 HF_HUB_DOWNLOAD_TIMEOUT=60 HF_HUB_DISABLE_PROGRESS_BARS=1 \
    OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 HOME=/home/explorer
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --only-binary=:all: --no-deps -r requirements.lock && pip check \
    && groupadd --gid 1000 explorer && useradd --uid 1000 --gid 1000 --create-home explorer \
    && mkdir /data && chown 1000:1000 /data
COPY hf_export/ ./hf_export/
COPY --from=frontend /build/dist/ ./static/
COPY LICENSE.md THIRD_PARTY_NOTICES.txt PUBLICATION.md ./
USER 1000:1000
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=30m --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/api/health',timeout=4)"
CMD ["python", "-m", "hf_export.release_bootstrap"]

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS dependencies
WORKDIR /dependencies
COPY interface/frontend/package.json interface/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
FROM python:3.11-slim@sha256:673719e071ecf27434fd2635bbd8d00f49f4fdd81f243143438a42ced8bedf60
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HUB_DISABLE_XET=1 HF_HUB_DISABLE_TELEMETRY=1 HF_HUB_DISABLE_PROGRESS_BARS=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
COPY interface/explorer/requirements.lock /tooling/requirements.lock
RUN pip install --no-cache-dir --only-binary=:all: --no-deps -r /tooling/requirements.lock && pip check
COPY --from=dependencies /dependencies/node_modules /opt/frontend/node_modules
WORKDIR /tmp

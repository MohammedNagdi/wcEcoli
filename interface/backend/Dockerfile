FROM python:3.11-slim

WORKDIR /app

# Install Docker CLI (needed by sim_worker to launch simulation containers)
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg \
    && arch="$(dpkg --print-architecture)" \
    && . /etc/os-release \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg \
    && echo "deb [arch=$arch signed-by=/usr/share/keyrings/docker.gpg] https://download.docker.com/linux/debian $VERSION_CODENAME stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && apt-get purge -y curl gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps (cached layer)
COPY pyproject.toml .
RUN pip install --no-cache-dir hatchling \
    && mkdir -p app && touch app/__init__.py \
    && pip install --no-cache-dir . \
    && rm -rf app

COPY app/ app/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

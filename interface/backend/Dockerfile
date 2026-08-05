FROM python:3.11-slim

WORKDIR /app
ENV PYTHONPATH=/app

# Install Python deps (cached layer)
COPY pyproject.toml .
RUN pip install --no-cache-dir hatchling \
    && mkdir -p app && touch app/__init__.py \
    && pip install --no-cache-dir ".[dev]" \
    && rm -rf app

COPY app/ app/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

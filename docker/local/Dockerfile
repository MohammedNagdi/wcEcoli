FROM python:3.10.16-bullseye

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OPENBLAS_NUM_THREADS=1 \
    OMP_NUM_THREADS=1 \
    PYTHONPATH=/wcEcoli

WORKDIR /wcEcoli

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        gfortran \
        swig \
        llvm \
        cmake \
        nano \
        git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt

# Install conflict-prone dependencies first, then install the rest of requirements.
RUN pip install --upgrade "pip<25.0" "setuptools==70.0.0" wheel cmake \
    && pip install "stochastic-arrow>=1.1.0" \
    && pip install Equation==1.2.01 --no-build-isolation \
    && pip install qdldl osqp \
    && grep -vE "^(osqp|qdldl|stochastic-arrow)([<>=!~].*)?$" /tmp/requirements.txt > /tmp/requirements.filtered.txt \
    && pip install -r /tmp/requirements.filtered.txt

COPY . /wcEcoli

# Build C extensions and register project package (best effort for editable install).
RUN find . -name "*.egg-info" -type d -prune -exec rm -rf {} + \
    && find . -name "*.egg-info" -type f -delete \
    && rm -rf build/ dist/ \
    && make clean compile \
    && (pip install -e . --no-deps --no-build-isolation || true)

COPY docker/local/entrypoint.sh /usr/local/bin/wcecoli-entrypoint
RUN chmod +x /usr/local/bin/wcecoli-entrypoint \
    && umask 000 \
    && mkdir -p /wcEcoli/out /wcEcoli/cache /.aesara

ENTRYPOINT ["wcecoli-entrypoint"]
CMD ["bash"]

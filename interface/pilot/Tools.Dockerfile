ARG PILOT_BASE
FROM ${PILOT_BASE}
RUN rm -rf /app/app /app/hf_export
COPY interface/backend/app /app/app
COPY interface/backend/hf_export /app/hf_export
COPY reconstruction /wcEcoli/reconstruction
COPY models /wcEcoli/models
COPY wholecell/loggers/disk.py /app/hf_export/source_clock_writer.data
ENV PYTHONPATH=/app PYTHONDONTWRITEBYTECODE=1

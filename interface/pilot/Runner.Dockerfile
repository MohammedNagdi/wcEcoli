# Dependencies come from an immutable, inspected local simulation image.
ARG PILOT_BASE
FROM ${PILOT_BASE}
RUN rm -rf /wcEcoli && mkdir /wcEcoli
COPY . /wcEcoli
RUN make clean compile

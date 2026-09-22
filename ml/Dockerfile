# The SUGO category service.
#
# The models are trained INTO the image rather than mounted beside it. A
# container that cannot start without a volume is a container that silently
# serves yesterday's model when the volume is missing, and this one is in front
# of a live dispatch flow. Retraining means rebuilding, which is a deliberate,
# logged act with a tag on it.
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sugo_category ./sugo_category
COPY app.py .

# Train from the seed lexicon at build time so the image is always able to
# answer something. A real deploy overrides this with the database-backed model:
#
#   docker build --build-arg TRAIN_ARGS="--database-url mysql+pymysql://..." .
#
# Baked in either way, so the running container needs no database at all.
ARG TRAIN_ARGS="--offline"
# Busts the build cache for the training step, and ONLY that step.
#
# Without it, retraining against new data is silently a no-op: when neither the
# code nor TRAIN_ARGS has changed, Docker reuses the previously trained layer,
# the build reports success, and the "retrained" container serves the old model.
# That is exactly the retrain-after-dispatcher-corrections case this image
# exists for. Found on 2026-09-23 when a retrain meant to drop deleted test data
# printed no training output at all and kept the old row counts.
#
# Pass a fresh value on every build that should retrain:
#   --build-arg TRAINED_AT=$(date +%s)
# Any RUN after an ARG sees it as an environment variable, so a changed value
# is a cache miss here and nowhere earlier - the pip install stays cached.
ARG TRAINED_AT=unset
RUN echo "training run ${TRAINED_AT}" && python -m sugo_category.train ${TRAIN_ARGS} --out /srv/models

# Not root. This process parses strings that arrive from a dispatcher's search
# box, by way of two other services; there is no reason for it to be able to
# write to its own image.
RUN useradd --system --uid 10001 sugo && chown -R sugo:sugo /srv
USER sugo

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,json,sys; \
r=json.load(urllib.request.urlopen('http://127.0.0.1:8100/health')); \
sys.exit(0 if r.get('ready') else 1)"

# One worker. The models are a few megabytes of TF-IDF vocabulary each and every
# worker loads its own copy; a dispatcher pinning a shop is not a throughput
# problem, and two workers would double the memory for no measurable gain.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100", "--workers", "1"]

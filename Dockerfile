FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=7860 \
    HOME=/home/user \
    INSIGHTFACE_MODEL_ROOT=/opt/insightface \
    MPLCONFIGDIR=/tmp/matplotlib

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    ca-certificates \
    curl \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user

WORKDIR /app

COPY backend/requirements*.txt /tmp/
RUN pip install --upgrade pip setuptools wheel \
    && pip install -r /tmp/requirements.txt

COPY --chown=user:user backend /app/backend
COPY --chown=user:user migrations /app/migrations
COPY --chown=user:user alembic.ini /app/alembic.ini

# Download the model while building the image.  Hugging Face instances are
# ephemeral, so downloading it at first face scan makes production recognition
# slow and unreliable after a cold start.
RUN mkdir -p /opt/insightface /tmp/matplotlib \
    && python -c "from backend.ai_service import init_face_analyzer; init_face_analyzer()" \
    && chown -R user:user /app /home/user /opt/insightface /tmp/matplotlib

USER user

EXPOSE 7860

CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-7860}"]

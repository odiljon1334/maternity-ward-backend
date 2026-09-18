FROM python:3.11-slim

WORKDIR /app

# InsightFace/OpenCV uchun kerakli minimal tizim kutubxonalari
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Model fayllari shu papkada saqlanadi (docker-compose'da volume sifatida
# ulanadi — shunda konteyner qayta ko'tarilganda model qayta yuklanmaydi)
ENV INSIGHTFACE_HOME=/root/.insightface

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]

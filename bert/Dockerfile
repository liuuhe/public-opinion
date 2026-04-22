FROM python:3.11-slim

WORKDIR /app
ENV MODEL_DIR=model
ENV PYTHONUNBUFFERED=1

COPY requirements-container.txt .
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
  && pip install --no-cache-dir -r requirements-container.txt

COPY app.py .
COPY models/xhs-bert-sentiment ./model

EXPOSE 7860
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]

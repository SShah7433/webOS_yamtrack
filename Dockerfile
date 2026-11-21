FROM python:3.12-alpine
WORKDIR /app
COPY requirements.txt .
RUN python -m venv /opt/venv && /opt/venv/bin/python -m pip install --no-cache-dir -r requirements.txt
ENV PATH="/opt/venv/bin:$PATH"
COPY helper /app/helper
ENV PYTHONUNBUFFERED=1 TV_BIND=0.0.0.0 TV_PORT=8765 TV_STATE=/data/sessions.json
EXPOSE 8765
CMD ["python", "-m", "helper.server"]

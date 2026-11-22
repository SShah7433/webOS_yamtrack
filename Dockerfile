FROM python:3.12-alpine
WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY helper /app/helper
RUN addgroup -S -g 10001 yamtrack \
    && adduser -S -D -H -u 10001 -G yamtrack yamtrack \
    && mkdir /data \
    && chown 10001:10001 /data
ENV PYTHONUNBUFFERED=1 TV_BIND=0.0.0.0 TV_PORT=8765 TV_STATE=/data/sessions.json
EXPOSE 8765
USER 10001:10001
CMD ["python", "-m", "helper.server"]

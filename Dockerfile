FROM python:3.13-alpine
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DB_PATH=/data/coffee.sqlite3 PORT=8080
WORKDIR /app
RUN addgroup -S coffee && adduser -S coffee -G coffee && mkdir /data && chown coffee:coffee /data
COPY --chown=coffee:coffee server.py ./
COPY --chown=coffee:coffee static ./static
USER coffee
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)"
CMD ["python", "server.py"]

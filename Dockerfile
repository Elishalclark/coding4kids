# Coding4Kids — pure Python stdlib, no dependencies to install.
FROM python:3.12-slim

WORKDIR /app
COPY . .

# Database + secrets live on a persistent disk mounted at /data (see render.yaml).
ENV DATA_DIR=/data
RUN mkdir -p /data

# The app reads PORT from the environment (Render provides it).
EXPOSE 3000
CMD ["python3", "server.py"]

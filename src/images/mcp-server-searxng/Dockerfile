FROM docker.repo.eng.netapp.com/node:20-alpine

WORKDIR /app
COPY server.js /app/server.js

USER 1000
EXPOSE 8000

ENTRYPOINT ["node", "/app/server.js"]

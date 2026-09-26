# Local-dev container: runs the Vite dev server with hot reload so it fits
# the same docker-compose loop as every other service. Production would
# instead run `vite build` and serve the static bundle from Nginx/a CDN -
# see docs/PRODUCTION.md.
FROM node:20-alpine
WORKDIR /app/apps/frontend
COPY apps/frontend/package.json ./
RUN npm install
COPY apps/frontend .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

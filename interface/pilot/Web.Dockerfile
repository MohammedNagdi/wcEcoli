FROM node:20-alpine AS build
WORKDIR /app
COPY interface/frontend/package*.json ./
RUN npm ci
COPY interface/frontend/ ./
RUN VITE_DEPLOYMENT_MODE=explorer npm run build
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY interface/pilot/nginx.conf /etc/nginx/conf.d/default.conf

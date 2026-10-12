FROM node:22-bookworm
WORKDIR /app
COPY --chown=node:node . .
RUN npm --prefix qq-agent ci --omit=dev --ignore-scripts --no-audit --no-fund
ENV HOST=0.0.0.0 PORT=8080 SKIP_NAPCAT=1
USER node
EXPOSE 8080
CMD ["sh", "一键部署启动.sh"]

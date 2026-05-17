FROM apify/actor-node:24

USER root

RUN apk add --no-cache curl unzip ca-certificates \
    && curl -fsSL https://go.dev/dl/go1.26.3.linux-amd64.tar.gz -o /tmp/go.tar.gz \
    && rm -rf /usr/local/go \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm /tmp/go.tar.gz

ENV PATH="/usr/local/go/bin:$PATH"

RUN CGO_ENABLED=0 GOMAXPROCS=1 go install -p 1 -ldflags="-s -w" github.com/mvanhorn/printing-press-library/library/productivity/slack/cmd/slack-pp-mcp@latest \
    && cp /root/go/bin/slack-pp-mcp /usr/local/bin/ \
    && chmod +x /usr/local/bin/slack-pp-mcp

WORKDIR /home/myuser

USER myuser

COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm ci --legacy-peer-deps --include=dev \
    && echo "Node.js version:" && node --version \
    && rm -r ~/.npm

COPY --chown=myuser:myuser . .

RUN npm run build

CMD ["node", "dist/main.js"]

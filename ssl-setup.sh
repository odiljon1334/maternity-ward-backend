#!/bin/bash
# ============================================================
# ssl-setup.sh — Domain olgach SSL qo'shish
# Ishlatish: bash ssl-setup.sh YOUR_DOMAIN.COM
# ============================================================

set -e

DOMAIN="${1:?'Domain kerak: bash ssl-setup.sh YOUR_DOMAIN.COM'}"
BACKEND_DIR="/home/deploy/maternity-ward-backend"
NGINX_CONF="$BACKEND_DIR/nginx/nginx.conf"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log()     { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo "🔐 SSL Setup — $DOMAIN"
echo ""

# ── 1. DNS tekshirish ─────────────────────────────────────────
VPS_IP=$(curl -s ifconfig.me)
DNS_IP=$(dig +short "$DOMAIN" | head -1)
log "VPS IP: $VPS_IP"
log "DNS IP: $DNS_IP"
if [ "$VPS_IP" != "$DNS_IP" ]; then
    error "DNS hali to'g'ri ko'rsatilmagan! $DOMAIN → $DNS_IP (bo'lishi kerak: $VPS_IP)"
fi
success "DNS to'g'ri ko'rsatilgan"

# ── 2. Certbot bilan SSL olish ────────────────────────────────
log "SSL sertifikat olinmoqda..."
# Port 80 vaqtincha bo'shatish
docker stop maternity_nginx 2>/dev/null || true

certbot certonly --standalone \
    --non-interactive \
    --agree-tos \
    --email "admin@$DOMAIN" \
    -d "$DOMAIN" \
    -d "www.$DOMAIN"

success "SSL sertifikat olindi"

# ── 3. Nginx configni SSL ga yangilash ────────────────────────
log "Nginx config SSL ga o'tkazilmoqda..."
cat > "$NGINX_CONF" << NGINXSSL
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
    use epoll;
    multi_accept on;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    log_format main '\$remote_addr - [\$time_local] "\$request" \$status \$body_bytes_sent';
    access_log /var/log/nginx/access.log main;

    sendfile on; tcp_nopush on; keepalive_timeout 65;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/javascript;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    limit_req_zone \$binary_remote_addr zone=api:10m rate=30r/s;
    limit_req_zone \$binary_remote_addr zone=login:10m rate=5r/m;

    upstream backend  { server maternity_backend:5001;  keepalive 32; }
    upstream frontend { server maternity_frontend:5000; keepalive 16; }

    # HTTP → HTTPS redirect
    server {
        listen 80;
        server_name $DOMAIN www.$DOMAIN;
        location /.well-known/acme-challenge/ { root /var/www/certbot; }
        location / { return 301 https://\$host\$request_uri; }
    }

    # HTTPS
    server {
        listen 443 ssl http2;
        server_name $DOMAIN www.$DOMAIN;

        ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_session_cache shared:SSL:10m;

        client_max_body_size 15M;

        location / {
            proxy_pass http://frontend;
            proxy_http_version 1.1;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-Proto \$scheme;
        }

        location /api/ {
            limit_req zone=api burst=50 nodelay;
            proxy_pass http://backend;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_read_timeout 120s;
        }

        location /api/v1/auth/login {
            limit_req zone=login burst=3 nodelay;
            proxy_pass http://backend;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Forwarded-Proto \$scheme;
        }

        location /uploads/ {
            proxy_pass http://backend;
            expires 7d;
            add_header Cache-Control "public, immutable";
        }

        location /ws/ {
            proxy_pass http://backend;
            proxy_http_version 1.1;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "Upgrade";
            proxy_set_header Host \$host;
            proxy_read_timeout 3600s;
        }

        location /hikvision/ {
            proxy_pass http://backend;
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            client_max_body_size 25M;
        }
    }
}
NGINXSSL

success "Nginx config yangilandi"

# ── 4. .env.prod da FRONTEND_URL yangilash ────────────────────
log ".env.prod yangilanmoqda..."
sed -i "s|FRONTEND_URL=.*|FRONTEND_URL=https://$DOMAIN|" "$BACKEND_DIR/.env.prod"
sed -i "s|NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=https://$DOMAIN/api/v1|" "$BACKEND_DIR/.env.prod"
success ".env.prod yangilandi"

# ── 5. Auto-renewal cron ──────────────────────────────────────
(crontab -l 2>/dev/null; echo "0 3 * * 1 certbot renew --quiet && docker restart maternity_nginx") | sort -u | crontab -
success "SSL auto-renewal sozlandi (har dushanba soat 03:00)"

# ── 6. Redeploy ───────────────────────────────────────────────
log "Redeploy qilinmoqda..."
bash "$BACKEND_DIR/deploy.sh"

success "SSL muvaffaqiyatli sozlandi! 🔐"
echo ""
echo "  Sayt: https://$DOMAIN"

#!/bin/bash
# ============================================================
# vps-setup.sh — Contabo VPS dastlabki sozlash
# ROOT sifatida BIR MARTA ishlatiladi:
#   scp vps-setup.sh root@YOUR_VPS_IP:~/ 
#   ssh root@YOUR_VPS_IP "bash vps-setup.sh YOUR_DOMAIN.COM"
# ============================================================

set -e

DOMAIN="${1:-YOUR_DOMAIN.COM}"
DEPLOY_USER="deploy"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'
log()     { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo "🏥 VPS Setup — Maternity Ward"
echo "Domain: $DOMAIN"
echo ""

# ── 1. Sistema yangilash ─────────────────────────────────────
log "1. Sistema yangilanmoqda..."
apt-get update -q && apt-get upgrade -y -q
apt-get install -y -q curl git ufw fail2ban
success "Sistema yangilandi"

# ── 2. Deploy user yaratish ──────────────────────────────────
log "2. '$DEPLOY_USER' foydalanuvchi yaratilmoqda..."
if ! id "$DEPLOY_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$DEPLOY_USER"
    usermod -aG sudo "$DEPLOY_USER"
    echo "$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker compose" >> /etc/sudoers.d/deploy
    success "'$DEPLOY_USER' yaratildi"
else
    success "'$DEPLOY_USER' allaqachon mavjud"
fi

# ── 3. Docker o'rnatish ──────────────────────────────────────
log "3. Docker o'rnatilmoqda..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
    usermod -aG docker "$DEPLOY_USER"
    success "Docker o'rnatildi"
else
    success "Docker allaqachon o'rnatilgan: $(docker --version)"
fi

# ── 4. Certbot (SSL) ─────────────────────────────────────────
log "4. Certbot o'rnatilmoqda..."
if ! command -v certbot &>/dev/null; then
    apt-get install -y -q certbot
    success "Certbot o'rnatildi"
else
    success "Certbot allaqachon mavjud"
fi

# ── 5. Firewall sozlash ──────────────────────────────────────
log "5. Firewall (UFW) sozlanmoqda..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
success "Firewall sozlandi (22, 80, 443 ochiq)"

# ── 6. Fail2ban (brute force himoya) ─────────────────────────
log "6. Fail2ban yoqilmoqda..."
systemctl enable fail2ban
systemctl start fail2ban
success "Fail2ban yoqildi"

# ── 7. Loyiha papkalar ───────────────────────────────────────
log "7. Loyiha papkalari yaratilmoqda..."
mkdir -p /home/deploy/maternity-ward-backend
mkdir -p /home/deploy/maternity-ward-frontend
chown -R deploy:deploy /home/deploy/
success "Papkalar yaratildi"

# ── 8. SSL sertifikat olish ──────────────────────────────────
log "8. SSL sertifikat olinmoqda ($DOMAIN)..."
echo ""
echo "  ⚠️  Domain '$DOMAIN' bu VPS IP ga ko'rsatilganiga ishonch hosil qiling!"
echo "  DNS propagation uchun biroz vaqt kerak bo'lishi mumkin."
echo ""
read -p "  Davom etishga tayyormisiz? (y/n): " CONFIRM
if [[ "$CONFIRM" == "y" ]]; then
    certbot certonly --standalone \
        --non-interactive \
        --agree-tos \
        --email "admin@$DOMAIN" \
        -d "$DOMAIN" \
        -d "www.$DOMAIN" || warn "SSL olishda xato — keyinroq qayta urinib ko'ring"
    
    # Auto-renewal cron
    (crontab -l 2>/dev/null; echo "0 3 * * 1 certbot renew --quiet && docker restart maternity_nginx") | crontab -
    success "SSL sertifikat olindi va auto-renewal sozlandi"
fi

# ── 9. Nginx config ─────────────────────────────────────────
log "9. Nginx config domain bilan yangilanmoqda..."
# Bu keyinroq deploy.sh clonlangandan keyin qilinadi
echo "  (Keyinroq: sed -i 's/YOUR_DOMAIN.COM/$DOMAIN/g' nginx/nginx.conf)"

# ── 10. SSH key sozlash ──────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
success "VPS Setup tugadi!"
echo ""
echo "Keyingi qadamlar:"
echo ""
echo "  1. GitHub SSH key qo'shing:"
echo "     su - deploy"
echo "     ssh-keygen -t ed25519 -C 'deploy@maternity'"
echo "     cat ~/.ssh/id_ed25519.pub"
echo "     # Bu kalitni GitHub repo Settings → Deploy keys ga qo'shing"
echo ""
echo "  2. Repolarni clone qiling:"
echo "     su - deploy"
echo "     cd /home/deploy"
echo "     git clone git@github.com:odiljon1334/maternity-ward-backend.git"
echo "     git clone git@github.com:odiljon1334/maternity-ward-frontend.git"
echo ""
echo "  3. .env.prod yarating:"
echo "     cp maternity-ward-backend/.env.prod.example maternity-ward-backend/.env.prod"
echo "     nano maternity-ward-backend/.env.prod"
echo ""
echo "  4. Domain ni nginx configga qo'ying:"
echo "     sed -i 's/YOUR_DOMAIN.COM/$DOMAIN/g' maternity-ward-backend/nginx/nginx.conf"
echo ""
echo "  5. Deploy qiling:"
echo "     bash maternity-ward-backend/deploy.sh"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

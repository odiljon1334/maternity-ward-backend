#!/bin/bash
# ============================================================
# vps-setup.sh — Contabo VPS dastlabki sozlash (HTTP)
# ROOT sifatida BIR MARTA ishlatiladi:
#   scp vps-setup.sh root@VPS_IP:~/
#   ssh root@VPS_IP "bash vps-setup.sh"
# ============================================================

set -e

DEPLOY_USER="deploy"
RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log()     { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }

echo ""
echo "🏥 VPS Setup — Maternity Ward"
echo "IP: $(curl -s ifconfig.me)"
echo ""

# ── 1. Sistema yangilash ─────────────────────────────────────
log "1. Sistema yangilanmoqda..."
apt-get update -q && apt-get upgrade -y -q
apt-get install -y -q curl git ufw fail2ban dnsutils
success "Sistema yangilandi"

# ── 2. Deploy user ───────────────────────────────────────────
log "2. '$DEPLOY_USER' foydalanuvchi yaratilmoqda..."
if ! id "$DEPLOY_USER" &>/dev/null; then
    useradd -m -s /bin/bash "$DEPLOY_USER"
    usermod -aG sudo "$DEPLOY_USER"
fi
echo "$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker compose, /usr/local/bin/docker-compose" \
    > /etc/sudoers.d/deploy
success "'$DEPLOY_USER' tayyor"

# ── 3. Docker ────────────────────────────────────────────────
log "3. Docker o'rnatilmoqda..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$DEPLOY_USER"
success "Docker: $(docker --version)"

# ── 4. Firewall ──────────────────────────────────────────────
log "4. Firewall sozlanmoqda..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
success "Firewall: 22 (SSH), 80 (HTTP), 443 (HTTPS) ochiq"

# ── 5. Fail2ban ──────────────────────────────────────────────
log "5. Fail2ban yoqilmoqda..."
systemctl enable fail2ban && systemctl start fail2ban
success "Fail2ban yoqildi"

# ── 6. Papkalar ──────────────────────────────────────────────
log "6. Papkalar yaratilmoqda..."
mkdir -p /home/deploy/maternity-ward-backend
mkdir -p /home/deploy/maternity-ward-frontend
chown -R deploy:deploy /home/deploy/
success "Papkalar yaratildi"

# ── 7. Swap (agar RAM 2GB dan kam bo'lsa) ───────────────────
TOTAL_RAM=$(free -m | awk '/^Mem:/{print $2}')
if [ "$TOTAL_RAM" -lt 2048 ]; then
    log "7. Swap yaratilmoqda (RAM: ${TOTAL_RAM}MB)..."
    if [ ! -f /swapfile ]; then
        fallocate -l 2G /swapfile
        chmod 600 /swapfile
        mkswap /swapfile
        swapon /swapfile
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
        success "2GB Swap yaratildi"
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
success "VPS Setup tugadi!"
echo ""
echo "Keyingi qadamlar:"
echo ""
echo "  1. 'deploy' foydalanuvchiga o'ting:"
echo "     su - deploy"
echo ""
echo "  2. GitHub SSH key yarating:"
echo "     ssh-keygen -t ed25519 -C 'deploy@maternity'"
echo "     cat ~/.ssh/id_ed25519.pub"
echo "     # Kalitni GitHub → Settings → Deploy keys ga qo'shing"
echo ""
echo "  3. Repolarni clone qiling:"
echo "     git clone git@github.com:odiljon1334/maternity-ward-backend.git"
echo "     git clone git@github.com:odiljon1334/maternity-ward-frontend.git"
echo ""
echo "  4. .env.prod to'ldiring:"
echo "     cp maternity-ward-backend/.env.prod.example maternity-ward-backend/.env.prod"
echo "     nano maternity-ward-backend/.env.prod"
echo "     # POSTGRES_PASSWORD, JWT_SECRET, REDIS_PASSWORD ni to'ldiring"
echo "     # FRONTEND_URL=http://$(curl -s ifconfig.me)"
echo "     # NEXT_PUBLIC_API_URL=http://$(curl -s ifconfig.me)/api/v1"
echo ""
echo "  5. Deploy:"
echo "     bash maternity-ward-backend/deploy.sh"
echo ""
echo "  📌 Domain olgach SSL qo'shish:"
echo "     bash maternity-ward-backend/ssl-setup.sh YOUR_DOMAIN.COM"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

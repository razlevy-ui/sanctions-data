#!/usr/bin/env bash
###############################################################################
# Tectona BackOffice — Ubuntu 24.04 LTS Server Preparation
#
# Audience : Junior DevOps engineer running this manually over SSH.
# Scope    : Prepare a fresh Ubuntu 24.04 LTS host to run the Tectona stack
#            (React/Vite frontend, Node.js/Express backend on :5050, MariaDB)
#            using ONLY Docker Engine + Docker Compose v2.
#            Nginx and Node.js are NOT installed on the host — they live in
#            containers managed by docker-compose.
#
# How to use this file:
#   - Do NOT run it end-to-end as a single script the first time.
#   - Read each numbered section, run the commands, and verify the output
#     before moving to the next section.
#   - Any line marked `# >>> MANUAL INPUT REQUIRED <<<` needs you to paste
#     a real value (SSH key, IP, domain, password) before executing.
#
# Conventions:
#   - `sudo` is used explicitly. Run as a sudo-capable admin user, NOT root.
#   - All app files live under /opt/tectona, owned by the `tectona` user.
###############################################################################

set -euo pipefail

# -----------------------------------------------------------------------------
# 0. VARIABLES — edit these BEFORE you start.
# -----------------------------------------------------------------------------
# >>> MANUAL INPUT REQUIRED <<<
ADMIN_IP="203.0.113.10"          # Office / VPN public IP allowed to SSH in
APP_USER="tectona"               # Non-root user that will own /opt/tectona
APP_HOME="/opt/tectona"
SSH_PORT="22"                    # Keep 22 unless you have a reason to change
DOMAIN_NAME="backoffice.example.com"   # Public FQDN, used later by nginx/TLS
TIMEZONE="Europe/Madrid"         # Adjust to your locale

echo "[i] ADMIN_IP=$ADMIN_IP  APP_USER=$APP_USER  DOMAIN=$DOMAIN_NAME"


###############################################################################
# 1. SYSTEM UPDATE & BASELINE HARDENING
###############################################################################

# 1.1 Update package index and upgrade everything currently installed.
sudo apt-get update
sudo apt-get -y full-upgrade

# 1.2 Install baseline tooling we will need throughout the rest of the guide.
sudo apt-get install -y \
    ca-certificates curl gnupg lsb-release \
    ufw fail2ban unattended-upgrades apt-listchanges \
    chrony htop jq vim git

# 1.3 Set the timezone and enable NTP via chrony (TLS certs and logs need
#     accurate time).
sudo timedatectl set-timezone "$TIMEZONE"
sudo systemctl enable --now chrony

# 1.4 Configure unattended-upgrades to auto-apply security patches only.
#     (Feature upgrades stay manual to avoid surprise downtime.)
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

# 1.5 Harden SSH: disable password auth and root login. Key auth only.
#     >>> MANUAL INPUT REQUIRED <<<
#     BEFORE running this block, make sure your public key is already in
#     ~/.ssh/authorized_keys for the admin user you are SSH'd in as.
#     If you lock yourself out here, you will need console access.
sudo install -d -m 0755 /etc/ssh/sshd_config.d
sudo tee /etc/ssh/sshd_config.d/10-tectona-hardening.conf >/dev/null <<EOF
Port $SSH_PORT
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers $USER $APP_USER
EOF
sudo sshd -t                       # syntax-check before reload
sudo systemctl reload ssh

# 1.6 fail2ban — protect SSH from brute force.
sudo tee /etc/fail2ban/jail.local >/dev/null <<EOF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
port    = $SSH_PORT
EOF
sudo systemctl enable --now fail2ban
sudo systemctl restart fail2ban


###############################################################################
# 2. UFW FIREWALL — default deny, allow only what we need
###############################################################################

# 2.1 Sensible defaults.
sudo ufw default deny incoming
sudo ufw default allow outgoing

# 2.2 SSH is restricted to the admin IP only. Everything else is denied.
#     >>> MANUAL INPUT REQUIRED <<< — confirm $ADMIN_IP above is correct.
sudo ufw allow from "$ADMIN_IP" to any port "$SSH_PORT" proto tcp comment 'SSH admin only'

# 2.3 Public web traffic — nginx container will listen on 80/443.
sudo ufw allow 80/tcp  comment 'HTTP  (nginx container)'
sudo ufw allow 443/tcp comment 'HTTPS (nginx container)'

# 2.4 Backend (5050) and MariaDB (3306) MUST NOT be opened on the host.
#     They are reachable only over the internal Docker bridge network.
#     We deliberately do NOT add ufw rules for them.

# 2.5 Enable the firewall (will prompt y/n if interactive).
sudo ufw --force enable
sudo ufw status verbose


###############################################################################
# 3. DOCKER ENGINE + DOCKER COMPOSE v2 (official Docker apt repo, no snap)
###############################################################################

# 3.1 Remove any distro-shipped or snap docker remnants.
for pkg in docker.io docker-doc docker-compose docker-compose-v2 \
           podman-docker containerd runc; do
  sudo apt-get -y remove "$pkg" || true
done
sudo snap remove docker 2>/dev/null || true

# 3.2 Add Docker's official GPG key and apt repository.
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
     -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

# 3.3 Install Engine + CLI + buildx + Compose v2 plugin.
sudo apt-get update
sudo apt-get install -y \
    docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

# 3.4 Verify versions (Compose v2 is `docker compose`, NOT `docker-compose`).
docker --version
docker compose version

sudo systemctl enable --now docker


###############################################################################
# 4. DEDICATED NON-ROOT APP USER
###############################################################################

# 4.1 Create a system-style user that owns /opt/tectona and runs containers.
if ! id "$APP_USER" >/dev/null 2>&1; then
  sudo adduser --disabled-password --gecos "Tectona App" "$APP_USER"
fi

# 4.2 Add to the docker group so it can talk to the daemon socket.
#     NOTE: docker group membership == root on the host. Only the app user
#     gets it; humans should use `sudo docker ...` instead.
sudo usermod -aG docker "$APP_USER"

# 4.3 Set up SSH for the app user (used by CI/CD to deploy).
#     >>> MANUAL INPUT REQUIRED <<<
#     Replace the placeholder line below with your real deploy public key.
sudo -u "$APP_USER" mkdir -p "/home/$APP_USER/.ssh"
sudo -u "$APP_USER" tee "/home/$APP_USER/.ssh/authorized_keys" >/dev/null <<'EOF'
# ssh-ed25519 AAAA...REPLACE_ME... deploy@tectona
EOF
sudo chmod 700 "/home/$APP_USER/.ssh"
sudo chmod 600 "/home/$APP_USER/.ssh/authorized_keys"


###############################################################################
# 5. DIRECTORY STRUCTURE UNDER /opt/tectona
###############################################################################
# Layout:
#   /opt/tectona/
#     ├── frontend/          # built static assets / Dockerfile context
#     ├── backend/           # Node.js/Express service (port 5050 inside net)
#     ├── mariadb/           # data volume + init SQL (NOT exposed on host)
#     ├── nginx/             # reverse-proxy config + TLS certs
#     └── docker-compose.yml # single source of truth for the stack

sudo install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_HOME"
sudo -u "$APP_USER" mkdir -p \
    "$APP_HOME/frontend" \
    "$APP_HOME/backend" \
    "$APP_HOME/mariadb/data" \
    "$APP_HOME/mariadb/initdb" \
    "$APP_HOME/nginx/conf.d" \
    "$APP_HOME/nginx/certs" \
    "$APP_HOME/logs"

# MariaDB data dir must be tight — only the app user reads it.
sudo chmod 700 "$APP_HOME/mariadb/data"

# Drop a placeholder compose file so the engineer can `git pull` over it
# or scp the real one in. The deploy step replaces this.
sudo -u "$APP_USER" tee "$APP_HOME/docker-compose.yml" >/dev/null <<'EOF'
# Placeholder — replaced at deploy time by the real compose definition.
# Expected services: frontend, backend (5050), mariadb, nginx (80/443).
# Expected network : tectona_net (internal bridge).
services: {}
EOF


###############################################################################
# 6. DOCKER NETWORK — internal bridge, DB never exposed to host
###############################################################################

# 6.1 Create a user-defined bridge so containers resolve each other by name
#     and the DB port stays unreachable from the host / public internet.
#     The real docker-compose.yml should reference this as an `external`
#     network (see snippet below) so we don't have to recreate it on every
#     `compose up`.
sudo -u "$APP_USER" docker network inspect tectona_net >/dev/null 2>&1 \
  || sudo -u "$APP_USER" docker network create \
       --driver bridge \
       --subnet 172.28.0.0/16 \
       tectona_net

# 6.2 Reminder for the compose file (informational — do NOT execute):
#
#   networks:
#     tectona_net:
#       external: true
#
#   services:
#     mariadb:
#       image: mariadb:11
#       networks: [tectona_net]
#       # NO `ports:` block here. Backend reaches it as mariadb:3306
#       # over tectona_net only.
#     backend:
#       networks: [tectona_net]
#       expose: ["5050"]      # internal only, nginx proxies to it
#     nginx:
#       networks: [tectona_net]
#       ports:
#         - "80:80"
#         - "443:443"


###############################################################################
# 7. ENVIRONMENT FILES — placement & permissions
###############################################################################

# 7.1 Each service has its own .env, owned by the app user, mode 0600.
#     The compose file references them via `env_file:` — they are NEVER
#     committed to git and NEVER world-readable.
#
#     >>> MANUAL INPUT REQUIRED <<<
#     Fill in real secrets before saving (DB password, JWT secret, etc.).

sudo -u "$APP_USER" tee "$APP_HOME/backend/.env" >/dev/null <<'EOF'
NODE_ENV=production
PORT=5050
DB_HOST=mariadb
DB_PORT=3306
DB_NAME=tectona
DB_USER=tectona_app
DB_PASSWORD=CHANGE_ME
JWT_SECRET=CHANGE_ME
EOF

sudo -u "$APP_USER" tee "$APP_HOME/mariadb/.env" >/dev/null <<'EOF'
MARIADB_ROOT_PASSWORD=CHANGE_ME_ROOT
MARIADB_DATABASE=tectona
MARIADB_USER=tectona_app
MARIADB_PASSWORD=CHANGE_ME
EOF

sudo -u "$APP_USER" tee "$APP_HOME/frontend/.env" >/dev/null <<EOF
VITE_API_BASE_URL=https://$DOMAIN_NAME/api
EOF

# 7.2 Lock down permissions. 0600 = owner read/write only.
sudo chmod 600 "$APP_HOME/backend/.env" \
               "$APP_HOME/mariadb/.env" \
               "$APP_HOME/frontend/.env"
sudo chown "$APP_USER:$APP_USER" \
           "$APP_HOME/backend/.env" \
           "$APP_HOME/mariadb/.env" \
           "$APP_HOME/frontend/.env"


###############################################################################
# 8. DOCKER LOG ROTATION
###############################################################################

# Without this, a chatty container can fill the disk and take the host down.
# Caps each container at 3 x 10 MB log files (json-file driver).
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "live-restore": true
}
EOF

sudo systemctl restart docker

# Belt and braces: rotate any other on-disk logs under /opt/tectona/logs.
sudo tee /etc/logrotate.d/tectona >/dev/null <<EOF
$APP_HOME/logs/*.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su $APP_USER $APP_USER
}
EOF


###############################################################################
# 9. PRE-DEPLOY HEALTH CHECK
###############################################################################
# Run this AS THE LAST STEP, before handing the server off to the deploy
# pipeline. Every line should print OK / a sane value. If any line errors,
# stop and fix it before deploying the app.

echo "===== Tectona host readiness ====="

# 9.1 OS + kernel
lsb_release -ds && uname -r

# 9.2 Time sync
timedatectl | grep -E 'Time zone|System clock synchronized|NTP service'

# 9.3 Firewall
sudo ufw status verbose | grep -E 'Status:|22/tcp|80/tcp|443/tcp'

# 9.4 SSH hardening
sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|port) '

# 9.5 fail2ban
sudo systemctl is-active fail2ban
sudo fail2ban-client status sshd | grep -E 'Currently banned|Total banned' || true

# 9.6 Docker engine + compose
docker --version
docker compose version
sudo systemctl is-active docker

# 9.7 App user can talk to docker without sudo
sudo -u "$APP_USER" docker info >/dev/null && echo "docker socket OK as $APP_USER"

# 9.8 Network exists and is internal-only (no host port bindings)
sudo -u "$APP_USER" docker network inspect tectona_net \
    --format '{{.Name}} driver={{.Driver}} subnet={{(index .IPAM.Config 0).Subnet}}'

# 9.9 Directory tree + permissions
sudo find "$APP_HOME" -maxdepth 2 -printf '%M %u:%g  %p\n'

# 9.10 Critical .env files exist and are 0600
for f in "$APP_HOME/backend/.env" "$APP_HOME/mariadb/.env" "$APP_HOME/frontend/.env"; do
  perms=$(stat -c '%a %U:%G' "$f")
  echo "$f -> $perms"
  [[ "$perms" == "600 $APP_USER:$APP_USER" ]] || { echo "FAIL: $f perms wrong"; exit 1; }
done

# 9.11 Log rotation config is valid
sudo logrotate -d /etc/logrotate.d/tectona >/dev/null && echo "logrotate config OK"

# 9.12 Confirm 5050 and 3306 are NOT listening on the host (must be empty)
ss -tlnp | grep -E ':(5050|3306)\s' && { echo "FAIL: DB or backend port exposed on host"; exit 1; } \
                                    || echo "ports 5050/3306 not exposed on host  OK"

echo "===== Host ready. Safe to deploy the Tectona stack. ====="

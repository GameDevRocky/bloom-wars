#!/bin/bash
# Bloom EC2 bootstrap. Runs once, on first boot, via cloud-init.
# Output lands in /var/log/cloud-init-output.log.
# Placeholders below are substituted by infra/deploy-ec2.ps1 before launch.
set -euxo pipefail

HOSTNAME_FQDN="__BLOOM_HOSTNAME__"
EXPECTED_IP="__BLOOM_EXPECTED_IP__"
REPO_URL="__BLOOM_REPO_URL__"
APP_DIR=/opt/bloom
APP_PORT=8080

dnf install -y nodejs22 nodejs22-npm git tar

NODE_BIN="$(command -v node)"
test -n "$NODE_BIN"
"$NODE_BIN" --version

# 1 GB RAM is tight for Node under load; swap is a cheap safety net.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

id bloom >/dev/null 2>&1 || useradd --system --create-home --shell /sbin/nologin bloom

rm -rf "$APP_DIR"
git clone --depth 1 "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"
# Production deps only. Never run `npm run build` here: that is Vercel's job and
# would overwrite public/config.js with an empty server URL.
npm ci --omit=dev
chown -R bloom:bloom "$APP_DIR"

cat > /etc/systemd/system/bloom.service <<UNIT
[Unit]
Description=Bloom game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bloom
Group=bloom
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
ExecStart=$NODE_BIN server/server.js
Restart=always
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

# Caddy terminates TLS and reverse-proxies to the Node server. Installed as a
# static binary: the official COPR repo has no Amazon Linux 2023 build.
if [ ! -x /usr/local/bin/caddy ]; then
  if ! curl -fsSL -o /usr/local/bin/caddy "https://caddyserver.com/api/download?os=linux&arch=amd64"; then
    CADDY_TAG="$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest | grep '"tag_name"' | head -1 | cut -d'"' -f4)"
    CADDY_VERSION="${CADDY_TAG#v}"
    curl -fsSL -o /tmp/caddy.tar.gz "https://github.com/caddyserver/caddy/releases/download/${CADDY_TAG}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
    tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy
  fi
  chmod 755 /usr/local/bin/caddy
fi
/usr/local/bin/caddy version

id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy

mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<CADDYFILE
{
	admin off
}

$HOSTNAME_FQDN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$APP_PORT
}
CADDYFILE
chown -R caddy:caddy /etc/caddy

cat > /etc/systemd/system/caddy.service <<UNIT
[Unit]
Description=Caddy reverse proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
PrivateTmp=true
ProtectSystem=full
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now bloom.service

# The Elastic IP is associated after RunInstances returns, so this instance may
# still be on its launch-time address. Starting Caddy before the association
# lands means Let's Encrypt validates against the wrong host, fails, and eats
# the 5-failures-per-hour budget for this name. Wait for the address to match.
TOKEN="$(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 600')"
for _ in $(seq 1 60); do
  CURRENT_IP="$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
  [ "$CURRENT_IP" = "$EXPECTED_IP" ] && break
  sleep 5
done
test "$CURRENT_IP" = "$EXPECTED_IP"

systemctl enable --now caddy.service
echo "Bloom bootstrap complete for https://$HOSTNAME_FQDN"

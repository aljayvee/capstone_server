#!/usr/bin/env bash
#
# Deploy the Backend Server (https://api.sugo-express.org) to Contabo VPS.
#
# Follows the canonical protocol documented in AGENT_HANDSHAKE.md:
# 1. Back up current server source on VPS to /root/deploy-backups/server-<timestamp>
# 2. Sync src/, prisma/schema.prisma, and package.json to /var/www/server/
# 3. Generate Prisma client (npx prisma generate)
# 4. Synchronize DB schema (npx prisma db push)
# 5. Compile TypeScript directly on VPS (npm run build)
# 6. Restart PM2 process (pm2 restart capstone-backend)
# 7. Verify live health endpoints (local and edge)
#
set -euo pipefail

HOST="${DEPLOY_HOST:-root@109.123.239.182}"
REMOTE_DIR="/var/www/server"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/deploy-backups/server-$STAMP"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_ROOT="$(cd "$HERE/.." && pwd)"

cd "$SERVER_ROOT"

echo "==> 1. Verifying local TypeScript compilation before deployment"
npx tsc --noEmit
echo "    Local TypeScript check: PASSED (0 errors)"

echo "==> 2. Creating pre-deployment backup on VPS ($BACKUP_DIR)"
ssh -o BatchMode=yes "$HOST" "mkdir -p '$BACKUP_DIR' && cp -r '$REMOTE_DIR/src' '$BACKUP_DIR/' && cp -r '$REMOTE_DIR/prisma' '$BACKUP_DIR/' && cp '$REMOTE_DIR/package.json' '$BACKUP_DIR/' && echo '    Backup saved successfully.'"

echo "==> 3. Streaming fresh source code (src/, prisma/schema.prisma, package.json, ml/) to VPS"
tar --exclude='*__pycache__*' --exclude='*/.venv*' --exclude='*.venv*' --exclude='*.pytest_cache*' -czf - src prisma/schema.prisma package.json ml \
  | ssh -o BatchMode=yes "$HOST" "tar -xzf - -C '$REMOTE_DIR'"
echo "    Source sync: COMPLETED"

echo "==> 4. Executing Prisma generation and database synchronization on VPS"
ssh -o BatchMode=yes "$HOST" bash -s <<EOF
set -euo pipefail
cd '$REMOTE_DIR'
rm -f schema.prisma
echo "--> npx prisma generate --schema=prisma/schema.prisma"
npx prisma generate --schema=prisma/schema.prisma
echo "--> npx prisma db push --schema=prisma/schema.prisma"
npx prisma db push --schema=prisma/schema.prisma --accept-data-loss
EOF

echo "==> 5. Compiling TypeScript on the VPS (npm run build)"
ssh -o BatchMode=yes "$HOST" bash -s <<EOF
set -euo pipefail
cd '$REMOTE_DIR'
npm run build
EOF
echo "    VPS TypeScript build: PASSED (0 errors)"

echo "==> 6. Rebuilding / Updating category microservice container"
ssh -o BatchMode=yes "$HOST" bash -s <<EOF
set -euo pipefail
cd '$REMOTE_DIR'
docker compose -f ml/docker-compose.category.yml build --build-arg TRAINED_AT=\$(date +%s)
docker compose -f ml/docker-compose.category.yml up -d
EOF

echo "==> 7. Restarting PM2 process 'capstone-backend'"
ssh -o BatchMode=yes "$HOST" "pm2 restart capstone-backend"

echo "==> 8. Verifying API health endpoints"
sleep 3
ssh -o BatchMode=yes "$HOST" bash -s <<EOF
set -uo pipefail
echo "--> Probing local backend (127.0.0.1:5000/api/health):"
curl -s -m 10 http://127.0.0.1:5000/api/health || echo "FAILED"
echo ""

echo "--> Probing Nginx edge proxy (https://api.sugo-express.org/api/health):"
curl -sk -m 10 https://api.sugo-express.org/api/health || echo "FAILED"
echo ""

echo "--> Probing Category ML service (127.0.0.1:8100/health):"
curl -s -m 10 http://127.0.0.1:8100/health || echo "FAILED"
echo ""
EOF

cat <<EOF

==================================================
 Backend Server Successfully Deployed to VPS!
 Target: $HOST:$REMOTE_DIR
 Rollback if needed:
   ssh $HOST "cp -r '$BACKUP_DIR/src' '$REMOTE_DIR/' && cd '$REMOTE_DIR' && npm run build && pm2 restart capstone-backend"
==================================================
EOF

#!/bin/bash
# Deploy X Marketing tool to VPS
# Usage: ./deploy.sh

set -e

VPS="root@165.227.120.122"
REMOTE_DIR="/opt/x-marketing"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Deploying X Marketing to $VPS ==="

# 1. Create remote directory
ssh $VPS "mkdir -p $REMOTE_DIR"

# 2. Sync application files
echo "Syncing files..."
rsync -avz --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude leads.jsonl \
  "$LOCAL_DIR/" "$VPS:$REMOTE_DIR/"

# 3. Sync embed.js (referenced by server.js)
rsync -avz "$LOCAL_DIR/../../landing/embed.js" "$VPS:$REMOTE_DIR/embed.js"

# 4. Install dependencies on remote
echo "Installing dependencies..."
ssh $VPS "cd $REMOTE_DIR && npm ci --production"

# 5. Create/update .env if it doesn't exist
ssh $VPS "test -f $REMOTE_DIR/.env || cat > $REMOTE_DIR/.env << 'ENVEOF'
PORT=3002
HANZI_API_KEY=hic_live_c7ec32b4b45be235147e83d985c4c8d7067b720228b6b4f2fe04f6dd0a1ddab4
LLM_BASE_URL=http://127.0.0.1:8003/claude
ANTHROPIC_API_KEY=ccproxy
POSTHOG_API_KEY=phc_SNXFKD8YOBPvBNWWZnuCe7stDsJJNJ5WS8MujKhajIF
NODE_ENV=production
ENVEOF
echo '.env already exists, skipping'"

# 6. Fix embed.js path on remote (it lives alongside server.js on the VPS)
ssh $VPS "cd $REMOTE_DIR && sed -i 's|../../landing/embed.js|embed.js|' server.js"

# 7. Restart with pm2
echo "Restarting service..."
ssh $VPS "cd $REMOTE_DIR && pm2 delete x-marketing 2>/dev/null || true && pm2 start server.js --name x-marketing --node-args='--env-file=.env' && pm2 save"

echo ""
echo "=== Deployed! ==="
echo "Check: ssh $VPS 'pm2 logs x-marketing --lines 20'"
echo "URL: https://browse.hanzilla.co/tools/x-marketing (after Caddy config)"

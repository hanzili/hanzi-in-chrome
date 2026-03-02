#!/bin/bash

# OAuth Native Messaging Host Uninstall Script

set -e

echo "=== Hanzi in Chrome - OAuth Native Host Uninstaller ==="
echo ""

# Determine OS and remove manifest
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    MANIFEST_PATH="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.hanzi_in_chrome.oauth_host.json"

elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    # Linux
    MANIFEST_PATH="$HOME/.config/google-chrome/NativeMessagingHosts/com.hanzi_in_chrome.oauth_host.json"

else
    echo "⚠️  Unsupported OS: $OSTYPE"
    echo "Please manually remove the manifest from your system."
    exit 1
fi

if [ -f "$MANIFEST_PATH" ]; then
    rm "$MANIFEST_PATH"
    echo "✓ Removed: $MANIFEST_PATH"
else
    echo "⚠️  Manifest not found at: $MANIFEST_PATH"
fi

echo ""
echo "=== Uninstall Complete! ==="

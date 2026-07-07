#!/usr/bin/env bash
set -euo pipefail

# Script de rollback pour une application individuelle
# Usage: rollback-app.sh <snapshot_path> <destination_path>

SNAPSHOT_PATH="${1:-}"
APP_PATH="${2:-}"

if [[ -z "$SNAPSHOT_PATH" ]] || [[ -z "$APP_PATH" ]]; then
  echo "❌ Usage: $(basename "$0") <snapshot_path> <destination_path>"
  echo "   Exemple: $(basename "$0") /data/snapshot/immich-2024-11-26-101530 /data/apps/immich"
  exit 1
fi

if [[ ! -d "$SNAPSHOT_PATH" ]]; then
  echo "❌ Snapshot introuvable: $SNAPSHOT_PATH"
  exit 1
fi

# Vérifier que c'est bien un subvolume btrfs
if ! btrfs subvolume show "$SNAPSHOT_PATH" &>/dev/null; then
  echo "❌ $SNAPSHOT_PATH n'est pas un subvolume btrfs"
  exit 1
fi

APP_ID=$(basename "$APP_PATH")

echo "📦 Rollback de l'app: $APP_ID"
echo "   Snapshot: $SNAPSHOT_PATH"
echo "   Destination: $APP_PATH"

# Arrêter les containers de l'app
echo "🛑 Arrêt des containers de $APP_ID..."
if command -v docker >/dev/null 2>&1; then
  cd "$APP_PATH" 2>/dev/null || true
  if [[ -f "docker-compose.yml" ]]; then
    docker compose down -v 2>/dev/null || true
  fi
fi

# Supprimer l'état courant
if [[ -e "$APP_PATH" ]]; then
  echo "🧹 Suppression de l'état actuel: $APP_PATH"
  if btrfs subvolume show "$APP_PATH" &>/dev/null; then
    btrfs subvolume delete "$APP_PATH"
  else
    rm -rf "$APP_PATH"
  fi
fi

# Restaurer depuis le snapshot
echo "♻️  Restauration depuis le snapshot..."
btrfs subvolume snapshot "$SNAPSHOT_PATH" "$APP_PATH"

# Redémarrer les containers
echo "▶️  Redémarrage des containers de $APP_ID..."
if [[ -f "$APP_PATH/docker-compose.yml" ]]; then
  cd "$APP_PATH"
  docker compose up -d 2>/dev/null || true
fi

echo "✅ Rollback terminé pour $APP_ID"
echo "💡 Pour supprimer le snapshot après vérification:"
echo "   sudo btrfs subvolume delete $SNAPSHOT_PATH"

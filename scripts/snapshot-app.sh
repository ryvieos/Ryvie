#!/usr/bin/env bash
set -euo pipefail

# ---- Usage -----------------------------------------------------------------
if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <app-id>"
  echo "Crée un snapshot RO du dossier d'une app spécifique dans /data/apps/<app-id>"
  exit 1
fi

APP_ID="$1"

# ---- Pré-requis ------------------------------------------------------------
DATA_ROOT="/data"
APPS_ROOT="$DATA_ROOT/apps"
APP_PATH="$APPS_ROOT/$APP_ID"
SNAP_ROOT="$DATA_ROOT/snapshot/apps"

# Vérifier que Btrfs est utilisé
if [[ "$(findmnt -no FSTYPE "$DATA_ROOT" | head -1)" != "btrfs" ]]; then
  echo "❌ $DATA_ROOT n'est pas en Btrfs."
  exit 1
fi

# Vérifier que l'app existe
if [[ ! -d "$APP_PATH" ]]; then
  echo "ℹ️  L'app $APP_ID n'existe pas encore dans $APPS_ROOT (installation initiale)"
  echo "SNAPSHOT_PATH=none"
  exit 0
fi

# Vérifier que c'est un sous-volume Btrfs
if ! sudo btrfs subvolume show "$APP_PATH" &>/dev/null; then
  echo "⚠️  $APP_PATH n'est pas un sous-volume Btrfs, snapshot impossible"
  echo "SNAPSHOT_PATH=none"
  exit 0
fi

# S'assurer que le dossier de snapshots existe
sudo mkdir -p "$SNAP_ROOT"

# Créer le nom du snapshot avec timestamp
TS="$(date +%F-%H%M%S)"
SNAP_PATH="$SNAP_ROOT/${APP_ID}-${TS}"

echo "📸 Création du snapshot pour l'app: $APP_ID"
echo "   Source: $APP_PATH"
echo "   Destination: $SNAP_PATH"

# ---- Pause du container de l'app (cohérence) -------------------------------
CONTAINER_PAUSED=0
CONTAINER_NAME="app-${APP_ID}"

if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "⏸️  Pause du container: $CONTAINER_NAME"
    docker pause "$CONTAINER_NAME" 2>/dev/null || true
    CONTAINER_PAUSED=1
  fi
fi

# En cas d'erreur, reprendre le container
cleanup() {
  if [[ $CONTAINER_PAUSED -eq 1 ]]; then
    echo "▶️  Reprise du container: $CONTAINER_NAME"
    docker unpause "$CONTAINER_NAME" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "💾 sync disque..."
sync

# ---- Créer le snapshot RO --------------------------------------------------
sudo btrfs subvolume snapshot -r "$APP_PATH" "$SNAP_PATH"

trap - EXIT

echo "✅ Snapshot créé: $SNAP_PATH"
echo "SNAPSHOT_PATH=$SNAP_PATH

#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# snapshot-app.sh — gestion des sous-volumes et snapshots Btrfs d'UNE app.
#
# Ce script centralise TOUTES les opérations Btrfs par-app : le backend
# (Ryvie-Back) ne doit jamais appeler `btrfs` directement, il passe par ici.
#
# Sous-commandes :
#   snapshot-app.sh <app-id>                     (défaut) crée un snapshot RO
#   snapshot-app.sh snapshot <app-id>            idem, forme explicite
#   snapshot-app.sh create-subvolume <app-id>    crée /data/apps/<app-id> (sous-volume)
#   snapshot-app.sh latest <app-id>              affiche SNAPSHOT_PATH du dernier snapshot
#   snapshot-app.sh delete <snapshot-path>       supprime un snapshot d'app (sécurisé)
#
# Contrat de sortie (parsé par le backend) : `SNAPSHOT_PATH=<chemin|none>`.
# ============================================================================

DATA_ROOT="/data"
APPS_ROOT="$DATA_ROOT/apps"
SNAP_ROOT="$DATA_ROOT/snapshot/apps"
APP_OWNER="${RYVIE_USER:-ryvie}"

require_btrfs() {
  if [[ "$(findmnt -no FSTYPE "$DATA_ROOT" | head -1)" != "btrfs" ]]; then
    echo "❌ $DATA_ROOT n'est pas en Btrfs."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# create-subvolume <app-id> : crée le dossier de l'app comme sous-volume Btrfs
# (remplace le `btrfs subvolume create` qui était dans appStoreService.ts).
# Idempotent : si le dossier/sous-volume existe déjà, corrige juste le owner.
# ---------------------------------------------------------------------------
cmd_create_subvolume() {
  local app_id="$1"
  [[ -n "$app_id" ]] || { echo "❌ Usage: $(basename "$0") create-subvolume <app-id>"; exit 1; }
  require_btrfs
  local app_path="$APPS_ROOT/$app_id"

  sudo mkdir -p "$APPS_ROOT"
  if [[ -e "$app_path" ]]; then
    echo "ℹ️  $app_path existe déjà"
  else
    echo "📦 Création du sous-volume Btrfs: $app_path"
    sudo btrfs subvolume create "$app_path"
  fi
  sudo chown "$APP_OWNER:$APP_OWNER" "$app_path"
  echo "✅ Sous-volume prêt: $app_path"
}

# ---------------------------------------------------------------------------
# latest <app-id> : imprime le chemin du snapshot le plus récent de l'app,
# ou SNAPSHOT_PATH=none. Remplace le glob `ls -t /data/snapshots/<id>-*`
# (qui pointait sur le MAUVAIS dossier — bug historique).
# ---------------------------------------------------------------------------
cmd_latest() {
  local app_id="$1"
  [[ -n "$app_id" ]] || { echo "❌ Usage: $(basename "$0") latest <app-id>"; exit 1; }
  local newest=""
  if [[ -d "$SNAP_ROOT" ]]; then
    newest=$(find "$SNAP_ROOT" -mindepth 1 -maxdepth 1 -type d -name "${app_id}-*" -printf '%f\n' 2>/dev/null | sort | tail -1 || true)
  fi
  if [[ -n "$newest" ]]; then
    echo "SNAPSHOT_PATH=$SNAP_ROOT/$newest"
  else
    echo "SNAPSHOT_PATH=none"
  fi
}

# ---------------------------------------------------------------------------
# delete <snapshot-path> : supprime un snapshot d'app.
# Garde-fou : le chemin DOIT être sous /data/snapshot/apps et être un
# sous-volume, pour éviter toute suppression accidentelle d'un dossier réel.
# ---------------------------------------------------------------------------
cmd_delete() {
  local snap_path="$1"
  [[ -n "$snap_path" ]] || { echo "❌ Usage: $(basename "$0") delete <snapshot-path>"; exit 1; }

  # Normaliser et vérifier le préfixe (anti path-traversal)
  case "$snap_path" in
    "$SNAP_ROOT"/*) : ;;
    *) echo "❌ Refus: $snap_path n'est pas sous $SNAP_ROOT"; exit 1 ;;
  esac
  if [[ "$snap_path" == *".."* ]]; then
    echo "❌ Refus: chemin invalide ($snap_path)"; exit 1
  fi
  if [[ ! -e "$snap_path" ]]; then
    echo "ℹ️  Déjà supprimé: $snap_path"; exit 0
  fi
  if ! sudo btrfs subvolume show "$snap_path" &>/dev/null; then
    echo "❌ $snap_path n'est pas un sous-volume Btrfs"; exit 1
  fi
  echo "🗑️  Suppression du snapshot: $snap_path"
  sudo btrfs subvolume delete "$snap_path"
  echo "✅ Snapshot supprimé"
}

# ---------------------------------------------------------------------------
# snapshot <app-id> (défaut) : crée un snapshot RO cohérent du dossier de l'app.
# ---------------------------------------------------------------------------
cmd_snapshot() {
  local app_id="$1"
  [[ -n "$app_id" ]] || { echo "❌ Usage: $(basename "$0") snapshot <app-id>"; exit 1; }
  require_btrfs
  local app_path="$APPS_ROOT/$app_id"

  if [[ ! -d "$app_path" ]]; then
    echo "ℹ️  L'app $app_id n'existe pas encore dans $APPS_ROOT (installation initiale)"
    echo "SNAPSHOT_PATH=none"
    exit 0
  fi
  if ! sudo btrfs subvolume show "$app_path" &>/dev/null; then
    echo "⚠️  $app_path n'est pas un sous-volume Btrfs, snapshot impossible"
    echo "SNAPSHOT_PATH=none"
    exit 0
  fi

  sudo mkdir -p "$SNAP_ROOT"
  local ts snap_path
  ts="$(date +%F-%H%M%S)"
  snap_path="$SNAP_ROOT/${app_id}-${ts}"

  echo "📸 Création du snapshot pour l'app: $app_id"
  echo "   Source: $app_path"
  echo "   Destination: $snap_path"

  # Pause du container pour la cohérence (reprise garantie via trap)
  local container_paused=0
  local container_name="app-${app_id}"
  if command -v docker >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
      echo "⏸️  Pause du container: $container_name"
      docker pause "$container_name" 2>/dev/null || true
      container_paused=1
    fi
  fi
  # shellcheck disable=SC2317  # appelée via trap
  resume() {
    if [[ $container_paused -eq 1 ]]; then
      echo "▶️  Reprise du container: $container_name"
      docker unpause "$container_name" 2>/dev/null || true
    fi
  }
  trap resume EXIT

  echo "💾 sync disque..."
  sync
  sudo btrfs subvolume snapshot -r "$app_path" "$snap_path"

  trap - EXIT
  resume

  echo "✅ Snapshot créé: $snap_path"
  echo "SNAPSHOT_PATH=$snap_path"
}

# ---- Dispatch --------------------------------------------------------------
if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") {<app-id>|snapshot <app-id>|create-subvolume <app-id>|latest <app-id>|delete <snapshot-path>}"
  exit 1
fi

case "$1" in
  create-subvolume) shift; cmd_create_subvolume "${1:-}" ;;
  latest)           shift; cmd_latest "${1:-}" ;;
  delete)           shift; cmd_delete "${1:-}" ;;
  snapshot)         shift; cmd_snapshot "${1:-}" ;;
  *)                cmd_snapshot "$1" ;;   # forme héritée : snapshot-app.sh <app-id>
esac

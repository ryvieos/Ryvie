#!/usr/bin/env bash
set -euo pipefail

# ---- Options ---------------------------------------------------------------
KEEP=""   # ex: --keep 5  => garder 5 sets de snapshots
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      KEEP="${2:-}"; shift 2 || true
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--keep N]"
      echo "Crée un set de snapshots RO pour tous les sous-volumes directs de /data (hors 'snapshot')."
      echo "Optionnel: --keep N  -> ne garder que les N derniers sets."
      exit 0
      ;;
    *)
      echo "Option inconnue: $1"; exit 1 ;;
  esac
done

# ---- Pré-requis ------------------------------------------------------------
DATA_ROOT="/data"
SNAP_ROOT="$DATA_ROOT/snapshot"

if [[ "$(findmnt -no FSTYPE "$DATA_ROOT")" != "btrfs" ]]; then
  echo "❌ $DATA_ROOT n'est pas en Btrfs."
  exit 1
fi

# s'assurer que /data/snapshot est un sous-volume (exclu automatiquement des snapshots)
if ! sudo btrfs subvolume show "$SNAP_ROOT" &>/dev/null; then
  echo "📦 Création du sous-volume de snapshots: $SNAP_ROOT"
  # si un dossier existe déjà, on le migre proprement
  if [[ -d "$SNAP_ROOT" ]]; then
    TMP="${SNAP_ROOT}.old.$$"
    sudo mv "$SNAP_ROOT" "$TMP"
    sudo btrfs subvolume create "$SNAP_ROOT"
    sudo cp -a --reflink=always "$TMP"/. "$SNAP_ROOT"/ || true
    sudo rm -rf "$TMP"
  else
    sudo btrfs subvolume create "$SNAP_ROOT"
  fi
fi

TS="$(date +%F-%H%M%S)"
SET_DIR="$SNAP_ROOT/$TS"
sudo mkdir -p "$SET_DIR"

echo "📁 Set de snapshots : $SET_DIR"

# ---- Pause Docker (cohérence applicative) ----------------------------------
DOCKER_ACTIVE=0
if command -v docker >/dev/null 2>&1 && { systemctl is-active --quiet docker || docker info >/dev/null 2>&1; }; then
  DOCKER_ACTIVE=1
  echo "📦 Pause des conteneurs Docker..."
  while read -r cid; do
    [[ -n "$cid" ]] && docker pause "$cid" || true
  done < <(docker ps -q)
fi

# En cas d'erreur, s'assurer qu'on "unpause"
cleanup() {
  if [[ $DOCKER_ACTIVE -eq 1 ]]; then
    echo "▶️  Reprise des conteneurs Docker (cleanup)..."
    while read -r cid; do
      [[ -n "$cid" ]] && docker unpause "$cid" || true
    done < <(docker ps -q --filter "status=paused")
  fi
}
trap cleanup EXIT

echo "💾 sync disque..."
sync

# ---- Lister les sous-volumes DIRECTS de /data (exclure 'snapshot') ----------
# btrfs subvolume list -o /data => ne liste que les subvolumes dont le parent est /data
mapfile -t SUBVOLS < <(btrfs subvolume list -o "$DATA_ROOT" | awk '{print $NF}' | sed 's|^/||' )

if [[ ${#SUBVOLS[@]} -eq 0 ]]; then
  echo "ℹ️ Aucun sous-volume direct détecté sous /data."
fi

echo "📸 Création des snapshots (RO) :"
for relpath in "${SUBVOLS[@]}"; do
  name="$(basename "$relpath")"
  # ignorer le sous-volume de snapshots lui-même
  [[ "$name" == "snapshot" ]] && continue

  SRC="$DATA_ROOT/$name"
  DST="$SET_DIR/$name"

  if sudo btrfs subvolume show "$SRC" &>/dev/null; then
    echo "  • $name"
    sudo btrfs subvolume snapshot -r "$SRC" "$DST"
  else
    echo "  • $name : ignoré (pas un sous-volume)"
  fi
done

# ---- Backup du code Ryvie (/opt/Ryvie) -------------------------------------
echo "💾 Sauvegarde du code Ryvie..."
RYVIE_DIR="/opt/Ryvie"
RYVIE_BACKUP="$SET_DIR/ryvie-code.tar.gz"

if [[ -d "$RYVIE_DIR" ]]; then
  echo "  • Création de l'archive du code Ryvie"
  # Exclure les dossiers volumineux et temporaires
  sudo tar -czf "$RYVIE_BACKUP" \
    --exclude="$RYVIE_DIR/node_modules" \
    --exclude="$RYVIE_DIR/.git" \
    --exclude="$RYVIE_DIR/data" \
    --exclude="$RYVIE_DIR/.update-staging" \
    --exclude="$RYVIE_DIR/Ryvie-Back/node_modules" \
    --exclude="$RYVIE_DIR/Ryvie-Back/dist" \
    --exclude="$RYVIE_DIR/Ryvie-Front/node_modules" \
    --exclude="$RYVIE_DIR/Ryvie-Front/dist" \
    -C "$(dirname "$RYVIE_DIR")" "$(basename "$RYVIE_DIR")"
  
  # Sauvegarder aussi la version actuelle
  if [[ -f "$RYVIE_DIR/package.json" ]]; then
    CURRENT_VERSION=$(grep -oP '"version":\s*"\K[^"]+' "$RYVIE_DIR/package.json" 2>/dev/null || echo "unknown")
    echo "$CURRENT_VERSION" | sudo tee "$SET_DIR/ryvie-version.txt" >/dev/null
    echo "  • Version sauvegardée: $CURRENT_VERSION"
  fi
  
  echo "  ✅ Code Ryvie sauvegardé ($(du -h "$RYVIE_BACKUP" | cut -f1))"
else
  echo "  ⚠️  $RYVIE_DIR introuvable, backup du code ignoré"
fi

# ---- Reprendre Docker -------------------------------------------------------
if [[ $DOCKER_ACTIVE -eq 1 ]]; then
  echo "▶️  Reprise des conteneurs Docker..."
  while read -r cid; do
    [[ -n "$cid" ]] && docker unpause "$cid" || true
  done < <(docker ps -q --filter "status=paused")
fi
trap - EXIT

echo "✅ Snapshots terminés : $SET_DIR"
# Afficher le chemin du snapshot pour récupération
echo "SNAPSHOT_PATH=$SET_DIR"

# ---- Rotation optionnelle ---------------------------------------------------
if [[ -n "$KEEP" ]]; then
  if ! [[ "$KEEP" =~ ^[0-9]+$ ]]; then
    echo "⚠️  --keep doit être un entier. Rotation ignorée."
    exit 0
  fi
  echo "🧹 Rotation: garder $KEEP derniers sets dans $SNAP_ROOT"
  # lister les sets (triés) et supprimer les plus anciens
  mapfile -t SETS < <(ls -1d "$SNAP_ROOT"/* 2>/dev/null | sort)
  COUNT=${#SETS[@]}
  if (( COUNT > KEEP )); then
    TO_DEL=$(( COUNT - KEEP ))
    for ((i=0; i<TO_DEL; i++)); do
      OLD="${SETS[$i]}"
      echo "   - suppression de $OLD"
      # supprimer le backup du code Ryvie
      if [[ -f "$OLD/ryvie-code.tar.gz" ]]; then
        sudo rm -f "$OLD/ryvie-code.tar.gz" "$OLD/ryvie-version.txt" || true
      fi
      # supprimer les sous-volumes enfants d'abord
      if compgen -G "$OLD/*" > /dev/null; then
        sudo btrfs subvolume delete "$OLD"/* || true
      fi
      sudo rmdir "$OLD" 2>/dev/null || true
    done
  else
    echo "   rien à supprimer ($COUNT set(s) présent(s))."
  fi
fi

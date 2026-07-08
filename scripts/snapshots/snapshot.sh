#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# snapshot.sh — snapshots SYSTÈME (tous les sous-volumes directs de /data).
#
# Le backend ne doit jamais appeler `btrfs` directement : il passe par ici.
#
#   snapshot.sh [--keep N]              crée un set de snapshots RO (+ code Ryvie)
#   snapshot.sh delete-set <path>       supprime UN set de snapshots (sécurisé)
#   snapshot.sh purge-orphans           supprime les sets orphelins au boot,
#                                       en PRÉSERVANT apps/ (snapshots per-app)
#                                       et backups/ (sauvegardes ryvie-backup.sh)
# ============================================================================

DATA_ROOT="/data"
SNAP_ROOT="$DATA_ROOT/snapshot"

# Sous-dossiers de /data/snapshot qui ne sont PAS des sets système et ne
# doivent jamais être supprimés par delete-set / purge-orphans.
RESERVED_SNAP_DIRS=("apps" "backups")

is_reserved() {
  local name="$1"
  for r in "${RESERVED_SNAP_DIRS[@]}"; do
    [[ "$name" == "$r" ]] && return 0
  done
  return 1
}

# Supprime un set (dossier contenant des sous-volumes enfants + archive code).
delete_one_set() {
  local set_path="$1"
  [[ -d "$set_path" ]] || { echo "ℹ️  Déjà supprimé: $set_path"; return 0; }
  # supprimer le backup de code éventuel
  sudo rm -f "$set_path/ryvie-code.tar.gz" "$set_path/ryvie-version.txt" 2>/dev/null || true
  # supprimer les sous-volumes enfants
  if compgen -G "$set_path/*" > /dev/null; then
    for child in "$set_path"/*; do
      if sudo btrfs subvolume show "$child" &>/dev/null; then
        sudo btrfs subvolume delete "$child" || true
      else
        sudo rm -rf "$child" || true
      fi
    done
  fi
  sudo rmdir "$set_path" 2>/dev/null || sudo rm -rf "$set_path" || true
}

# ---- Sous-commande: delete-set <path> --------------------------------------
if [[ "${1:-}" == "delete-set" ]]; then
  SET_PATH="${2:-}"
  [[ -n "$SET_PATH" ]] || { echo "❌ Usage: $(basename "$0") delete-set <path>"; exit 1; }
  case "$SET_PATH" in
    "$SNAP_ROOT"/*) : ;;
    *) echo "❌ Refus: $SET_PATH n'est pas sous $SNAP_ROOT"; exit 1 ;;
  esac
  [[ "$SET_PATH" == *".."* ]] && { echo "❌ Chemin invalide"; exit 1; }
  if is_reserved "$(basename "$SET_PATH")"; then
    echo "❌ Refus: $(basename "$SET_PATH") est un dossier réservé (apps/backups)"; exit 1
  fi
  echo "🗑️  Suppression du set de snapshots: $SET_PATH"
  delete_one_set "$SET_PATH"
  echo "✅ Set supprimé"
  exit 0
fi

# ---- Sous-commande: purge-orphans ------------------------------------------
# Remplace l'ancien cleanAllSnapshots() du backend, qui supprimait AVEUGLÉMENT
# tout /data/snapshot/* (y compris apps/ et — désormais — backups/).
if [[ "${1:-}" == "purge-orphans" ]]; then
  echo "🧹 Purge des sets de snapshots système orphelins (apps/ et backups/ préservés)…"
  if [[ -d "$SNAP_ROOT" ]]; then
    for entry in "$SNAP_ROOT"/*; do
      [[ -e "$entry" ]] || continue
      name="$(basename "$entry")"
      is_reserved "$name" && { echo "  • $name : préservé"; continue; }
      [[ -d "$entry" ]] || continue
      echo "  • $name : suppression"
      delete_one_set "$entry"
    done
  fi
  echo "✅ Purge terminée"
  exit 0
fi

# ---- Options (création d'un set) -------------------------------------------
KEEP=""   # ex: --keep 5  => garder 5 sets de snapshots
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      KEEP="${2:-}"; shift 2 || true
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--keep N] | delete-set <path> | purge-orphans"
      echo "Crée un set de snapshots RO pour tous les sous-volumes directs de /data (hors 'snapshot')."
      echo "Optionnel: --keep N  -> ne garder que les N derniers sets."
      exit 0
      ;;
    *)
      echo "Option inconnue: $1"; exit 1 ;;
  esac
done

# ---- Pré-requis ------------------------------------------------------------

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
  # lister les sets (triés), en EXCLUANT les dossiers réservés (apps/, backups/)
  mapfile -t SETS < <(
    find "$SNAP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null \
      | { grep -vxF -e apps -e backups || true; } | sort
  )
  COUNT=${#SETS[@]}
  if (( COUNT > KEEP )); then
    TO_DEL=$(( COUNT - KEEP ))
    for ((i=0; i<TO_DEL; i++)); do
      OLD="$SNAP_ROOT/${SETS[$i]}"
      echo "   - suppression de $OLD"
      delete_one_set "$OLD"
    done
  else
    echo "   rien à supprimer ($COUNT set(s) présent(s))."
  fi
fi

#!/usr/bin/env bash
set -euo pipefail

# --- Options ---
SET_PATH=""
MODE="prod"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --set) SET_PATH="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-prod}"; shift 2 ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--set /data/snapshot/<TS>] [--mode dev|prod]"
      echo "Sans --set : restaure le DERNIER set de /data/snapshot/"
      echo "Sans --mode : utilise prod par défaut"
      exit 0 ;;
    *) echo "Option inconnue: $1"; exit 1 ;;
  esac
done

DATA_ROOT="/data"
SNAP_BASE="$DATA_ROOT/snapshot"

# 0) Garde-fous
[[ "$(findmnt -no FSTYPE "$DATA_ROOT")" == "btrfs" ]] || { echo "❌ $DATA_ROOT n'est pas Btrfs"; exit 1; }
[[ -d "$SNAP_BASE" ]] || { echo "❌ Dossier snapshots introuvable: $SNAP_BASE"; exit 1; }

# 1) Choisir le set à restaurer
if [[ -z "$SET_PATH" ]]; then
  SET_PATH=$(ls -1d "$SNAP_BASE"/* 2>/dev/null | sort | tail -n1 || true)
fi
[[ -n "$SET_PATH" && -d "$SET_PATH" ]] || { echo "❌ Aucun set valide trouvé."; exit 1; }

echo "📦 Set sélectionné : $SET_PATH"

# 1.5) Vérifier si un backup du code Ryvie existe
RYVIE_BACKUP="$SET_PATH/ryvie-code.tar.gz"
RYVIE_VERSION_FILE="$SET_PATH/ryvie-version.txt"
RYVIE_DIR="/opt/Ryvie"

if [[ -f "$RYVIE_BACKUP" ]]; then
  echo "💾 Backup du code Ryvie trouvé"
  if [[ -f "$RYVIE_VERSION_FILE" ]]; then
    BACKUP_VERSION=$(cat "$RYVIE_VERSION_FILE")
    echo "   Version du backup: $BACKUP_VERSION"
  fi
  
  # Arrêter PM2 avant de restaurer le code
  echo "🛑 Arrêt des processus PM2..."
  pm2 stop all 2>/dev/null || true
  pm2 delete all 2>/dev/null || true
  
  # Sauvegarder temporairement les node_modules et .git si ils existent
  TEMP_BACKUP="/tmp/ryvie-rollback-temp-$$"
  mkdir -p "$TEMP_BACKUP"
  
  if [[ -d "$RYVIE_DIR/.git" ]]; then
    echo "   💾 Sauvegarde temporaire de .git"
    sudo cp -a "$RYVIE_DIR/.git" "$TEMP_BACKUP/" 2>/dev/null || true
  fi
  
  # Supprimer l'ancien code (sauf data et .git)
  echo "🗑️  Suppression de l'ancien code Ryvie..."
  cd "$RYVIE_DIR"
  sudo find . -maxdepth 1 -mindepth 1 \
    ! -name 'data' \
    ! -name '.git' \
    ! -name '.update-staging' \
    -exec rm -rf {} + 2>/dev/null || true
  
  # Restaurer le code depuis le backup
  echo "♻️  Restauration du code Ryvie depuis le backup..."
  sudo tar -xzf "$RYVIE_BACKUP" -C "$(dirname "$RYVIE_DIR")" --overwrite
  
  # Restaurer .git si il avait été sauvegardé
  if [[ -d "$TEMP_BACKUP/.git" ]]; then
    echo "   ♻️  Restauration de .git"
    sudo cp -a "$TEMP_BACKUP/.git" "$RYVIE_DIR/" 2>/dev/null || true
  fi
  
  # Nettoyer le backup temporaire
  rm -rf "$TEMP_BACKUP"
  
  # Restaurer les permissions
  echo "🔐 Restauration des permissions..."
  sudo chown -R ryvie:ryvie "$RYVIE_DIR"
  sudo find "$RYVIE_DIR/scripts" -type f -name "*.sh" -exec chmod +x {} \; 2>/dev/null || true
  
  echo "✅ Code Ryvie restauré"
else
  echo "⚠️  Aucun backup du code Ryvie trouvé dans ce snapshot"
  echo "   Le rollback restaurera uniquement les données"
fi

# 2) Déterminer la liste des sous-volumes à restaurer (contenu du set)
mapfile -t NAMES < <(find "$SET_PATH" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort)
[[ ${#NAMES[@]} -gt 0 ]] || { echo "❌ Set vide: $SET_PATH"; exit 1; }

# Filtrer pour exclure les volumes Docker (apps, config, docker)
# On ne restaure que les données de Ryvie (logs, images)
RYVIE_VOLUMES=()
for name in "${NAMES[@]}"; do
  # Exclure les volumes Docker qui ne doivent pas être touchés lors d'un rollback Ryvie
  if [[ "$name" != "apps" && "$name" != "docker" && "$name" != "config" ]]; then
    RYVIE_VOLUMES+=("$name")
  else
    echo "⏭️  Ignoré (volume Docker): $name"
  fi
done

if [[ ${#RYVIE_VOLUMES[@]} -eq 0 ]]; then
  echo "⚠️  Aucun volume Ryvie à restaurer"
else
  # 3) Supprimer l'état courant des volumes Ryvie uniquement
  for name in "${RYVIE_VOLUMES[@]}"; do
    CUR="$DATA_ROOT/$name"
    if [[ -e "$CUR" ]]; then
      echo "🧹 Suppression: $CUR"
      if btrfs subvolume show "$CUR" &>/dev/null; then
        btrfs subvolume delete "$CUR"
      else
        rm -rf "$CUR"
      fi
    fi
  done

  # 4) Restaurer depuis le set (volumes Ryvie uniquement)
  for name in "${RYVIE_VOLUMES[@]}"; do
    SRC="$SET_PATH/$name"
    DST="$DATA_ROOT/$name"
    if btrfs subvolume show "$SRC" &>/dev/null; then
      echo "♻️  Restauration: $name"
      btrfs subvolume snapshot "$SRC" "$DST"   # R/W
    else
      echo "⚠️  $SRC n'est pas un sous-volume Btrfs, ignoré."
    fi
  done
fi

echo "ℹ️  Docker non affecté par le rollback Ryvie"

# Redémarrer Ryvie après rollback
echo "🔄 Redémarrage de Ryvie..."

# Utiliser le mode passé en paramètre ou détecter via PM2
if [[ "$MODE" == "dev" ]]; then
  echo "  Mode DEV (paramètre), relance via dev.sh"
  cd "$RYVIE_DIR" && ./scripts/dev.sh 2>&1 | head -20
elif [[ "$MODE" == "prod" ]]; then
  echo "  Mode PROD (paramètre), relance via prod.sh"
  cd "$RYVIE_DIR" && ./scripts/prod.sh 2>&1 | head -20
elif pm2 list 2>/dev/null | grep -q "ryvie-backend-dev"; then
  echo "  Mode DEV détecté via PM2, relance via dev.sh"
  cd "$RYVIE_DIR" && ./scripts/dev.sh 2>&1 | head -20
elif pm2 list 2>/dev/null | grep -q "ryvie-backend-prod"; then
  echo "  Mode PROD détecté via PM2, relance via prod.sh"
  cd "$RYVIE_DIR" && ./scripts/prod.sh 2>&1 | head -20
else
  echo "  ⚠️ Mode non détecté, utilisation de prod.sh par défaut"
  cd "$RYVIE_DIR" && ./scripts/prod.sh 2>&1 | head -20
fi

echo "✅ Rollback terminé depuis : $SET_PATH"

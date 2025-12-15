#!/bin/bash
set -euo pipefail

# Script d'update Ryvie - Exécution externe indépendante du backend
# Usage: ./update-and-restart.sh <target_version> [--mode dev|prod]

TARGET_VERSION="${1:-}"
MODE="${2:-prod}"

if [[ -z "$TARGET_VERSION" ]]; then
  echo "❌ Usage: $0 <target_version> [--mode dev|prod]"
  echo "   Exemple: $0 v0.1.6 --mode dev"
  exit 1
fi

# Normaliser le mode
if [[ "$MODE" == "--mode" ]]; then
  MODE="${3:-prod}"
fi

RYVIE_DIR="/opt/Ryvie"
TEMP_DIR="$RYVIE_DIR/.update-staging"
GITHUB_REPO="maisonnavejul/Ryvie"
SNAPSHOT_PATH=""
LOG_FILE="/tmp/ryvie-update-$(date +%Y%m%d-%H%M%S).log"

# Fonction de logging
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Fonction de nettoyage
cleanup() {
  if [[ -d "$TEMP_DIR" ]]; then
    log "🧹 Nettoyage du dossier temporaire..."
    rm -rf "$TEMP_DIR" || true
  fi
}

# Fonction de rollback
rollback() {
  log "❌ Erreur détectée, rollback en cours..."
  if [[ -n "$SNAPSHOT_PATH" && -d "$SNAPSHOT_PATH" ]]; then
    log "🔄 Restauration du snapshot: $SNAPSHOT_PATH"
    sudo "$RYVIE_DIR/scripts/rollback.sh" --set "$SNAPSHOT_PATH" 2>&1 | tee -a "$LOG_FILE"
    log "✅ Rollback terminé"
  else
    log "⚠️ Pas de snapshot disponible pour rollback"
    # Relancer manuellement selon le mode
    log "🔄 Relance manuelle de Ryvie..."
    if [[ "$MODE" == "dev" ]]; then
      cd "$RYVIE_DIR" && ./scripts/dev.sh >> "$LOG_FILE" 2>&1 &
    else
      cd "$RYVIE_DIR" && ./scripts/prod.sh >> "$LOG_FILE" 2>&1 &
    fi
  fi
  cleanup
  exit 1
}

trap rollback ERR

log "========================================="
log "🚀 Début de la mise à jour Ryvie"
log "   Version cible: $TARGET_VERSION"
log "   Mode: $MODE"
log "   Log: $LOG_FILE"
log "========================================="

# 1. Créer snapshot de sécurité
log "📸 Création du snapshot de sécurité..."
SNAPSHOT_OUTPUT=$(sudo "$RYVIE_DIR/scripts/snapshot.sh" 2>&1 || true)
echo "$SNAPSHOT_OUTPUT" >> "$LOG_FILE"

if echo "$SNAPSHOT_OUTPUT" | grep -q "SNAPSHOT_PATH="; then
  SNAPSHOT_PATH=$(echo "$SNAPSHOT_OUTPUT" | grep "SNAPSHOT_PATH=" | cut -d'=' -f2)
  log "✅ Snapshot créé: $SNAPSHOT_PATH"
else
  log "⚠️ Snapshot non créé, continuation sans filet de sécurité"
fi

# 2. Télécharger la release depuis GitHub
log "📥 Téléchargement de la release $TARGET_VERSION..."

# Nettoyer et créer le dossier temporaire
[[ -d "$TEMP_DIR" ]] && rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

# URL du tarball auto-généré par GitHub
TARBALL_URL="https://api.github.com/repos/$GITHUB_REPO/tarball/$TARGET_VERSION"
TARBALL_PATH="$TEMP_DIR/$TARGET_VERSION.tar.gz"

# Télécharger (avec token si disponible)
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  curl -L -H "Authorization: token $GITHUB_TOKEN" -o "$TARBALL_PATH" "$TARBALL_URL" >> "$LOG_FILE" 2>&1
else
  curl -L -o "$TARBALL_PATH" "$TARBALL_URL" >> "$LOG_FILE" 2>&1
fi

log "✅ Téléchargement terminé"

# 3. Extraire
log "📦 Extraction de l'archive..."
STAGING_DIR="$TEMP_DIR/extracted"
mkdir -p "$STAGING_DIR"
tar -xzf "$TARBALL_PATH" -C "$STAGING_DIR" --strip-components=1 >> "$LOG_FILE" 2>&1
log "✅ Extraction terminée"

# 4. Copier les configurations locales vers le staging
log "📋 Copie des configurations locales..."

# Front/src/config/
FRONT_CONFIG_SRC="$RYVIE_DIR/Ryvie-Front/src/config"
FRONT_CONFIG_DEST="$STAGING_DIR/Ryvie-Front/src/config"
if [[ -d "$FRONT_CONFIG_SRC" ]]; then
  [[ -d "$FRONT_CONFIG_DEST" ]] && rm -rf "$FRONT_CONFIG_DEST"
  cp -r "$FRONT_CONFIG_SRC" "$FRONT_CONFIG_DEST"
  log "  ✅ Front/src/config copié"
fi

# Back/.env
BACK_ENV_SRC="$RYVIE_DIR/Ryvie-Back/.env"
BACK_ENV_DEST="$STAGING_DIR/Ryvie-Back/.env"
if [[ -f "$BACK_ENV_SRC" ]]; then
  cp "$BACK_ENV_SRC" "$BACK_ENV_DEST"
  log "  ✅ Back/.env copié"
fi

# 5. Appliquer la nouvelle version
log "🔄 Application de la nouvelle version..."
rsync -av --exclude='.git' --exclude='node_modules' --exclude='.update-staging' "$STAGING_DIR/" "$RYVIE_DIR/" >> "$LOG_FILE" 2>&1
log "✅ Nouvelle version appliquée"

# 5.5. Récupérer les tags git pour que git describe fonctionne
log "🏷️  Récupération des tags git..."
cd "$RYVIE_DIR"

if [[ -d "$RYVIE_DIR/.git" ]]; then
  # Fetch uniquement les tags (pas tout l'historique)
  log "  Fetch des tags depuis origin..."
  git fetch --tags origin >> "$LOG_FILE" 2>&1 || {
    log "  ⚠️  Impossible de récupérer les tags depuis origin"
  }
  
  # Vérifier que le tag cible existe localement
  if git rev-parse "$TARGET_VERSION" >/dev/null 2>&1; then
    log "  ✅ Tag $TARGET_VERSION disponible localement"
    # Checkout le tag pour que git describe fonctionne correctement
    git checkout "$TARGET_VERSION" >> "$LOG_FILE" 2>&1 || {
      log "  ⚠️  Impossible de checkout le tag, git describe utilisera le tag le plus proche"
    }
  else
    log "  ⚠️  Tag $TARGET_VERSION non trouvé localement"
  fi
else
  log "  ⚠️  Pas de dépôt git (.git absent), git describe ne fonctionnera pas"
  log "  💡 Conseil: cloner le repo au lieu d'utiliser un tarball pour conserver l'historique git"
fi

# 6. Rebuild et redémarrage
log "🔧 Build et redémarrage de Ryvie (mode: $MODE)..."

if [[ "$MODE" == "dev" ]]; then
  cd "$RYVIE_DIR" && ./scripts/dev.sh >> "$LOG_FILE" 2>&1
else
  cd "$RYVIE_DIR" && ./scripts/prod.sh >> "$LOG_FILE" 2>&1
fi

log "✅ Build et redémarrage terminés"

# 7. Nettoyage
cleanup

# 8. Supprimer le snapshot si tout s'est bien passé
if [[ -n "$SNAPSHOT_PATH" && -d "$SNAPSHOT_PATH" ]]; then
  log "🧹 Suppression du snapshot de sécurité..."
  sudo btrfs subvolume delete "$SNAPSHOT_PATH"/* 2>/dev/null || true
  sudo rmdir "$SNAPSHOT_PATH" 2>/dev/null || true
  log "✅ Snapshot supprimé"
fi

log "========================================="
log "✅ Mise à jour terminée avec succès"
log "   Version: $TARGET_VERSION"
log "   Log complet: $LOG_FILE"
log "========================================="

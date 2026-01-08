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
STATUS_FILE="/tmp/ryvie-update-status.json"

# Fonction de logging
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Fonction pour mettre à jour le statut (visible par le frontend)
update_status() {
  local step="$1"
  local message="$2"
  local progress="${3:-0}"
  
  cat > "$STATUS_FILE" <<EOF
{
  "step": "$step",
  "message": "$message",
  "progress": $progress,
  "timestamp": "$(date -Iseconds)",
  "logFile": "$LOG_FILE"
}
EOF
  log "$message"
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
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "⚠️  ERREUR DÉTECTÉE PENDANT LA MISE À JOUR"
  echo "🔄 RETOUR À LA VERSION PRÉCÉDENTE EN COURS..."
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  
  update_status "rollback" "Erreur détectée - Restauration en cours" 0
  log "❌ Erreur détectée, rollback en cours..."
  
  if [[ -n "$SNAPSHOT_PATH" && -d "$SNAPSHOT_PATH" ]]; then
    log "🔄 Restauration du snapshot: $SNAPSHOT_PATH"
    log "📦 Restauration des données et du code..."
    
    if sudo "$RYVIE_DIR/scripts/rollback.sh" --set "$SNAPSHOT_PATH" --mode "$MODE" 2>&1 | tee -a "$LOG_FILE"; then
      echo ""
      echo "═══════════════════════════════════════════════════════════════"
      echo "✅ ROLLBACK TERMINÉ AVEC SUCCÈS"
      echo "📌 Le système a été restauré à la version précédente"
      echo "💡 Consultez les logs pour plus de détails: $LOG_FILE"
      echo "═══════════════════════════════════════════════════════════════"
      echo ""
      log "✅ Rollback terminé avec succès"
    else
      echo ""
      echo "═══════════════════════════════════════════════════════════════"
      echo "❌ ERREUR CRITIQUE: Le rollback a échoué"
      echo "⚠️  Intervention manuelle requise"
      echo "📋 Log: $LOG_FILE"
      echo "═══════════════════════════════════════════════════════════════"
      echo ""
      log "❌ ERREUR CRITIQUE: Rollback échoué"
    fi
  else
    log "⚠️ Pas de snapshot disponible pour rollback"
    log "🔄 Tentative de relance manuelle de Ryvie..."
    
    # Arrêter les processus actuels
    pm2 stop all 2>/dev/null || true
    pm2 delete all 2>/dev/null || true
    
    # Relancer selon le mode
    if [[ "$MODE" == "dev" ]]; then
      cd "$RYVIE_DIR" && ./scripts/dev.sh >> "$LOG_FILE" 2>&1 &
    else
      cd "$RYVIE_DIR" && ./scripts/prod.sh >> "$LOG_FILE" 2>&1 &
    fi
    
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "⚠️  ROLLBACK PARTIEL"
    echo "📌 Pas de snapshot disponible, redémarrage du système actuel"
    echo "💡 Consultez les logs: $LOG_FILE"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
  fi
  
  cleanup
  exit 1
}

trap cleanup EXIT

update_status "starting" "Démarrage de la mise à jour vers $TARGET_VERSION" 5
log "═══════════════════════════════════════════════════════════════"
log "🚀 DÉBUT DE LA MISE À JOUR RYVIE"
log "═══════════════════════════════════════════════════════════════"
log "Version cible: $TARGET_VERSION"
log "Mode: $MODE"
log "Log file: $LOG_FILE"
log "═══════════════════════════════════════════════════════════════"

# 1. Créer un snapshot de sécurité
update_status "snapshot" "Création du snapshot de sécurité" 10
SNAPSHOT_OUTPUT=$(sudo "$RYVIE_DIR/scripts/snapshot.sh" 2>&1 || true)
echo "$SNAPSHOT_OUTPUT" >> "$LOG_FILE"

if echo "$SNAPSHOT_OUTPUT" | grep -q "SNAPSHOT_PATH="; then
  SNAPSHOT_PATH=$(echo "$SNAPSHOT_OUTPUT" | grep "SNAPSHOT_PATH=" | cut -d'=' -f2)
  log "✅ Snapshot créé: $SNAPSHOT_PATH"
else
  log "⚠️ Snapshot non créé, continuation sans filet de sécurité"
fi

# 2. Télécharger la release
update_status "downloading" "Téléchargement de la version $TARGET_VERSION" 30

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

# 3. Extraire l'archive
update_status "extracting" "Extraction des fichiers" 40
STAGING_DIR="$TEMP_DIR/extracted"
mkdir -p "$STAGING_DIR"
tar -xzf "$TARBALL_PATH" -C "$STAGING_DIR" --strip-components=1 >> "$LOG_FILE" 2>&1
log "✅ Extraction terminée"

# 4. Supprimer l'ancien code (sauf /data, node_modules, .git)
log "🗑️  Suppression de l'ancien code..."
cd "$RYVIE_DIR"
find . -maxdepth 1 -mindepth 1 \
  ! -name 'data' \
  ! -name 'node_modules' \
  ! -name '.git' \
  ! -name '.update-staging' \
  ! -name 'netbird-data.json' \
  -exec rm -rf {} + 2>/dev/null || true
log "✅ Ancien code supprimé"

# Note: netbird-data.json sera synchronisé automatiquement par le backend au démarrage
echo "ℹ️  netbird-data.json sera synchronisé par le backend au démarrage"

# 5. Sauvegarder les permissions actuelles
update_status "permissions" "Sauvegarde des permissions" 50
CURRENT_USER=$(stat -c '%U' "$RYVIE_DIR" 2>/dev/null || stat -f '%Su' "$RYVIE_DIR" 2>/dev/null || echo "ryvie")
CURRENT_GROUP=$(stat -c '%G' "$RYVIE_DIR" 2>/dev/null || stat -f '%Sg' "$RYVIE_DIR" 2>/dev/null || echo "ryvie")
log "  Propriétaire actuel: $CURRENT_USER:$CURRENT_GROUP"

# 6. Copier la nouvelle version
update_status "applying" "Application de la nouvelle version" 55
cp -rf "$STAGING_DIR"/* "$RYVIE_DIR/"
log "✅ Nouvelle version appliquée"

# 7. Restaurer les permissions
log "🔐 Restauration des permissions..."
if [ "$CURRENT_USER" != "$(whoami)" ]; then
  log "  ⚠️  Changement de propriétaire nécessaire (sudo requis)"
  sudo chown -R "$CURRENT_USER:$CURRENT_GROUP" "$RYVIE_DIR"
else
  chown -R "$CURRENT_USER:$CURRENT_GROUP" "$RYVIE_DIR" 2>/dev/null || true
fi

# Rendre les scripts exécutables
find "$RYVIE_DIR/scripts" -type f -name "*.sh" -exec chmod +x {} \; 2>/dev/null || true
log "  Permissions restaurs ($CURRENT_USER:$CURRENT_GROUP)"

# 8. Mettre jour le package.json racine avec la version
if [[ "$TARGET_VERSION" =~ ^v?([0-9]+\.[0-9]+\.[0-9]+) ]]; then
  SEMVER="${BASH_REMATCH[1]}"
  log "  Mise jour de package.json avec version $SEMVER..."

  cat > "$RYVIE_DIR/package.json" <<EOF
{
  "name": "ryvie",
  "version": "$SEMVER"
}
EOF
fi

# 8.5. Patcher prod.sh pour s'assurer qu'il installe les devDependencies
log "🔧 Patch de prod.sh pour compatibilité..."
if [[ -f "$RYVIE_DIR/scripts/prod.sh" ]]; then
  # Remplacer toutes les occurrences de "npm install" (sans --include=dev) par "npm install --include=dev"
  # Cela garantit que les devDependencies sont installées pour le build
  sed -i 's/npm install$/npm install --include=dev/g' "$RYVIE_DIR/scripts/prod.sh"
  chmod +x "$RYVIE_DIR/scripts/prod.sh"
  log "✅ prod.sh patché"
fi

# 9. Rebuild et redmarrage
update_status "building" "Installation des dpendances et compilation" 60

if [[ "$MODE" == "dev" ]]; then
  cd "$RYVIE_DIR" && bash ./scripts/dev.sh >> "$LOG_FILE" 2>&1
else
  cd "$RYVIE_DIR" && bash ./scripts/prod.sh >> "$LOG_FILE" 2>&1
fi

if [ $? -ne 0 ]; then
  log "❌ Erreur lors du build/redémarrage"
  log "⚠️  UNE ERREUR S'EST PRODUITE PENDANT LA MISE À JOUR"
  log "🔄 RETOUR À LA VERSION PRÉCÉDENTE EN COURS..."
  rollback
fi

update_status "health_check" "Vérification du démarrage" 80

# 10. Health check intelligent avec détection rapide

# Déterminer les processus et logs selon le mode
if [[ "$MODE" == "dev" ]]; then
  BACKEND_PROCESS="ryvie-backend-dev"
  FRONTEND_PROCESS="ryvie-frontend-dev"
  BACKEND_LOG="/data/logs/backend-dev-error.log"
  BACKEND_OUT="/data/logs/backend-dev-out.log"
else
  BACKEND_PROCESS="ryvie-backend-prod"
  FRONTEND_PROCESS="ryvie-frontend-prod"
  BACKEND_LOG="/data/logs/backend-prod-error-0.log"
  BACKEND_OUT="/data/logs/backend-prod-out-0.log"
fi

# Fonction de health check intelligent
perform_health_check() {
  local max_wait=180  # Timeout de sécurité pour erreurs silencieuses (3 minutes)
  local start_time=$(date +%s)
  local check_interval=2
  
  log "  Surveillance active (timeout sécurité: ${max_wait}s)..."
  
  while true; do
    local current_time=$(date +%s)
    local elapsed=$((current_time - start_time))
    
    # 1. Vérifier les erreurs critiques dans les logs
    if [[ -f "$BACKEND_LOG" ]]; then
      local recent_errors=$(tail -n 50 "$BACKEND_LOG" 2>/dev/null || echo "")
      
      # Erreurs critiques qui nécessitent un rollback immédiat
      if echo "$recent_errors" | grep -qiE "(Cannot find module.*dist/index\.js|ENOENT.*dist/index|MODULE_NOT_FOUND.*dist|Error: Cannot find module|CRITICAL.*environment variable.*required|Fatal error|Segmentation fault|EADDRINUSE|listen EADDRINUSE)"; then
        log "  ❌ ERREUR CRITIQUE détectée dans les logs après ${elapsed}s!"
        echo "$recent_errors" | tail -n 10 >> "$LOG_FILE"
        return 1
      fi
      
      # PM2 a arrêté le processus
      if echo "$recent_errors" | grep -qiE "(Script.*had too many unstable restarts|stopped|errored)"; then
        log "  ❌ PM2 a arrêté le processus après ${elapsed}s!"
        echo "$recent_errors" | tail -n 10 >> "$LOG_FILE"
        return 1
      fi
    fi
    
    # 2. Vérifier le statut PM2
    local backend_status=$(pm2 jlist 2>/dev/null | jq -r ".[] | select(.name==\"$BACKEND_PROCESS\") | .pm2_env.status" 2>/dev/null || echo "not_found")
    local restart_count=$(pm2 jlist 2>/dev/null | jq -r ".[] | select(.name==\"$BACKEND_PROCESS\") | .pm2_env.restart_time" 2>/dev/null || echo "0")
    
    # Processus en erreur ou arrêté
    if [[ "$backend_status" == "stopped" ]] || [[ "$backend_status" == "errored" ]]; then
      log "  ❌ Backend en état $backend_status après ${elapsed}s"
      return 1
    fi
    
    # Trop de redémarrages
    if [[ "$restart_count" -gt 5 ]]; then
      log "  ❌ Backend a redémarré $restart_count fois après ${elapsed}s"
      return 1
    fi
    
    # 3. Si le backend est online, vérifier qu'il répond
    if [[ "$backend_status" == "online" ]]; then
      # Attendre un peu que le serveur soit vraiment prêt
      if [[ $elapsed -ge 10 ]]; then
        # Test HTTP pour confirmer que le backend répond
        if command -v curl >/dev/null 2>&1; then
          local http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3002/api/health 2>/dev/null || echo "000")
          
          # Codes acceptables: 200 (OK), 401 (auth requise mais serveur répond), 404 (route pas trouvée mais serveur répond)
          if [[ "$http_code" == "200" ]] || [[ "$http_code" == "401" ]] || [[ "$http_code" == "404" ]]; then
            log "  ✅ Backend online et répond correctement (HTTP $http_code) après ${elapsed}s"
            log "  Backend: status=$backend_status, restarts=$restart_count"
            return 0
          fi
          
          # Erreur serveur
          if [[ "$http_code" == "500" ]] || [[ "$http_code" == "502" ]] || [[ "$http_code" == "503" ]]; then
            log "  ❌ Backend répond avec erreur HTTP $http_code après ${elapsed}s"
            return 1
          fi
          
          # Si le backend est online depuis plus de 30s mais ne répond pas encore, on considère que c'est OK
          # Le backend peut prendre du temps à initialiser tous les services
          if [[ $elapsed -ge 30 ]]; then
            log "  ✅ Backend online (PM2) depuis ${elapsed}s, initialisation en cours"
            log "  Backend: status=$backend_status, restarts=$restart_count"
            return 0
          fi
        else
          # Pas de curl, on fait confiance au statut PM2
          log "  ✅ Backend online (PM2) après ${elapsed}s"
          log "  Backend: status=$backend_status, restarts=$restart_count"
          return 0
        fi
      fi
    fi
    
    # 4. Timeout de sécurité atteint (erreur silencieuse)
    if [[ $elapsed -ge $max_wait ]]; then
      log "  ⚠️  Timeout de sécurité atteint (${max_wait}s) - backend: $backend_status"
      if [[ "$backend_status" == "online" ]]; then
        log "  ℹ️  Le backend est online mais ne répond pas aux requêtes HTTP"
        log "  ℹ️  Cela peut être normal si le démarrage est lent"
        # On considère que c'est OK si PM2 dit que c'est online
        return 0
      else
        log "  ❌ Timeout et backend pas online: $backend_status"
        return 1
      fi
    fi
    
    # Attendre avant la prochaine vérification
    sleep $check_interval
  done
}

# Exécuter le health check
if ! perform_health_check; then
  log "⚠️  UNE ERREUR S'EST PRODUITE AU DÉMARRAGE"
  log "🔄 RETOUR À LA VERSION PRÉCÉDENTE EN COURS..."
  rollback
fi

update_status "completed" "Mise à jour terminée avec succès!" 100
log "📊 Le système fonctionne correctement"

# 11. Nettoyage
cleanup

# 12. Supprimer le snapshot si tout s'est bien passé
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

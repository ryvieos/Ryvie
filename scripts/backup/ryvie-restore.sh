#!/usr/bin/env bash
# =====================================================
# Ryvie — Restauration d'une sauvegarde dans /data
# =====================================================
# Remet en place une sauvegarde créée par ryvie-backup.sh :
# arrête tous les services, réinjecte apps/config/images/netbird,
# puis relance tout dans le bon ordre.
#
# Usage :
#   ryvie-restore.sh <source> [options]
#
#   <source> :
#     /mnt/usb-backup/2026-07-08_120000    → dossier d'une sauvegarde précise
#     /mnt/usb-backup/latest               → 'latest' = la plus récente de la cible
#     ssh://user@host:/chemin/2026-...     → sauvegarde distante (via rsync/ssh)
#
#   Options :
#     --dry-run                Montre ce qui serait fait, ne touche à rien
#     --new-netbird-identity   NE PAS restaurer l'identité NetBird (si l'ancien
#                              Ryvie est encore en vie → évite le conflit de peer).
#                              Les URLs des .env devront être régénérées.
#     --yes                    Pas de confirmation interactive
#
# Prérequis : install.sh déjà passé sur la machine (Ryvie vierge fonctionnel).
# =====================================================
set -euo pipefail

DATA_ROOT="/data"
SUBVOLS=(apps config images netbird)
DRY_RUN=0
NEW_NB_IDENTITY=0
ASSUME_YES=0
SOURCE=""

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[restore]${NC} $1"; }
warn() { echo -e "${YELLOW}[restore]${NC} $1"; }
die()  { echo -e "${RED}[restore] ❌ $1${NC}" >&2; exit 1; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }

# ---------- Arguments ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)              DRY_RUN=1 ;;
    --new-netbird-identity) NEW_NB_IDENTITY=1 ;;
    --yes|-y)               ASSUME_YES=1 ;;
    -h|--help)              grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                      [ -z "$SOURCE" ] && SOURCE="$1" || die "Argument inattendu: $1" ;;
  esac
  shift
done
[ -n "$SOURCE" ] || die "Source manquante. Usage: $0 <source> [--dry-run] [--new-netbird-identity] [--yes]"

# ---------- Pré-requis ----------
[ "$(id -u)" -eq 0 ] || die "Ce script doit être lancé en root (sudo)."
[ "$(findmnt -no FSTYPE "$DATA_ROOT" 2>/dev/null)" = "btrfs" ] || die "$DATA_ROOT n'est pas en Btrfs (lancez install.sh d'abord)."
command -v jq >/dev/null || die "jq est requis."
command -v rsync >/dev/null || die "rsync est requis."

# ---------- Résolution de la source ----------
SSH_HOST=""; SRC_PATH=""
if [[ "$SOURCE" == ssh://* ]]; then
  stripped="${SOURCE#ssh://}"
  SSH_HOST="${stripped%%[:/]*}"
  SRC_PATH="/${stripped#*[:/]}"; SRC_PATH="${SRC_PATH#/}"; SRC_PATH="/$SRC_PATH"
  ssh -o BatchMode=yes "$SSH_HOST" true 2>/dev/null || die "Connexion SSH impossible vers $SSH_HOST."
  src_ls() { ssh "$SSH_HOST" "ls -1 '$SRC_PATH'"; }
  src_exists() { ssh "$SSH_HOST" "test -e '$SRC_PATH/$1'"; }
  src_cat() { ssh "$SSH_HOST" "cat '$SRC_PATH/$1'"; }
  RSYNC_SRC="$SSH_HOST:$SRC_PATH"
else
  SRC_PATH="$SOURCE"
  if [ "$(basename "$SRC_PATH")" = "latest" ]; then
    parent="$(dirname "$SRC_PATH")"
    last=$(find "$parent" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -E '^[0-9]{4}-' | sort | tail -1 || true)
    [ -n "$last" ] || die "Aucune sauvegarde trouvée dans $parent."
    SRC_PATH="$parent/$last"
    log "latest → $SRC_PATH"
  fi
  [ -d "$SRC_PATH" ] || die "Source introuvable: $SRC_PATH"
  src_ls() { ls -1 "$SRC_PATH"; }
  src_exists() { test -e "$SRC_PATH/$1"; }
  src_cat() { cat "$SRC_PATH/$1"; }
  RSYNC_SRC="$SRC_PATH"
fi

# ---------- Manifest + confirmation ----------
if src_exists manifest.json; then
  MANIFEST=$(src_cat manifest.json)
  echo ""
  echo "====================================================="
  echo " Sauvegarde à restaurer"
  echo "====================================================="
  echo "$MANIFEST" | jq -r '"  Date          : \(.date)\n  Machine       : \(.host)\n  Version Ryvie : \(.ryvieVersion)\n  Apps          : \(.apps | join(", "))"'
  echo "====================================================="
else
  warn "Pas de manifest.json dans la source — sauvegarde non standard ?"
  MANIFEST="{}"
fi

for sv in "${SUBVOLS[@]}"; do
  src_exists "$sv" || die "La source ne contient pas '$sv/' — sauvegarde incomplète ?"
done

echo ""
warn "⚠️  Le contenu actuel de /data/{apps,config,images$( [ "$NEW_NB_IDENTITY" -eq 0 ] && echo ",netbird")} sera REMPLACÉ."
warn "    (une copie de secours locale est conservée : /data/<sousvol>.pre-restore)"
if [ "$ASSUME_YES" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
  read -r -p "Confirmer la restauration ? (oui/non) : " CONFIRM
  [ "$CONFIRM" = "oui" ] || { echo "Abandon."; exit 1; }
fi

RESTORE_SUBVOLS=("${SUBVOLS[@]}")
if [ "$NEW_NB_IDENTITY" -eq 1 ]; then
  RESTORE_SUBVOLS=(apps config images)
  warn "Identité NetBird NON restaurée (--new-netbird-identity)."
fi

# ---------- 1. Tout arrêter ----------
log "1/5 Arrêt des services…"
run systemctl stop netbird 2>/dev/null || true
if command -v pm2 >/dev/null 2>&1; then
  RYVIE_USER=$(stat -c '%U' /opt/Ryvie 2>/dev/null || echo ryvie)
  run sudo -u "$RYVIE_USER" pm2 stop all 2>/dev/null || true
fi
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  for compose in "$DATA_ROOT"/apps/*/docker-compose.yml "$DATA_ROOT"/apps/*/*/docker-compose.yml; do
    [ -f "$compose" ] || continue
    run docker compose -f "$compose" down 2>/dev/null || true
  done
  # Conteneurs cœur restants (openldap, keycloak, caddy…)
  remaining=$(docker ps -q)
  [ -n "$remaining" ] && run docker stop $remaining
fi

# ---------- 2. Réinjecter les données ----------
log "2/5 Restauration des données (rsync -aHAX --numeric-ids --delete)…"
for sv in "${RESTORE_SUBVOLS[@]}"; do
  log "  → $sv"
  # Copie de secours du contenu actuel (renommage de sous-volume = instantané)
  if [ -e "$DATA_ROOT/$sv" ]; then
    run rm -rf "$DATA_ROOT/$sv.pre-restore" 2>/dev/null || true
    if btrfs subvolume show "$DATA_ROOT/$sv" >/dev/null 2>&1; then
      run btrfs subvolume snapshot "$DATA_ROOT/$sv" "$DATA_ROOT/$sv.pre-restore" >/dev/null
    else
      run cp -a "$DATA_ROOT/$sv" "$DATA_ROOT/$sv.pre-restore"
    fi
  fi
  # Restauration DANS le sous-volume existant (préserve le statut sous-volume)
  run rsync -aHAX --numeric-ids --delete "$RSYNC_SRC/$sv/" "$DATA_ROOT/$sv/"
done

# ---------- 3. Spécificités machine ----------
log "3/5 Ajustements machine…"
if [ "$NEW_NB_IDENTITY" -eq 0 ]; then
  # Reprendre l'identité NetBird de l'ancienne machine (même IP wt0 → les .env restent valides)
  if [ ! -L /var/lib/netbird ]; then
    run rm -rf /var/lib/netbird
    run ln -s "$DATA_ROOT/netbird" /var/lib/netbird
  fi
  log "  Identité NetBird restaurée — l'ancienne box ne doit PLUS être connectée."
else
  warn "  Identité NetBird neuve conservée : pensez à régénérer les URLs des .env rdrive"
  warn "  (REACT_APP_*_URL avec la nouvelle IP wt0) puis à redémarrer les apps concernées."
fi

# ---------- 4. Relancer dans l'ordre ----------
log "4/5 Relance des services…"
run systemctl start netbird 2>/dev/null || true
sleep 3
if [ -f "$DATA_ROOT/config/ldap/docker-compose.yml" ]; then
  run docker compose -f "$DATA_ROOT/config/ldap/docker-compose.yml" up -d
fi
if command -v pm2 >/dev/null 2>&1; then
  run sudo -u "${RYVIE_USER:-ryvie}" pm2 restart all 2>/dev/null || true
fi
for compose in "$DATA_ROOT"/apps/*/docker-compose.yml "$DATA_ROOT"/apps/*/*/docker-compose.yml; do
  [ -f "$compose" ] || continue
  log "  ↑ $(dirname "$compose")"
  run docker compose -f "$compose" up -d 2>/dev/null || warn "  échec de relance: $compose (à relancer manuellement)"
done

# ---------- 5. Vérifications ----------
log "5/5 Vérifications…"
if [ "$DRY_RUN" -eq 0 ]; then
  sleep 5
  nb_containers=$(docker ps -q | wc -l)
  log "  Conteneurs actifs : $nb_containers"
  command -v pm2 >/dev/null && sudo -u "${RYVIE_USER:-ryvie}" pm2 list | grep -E "online|stopped" || true
fi

echo ""
log "✅ Restauration terminée."
log "   À vérifier : connexion UI avec un ancien compte, photos rPictures, fichiers rDrive."
log "   Copies de secours locales : /data/<sousvol>.pre-restore (supprimez-les une fois satisfait :"
log "   btrfs subvolume delete /data/apps.pre-restore … )"

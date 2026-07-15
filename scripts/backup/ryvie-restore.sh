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
is_subvol() { btrfs subvolume show "$1" >/dev/null 2>&1; }
mangle() { printf '%s' "${1//\//%}"; }   # apps/rdrive -> apps%rdrive (layout "flat")

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

# Liste (aplatie) des sous-volumes à restaurer + disposition de la source :
#   layout=nested → source/apps/rdrive      (sauvegarde rsync, portable)
#   layout=flat   → source/apps%rdrive      (sauvegarde btrfs send)
# Repli pour les vieilles sauvegardes sans ces champs : les 4 top-levels, en nested.
LAYOUT="nested"
declare -a SV_LIST=()
if [ "$MANIFEST" != "{}" ]; then
  ml=$(echo "$MANIFEST" | jq -r '.layout // empty'); [ -n "$ml" ] && LAYOUT="$ml"
  while IFS= read -r s; do [ -n "$s" ] && SV_LIST+=("$s"); done \
    < <(echo "$MANIFEST" | jq -r '.subvolumes[]?')
fi
[ ${#SV_LIST[@]} -gt 0 ] || SV_LIST=("${SUBVOLS[@]}")

# Chemin de la source pour un sous-volume donné (selon le layout)
src_rel() { [ "$LAYOUT" = "flat" ] && mangle "$1" || printf '%s' "$1"; }

for rel in "${SV_LIST[@]}"; do
  src_exists "$(src_rel "$rel")" || die "La source ne contient pas '$rel' — sauvegarde incomplète ?"
done

# Liste effective à restaurer (parents avant enfants — garanti par le manifest).
# --new-netbird-identity : on écarte netbird et tout ce qui est imbriqué dessous.
declare -a RESTORE_SUBVOLS=()
for rel in "${SV_LIST[@]}"; do
  if [ "$NEW_NB_IDENTITY" -eq 1 ] && { [ "$rel" = "netbird" ] || [[ "$rel" == netbird/* ]]; }; then
    continue
  fi
  RESTORE_SUBVOLS+=("$rel")
done

echo ""
warn "⚠️  Le contenu actuel de /data/{$(IFS=,; echo "${RESTORE_SUBVOLS[*]}")} sera REMPLACÉ."
warn "    (copies de secours locales conservées sous : $DATA_ROOT/.pre-restore/)"
[ "$NEW_NB_IDENTITY" -eq 1 ] && warn "Identité NetBird NON restaurée (--new-netbird-identity)."
if [ "$ASSUME_YES" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
  read -r -p "Confirmer la restauration ? (oui/non) : " CONFIRM
  [ "$CONFIRM" = "oui" ] || { echo "Abandon."; exit 1; }
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
# Chaque sous-volume est restauré INDIVIDUELLEMENT dans son propre chemin. Pour un
# parent (ex: apps) qui contient des sous-volumes imbriqués (rdrive, rpictures…), on
# EXCLUT ces enfants du rsync : sinon le --delete effacerait leur contenu (ils vivent
# dans des sous-volumes distincts, absents/vides côté source du parent). Les enfants
# sont restaurés ensuite, dans leur propre itération (parents avant enfants).
log "2/5 Restauration des données (rsync -aHAX --numeric-ids --delete, par sous-volume)…"

# --exclude ancrés pour les enfants DIRECTS de $1 présents dans RESTORE_SUBVOLS
direct_child_excludes() {
  local parent="$1" c
  for c in "${RESTORE_SUBVOLS[@]}"; do
    [ "$(dirname "$c")" = "$parent" ] && printf -- '--exclude=/%s/\n' "$(basename "$c")"
  done
}

PRE_ROOT="$DATA_ROOT/.pre-restore"
run mkdir -p "$PRE_ROOT"
for rel in "${RESTORE_SUBVOLS[@]}"; do
  log "  → $rel"
  m="$(mangle "$rel")"

  # Copie de secours COMPLÈTE du contenu actuel (snapshot instantané, ou copie)
  if [ -e "$DATA_ROOT/$rel" ]; then
    run rm -rf "$PRE_ROOT/$m" 2>/dev/null || true
    if is_subvol "$DATA_ROOT/$rel"; then
      run btrfs subvolume snapshot "$DATA_ROOT/$rel" "$PRE_ROOT/$m" >/dev/null
    else
      run cp -a "$DATA_ROOT/$rel" "$PRE_ROOT/$m"
    fi
  else
    # Cible absente (ex: sous-volume applicatif pas encore créé) → le créer
    run btrfs subvolume create "$DATA_ROOT/$rel" >/dev/null 2>&1 || run mkdir -p "$DATA_ROOT/$rel"
  fi

  # Restauration DANS le sous-volume existant (préserve son statut de sous-volume),
  # en protégeant les enfants imbriqués contre le --delete.
  mapfile -t EXC < <(direct_child_excludes "$rel")
  run rsync -aHAX --numeric-ids --delete "${EXC[@]}" "$RSYNC_SRC/$(src_rel "$rel")/" "$DATA_ROOT/$rel/"
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
# Autres stacks cœur sous config/ (portainer…) — un `docker stop` manuel neutralise
# restart:always, et le backend ne les relance pas si leur compose existe déjà.
# (caddy et keycloak, eux, sont relancés par le backend au démarrage.)
for compose in "$DATA_ROOT"/config/*/docker-compose.yml; do
  [ -f "$compose" ] || continue
  [ "$compose" = "$DATA_ROOT/config/ldap/docker-compose.yml" ] && continue
  run docker compose -f "$compose" up -d 2>/dev/null || warn "  échec de relance: $compose (à relancer manuellement)"
done
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
log "   Copies de secours locales : $DATA_ROOT/.pre-restore/ (supprimez-les une fois satisfait :"
log "   for s in $DATA_ROOT/.pre-restore/*; do sudo btrfs subvolume delete \"\$s\" 2>/dev/null || sudo rm -rf \"\$s\"; done )"

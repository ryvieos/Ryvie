#!/usr/bin/env bash
# =====================================================
# Ryvie — Sauvegarde de /data vers une cible externe
# =====================================================
# La donnée utilisateur d'un Ryvie vit dans 4 sous-volumes Btrfs :
#   /data/apps  /data/config  /data/images  /data/netbird
# (docker/, containerd/, snapshot/, logs/ sont reconstructibles → exclus)
#
# Usage :
#   ryvie-backup.sh <cible> [options]
#
#   <cible> :
#     /mnt/usb-backup            → dossier local monté (disque USB, NAS…)
#                                  · cible Btrfs : btrfs send/receive (incrémental)
#                                  · autre FS    : rsync
#     ssh://user@host:/chemin    → machine distante via SSH (btrfs send | receive,
#                                  la cible distante doit être un montage Btrfs)
#
#   Options :
#     --full        Force une sauvegarde complète (ignore l'incrémental)
#     --keep N      Nombre de sauvegardes conservées sur la cible (défaut: 7)
#     --dry-run     Affiche ce qui serait fait, sans rien écrire
#
# Restauration : voir ryvie-restore.sh
# =====================================================
set -euo pipefail

DATA_ROOT="/data"
SNAP_BOOK="$DATA_ROOT/snapshot/backups"   # snapshots locaux servant de parents incrémentaux
SUBVOLS=(apps config images netbird)
KEEP=7
FULL=0
DRY_RUN=0
TARGET=""

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[backup]${NC} $1"; }
warn() { echo -e "${YELLOW}[backup]${NC} $1"; }
die()  { echo -e "${RED}[backup] ❌ $1${NC}" >&2; exit 1; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }

# ---------- Arguments ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --full)    FULL=1 ;;
    --keep)    shift; KEEP="${1:-7}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         [ -z "$TARGET" ] && TARGET="$1" || die "Argument inattendu: $1" ;;
  esac
  shift
done
[ -n "$TARGET" ] || die "Cible manquante. Usage: $0 <cible> [--full] [--keep N] [--dry-run]"

# ---------- Pré-requis ----------
[ "$(id -u)" -eq 0 ] || die "Ce script doit être lancé en root (sudo)."
[ "$(findmnt -no FSTYPE "$DATA_ROOT" 2>/dev/null)" = "btrfs" ] || die "$DATA_ROOT n'est pas en Btrfs."
command -v jq >/dev/null || die "jq est requis."

is_subvol() { btrfs subvolume show "$1" >/dev/null 2>&1; }

for sv in "${SUBVOLS[@]}"; do
  [ -d "$DATA_ROOT/$sv" ] || die "$DATA_ROOT/$sv est introuvable (installation incomplète ?)."
  is_subvol "$DATA_ROOT/$sv" || warn "$DATA_ROOT/$sv est un dossier simple (pas un sous-volume) → envoi complet à chaque fois."
done

# ---------- Analyse de la cible ----------
SSH_HOST=""; SSH_PATH=""; MODE=""
if [[ "$TARGET" == ssh://* ]]; then
  # ssh://user@host:/chemin  ou  ssh://user@host/chemin
  stripped="${TARGET#ssh://}"
  SSH_HOST="${stripped%%[:/]*}"
  SSH_PATH="/${stripped#*[:/]}"
  SSH_PATH="${SSH_PATH#/}"; SSH_PATH="/$SSH_PATH"
  [ -n "$SSH_HOST" ] && [ "$SSH_PATH" != "/" ] || die "Cible SSH invalide: $TARGET (attendu ssh://user@host:/chemin)"
  ssh -o BatchMode=yes "$SSH_HOST" true 2>/dev/null \
    || die "Connexion SSH impossible vers $SSH_HOST (clé SSH requise, pas de mot de passe interactif)."
  remote_fs=$(ssh "$SSH_HOST" "findmnt -no FSTYPE --target '$SSH_PATH' 2>/dev/null" || true)
  [ "$remote_fs" = "btrfs" ] || die "La cible distante $SSH_PATH n'est pas sur un montage Btrfs (fs: ${remote_fs:-inconnu})."
  MODE="ssh-send"
else
  [ -d "$TARGET" ] || die "La cible $TARGET n'existe pas ou n'est pas un dossier."
  target_fs=$(findmnt -no FSTYPE --target "$TARGET")
  if [ "$target_fs" = "btrfs" ]; then MODE="send"; else MODE="rsync"; fi
fi

TS="$(date +%Y-%m-%d_%H%M%S)"
BACKUP_NAME="ryvie-backup-$TS"
log "Cible: $TARGET (mode: $MODE) — sauvegarde: $BACKUP_NAME"

# ---------- 1. Snapshots locaux lecture-seule (cohérents, instantanés) ----------
log "Création des snapshots locaux lecture-seule…"
run mkdir -p "$SNAP_BOOK/$TS"
for sv in "${SUBVOLS[@]}"; do
  if is_subvol "$DATA_ROOT/$sv"; then
    run btrfs subvolume snapshot -r "$DATA_ROOT/$sv" "$SNAP_BOOK/$TS/$sv" >/dev/null
  else
    # Dossier simple → on fabrique un sous-volume lecture-seule (reflink rapide, même FS)
    run btrfs subvolume create "$SNAP_BOOK/$TS/$sv" >/dev/null
    run cp -a --reflink=auto "$DATA_ROOT/$sv/." "$SNAP_BOOK/$TS/$sv/"
    run btrfs property set -ts "$SNAP_BOOK/$TS/$sv" ro true
  fi
done

# Parent incrémental : le snapshot local précédent, s'il existe aussi côté cible
PARENT_TS=""
if [ "$FULL" -eq 0 ]; then
  PARENT_TS=$(find "$SNAP_BOOK" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -v "^$TS$" | sort | tail -1 || true)
fi

# ---------- 2. Transfert ----------
remote_has_parent() { # $1=sv
  case "$MODE" in
    send)     btrfs subvolume show "$TARGET/$PARENT_TS/$1" >/dev/null 2>&1 ;;
    ssh-send) ssh "$SSH_HOST" "btrfs subvolume show '$SSH_PATH/$PARENT_TS/$1'" >/dev/null 2>&1 ;;
    *)        return 1 ;;
  esac
}

case "$MODE" in
  send)
    run mkdir -p "$TARGET/$TS"
    for sv in "${SUBVOLS[@]}"; do
      if [ -n "$PARENT_TS" ] && is_subvol "$DATA_ROOT/$sv" && remote_has_parent "$sv"; then
        log "  → $sv (incrémental depuis $PARENT_TS)"
        if [ "$DRY_RUN" -eq 0 ]; then
          btrfs send -q -p "$SNAP_BOOK/$PARENT_TS/$sv" "$SNAP_BOOK/$TS/$sv" | btrfs receive "$TARGET/$TS"
        else
          echo "  (dry-run) btrfs send -p …/$PARENT_TS/$sv …/$TS/$sv | btrfs receive $TARGET/$TS"
        fi
      else
        log "  → $sv (complet)"
        if [ "$DRY_RUN" -eq 0 ]; then
          btrfs send -q "$SNAP_BOOK/$TS/$sv" | btrfs receive "$TARGET/$TS"
        else
          echo "  (dry-run) btrfs send …/$TS/$sv | btrfs receive $TARGET/$TS"
        fi
      fi
    done
    ;;
  ssh-send)
    run ssh "$SSH_HOST" "mkdir -p '$SSH_PATH/$TS'"
    for sv in "${SUBVOLS[@]}"; do
      if [ -n "$PARENT_TS" ] && is_subvol "$DATA_ROOT/$sv" && remote_has_parent "$sv"; then
        log "  → $sv (incrémental depuis $PARENT_TS, via SSH)"
        [ "$DRY_RUN" -eq 0 ] && btrfs send -q -p "$SNAP_BOOK/$PARENT_TS/$sv" "$SNAP_BOOK/$TS/$sv" | ssh "$SSH_HOST" "btrfs receive '$SSH_PATH/$TS'"
      else
        log "  → $sv (complet, via SSH)"
        [ "$DRY_RUN" -eq 0 ] && btrfs send -q "$SNAP_BOOK/$TS/$sv" | ssh "$SSH_HOST" "btrfs receive '$SSH_PATH/$TS'"
      fi
    done
    ;;
  rsync)
    run mkdir -p "$TARGET/$TS"
    for sv in "${SUBVOLS[@]}"; do
      log "  → $sv (rsync)"
      # --link-dest : dédup avec la sauvegarde précédente (hardlinks) si dispo
      link_opt=()
      [ -n "$PARENT_TS" ] && [ -d "$TARGET/$PARENT_TS/$sv" ] && link_opt=(--link-dest="$TARGET/$PARENT_TS/$sv")
      run rsync -aHAX --numeric-ids --delete "${link_opt[@]}" "$SNAP_BOOK/$TS/$sv/" "$TARGET/$TS/$sv/"
    done
    ;;
esac

# ---------- 3. Manifest ----------
log "Écriture du manifest…"
RYVIE_VERSION=$(git -C /opt/Ryvie describe --tags --always 2>/dev/null || echo "unknown")
APPS_LIST=$(ls -1 "$DATA_ROOT/config/manifests" 2>/dev/null | sed 's/\.json$//' | jq -R . | jq -sc . || echo '[]')
STORAGE_MODE=$(cat "$DATA_ROOT/config/system/storage-mode" 2>/dev/null || echo "unknown")
MANIFEST=$(jq -n \
  --arg date "$TS" \
  --arg host "$(hostname)" \
  --arg machineId "$(cat /etc/machine-id 2>/dev/null || echo unknown)" \
  --arg ryvieVersion "$RYVIE_VERSION" \
  --arg storageMode "$STORAGE_MODE" \
  --arg mode "$MODE" \
  --argjson apps "$APPS_LIST" \
  --argjson subvols "$(printf '%s\n' "${SUBVOLS[@]}" | jq -R . | jq -sc .)" \
  '{date:$date, host:$host, machineId:$machineId, ryvieVersion:$ryvieVersion, storageMode:$storageMode, transferMode:$mode, apps:$apps, subvolumes:$subvols}')
case "$MODE" in
  ssh-send) [ "$DRY_RUN" -eq 0 ] && echo "$MANIFEST" | ssh "$SSH_HOST" "cat > '$SSH_PATH/$TS/manifest.json'" ;;
  *)        [ "$DRY_RUN" -eq 0 ] && echo "$MANIFEST" > "$TARGET/$TS/manifest.json" ;;
esac

# ---------- 4. Rotation ----------
rotate_local() {
  # Ne garder localement QUE le snapshot de cette sauvegarde : c'est lui qui
  # servira de parent au prochain envoi incrémental. Les plus anciens dégagent.
  [ -d "$SNAP_BOOK" ] || return 0
  find "$SNAP_BOOK" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | while read -r old; do
    [ "$old" = "$TS" ] && continue
    log "  rotation locale: suppression du snapshot $old"
    for sv in "${SUBVOLS[@]}"; do
      run btrfs subvolume delete "$SNAP_BOOK/$old/$sv" >/dev/null 2>&1 || true
    done
    run rmdir "$SNAP_BOOK/$old" 2>/dev/null || true
  done
}

rotate_target() {
  local list
  case "$MODE" in
    ssh-send) list=$(ssh "$SSH_HOST" "ls -1 '$SSH_PATH'" | grep -E '^[0-9]{4}-' | sort || true) ;;
    *)        list=$(find "$TARGET" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | grep -E '^[0-9]{4}-' | sort || true) ;;
  esac
  [ -n "$list" ] || return 0
  local count; count=$(echo "$list" | grep -c . || true)
  [ "$count" -le "$KEEP" ] && return 0
  echo "$list" | head -n $((count - KEEP)) | while read -r old; do
    [ -n "$old" ] || continue
    log "  rotation cible: suppression de $old"
    case "$MODE" in
      send)
        for sv in "${SUBVOLS[@]}"; do run btrfs subvolume delete "$TARGET/$old/$sv" >/dev/null 2>&1 || true; done
        run rm -rf "${TARGET:?}/$old"
        ;;
      ssh-send)
        for sv in "${SUBVOLS[@]}"; do run ssh "$SSH_HOST" "btrfs subvolume delete '$SSH_PATH/$old/$sv'" >/dev/null 2>&1 || true; done
        run ssh "$SSH_HOST" "rm -rf '$SSH_PATH/$old'"
        ;;
      rsync)
        run rm -rf "${TARGET:?}/$old"
        ;;
    esac
  done
}

log "Rotation (conservation: $KEEP sauvegardes sur la cible)…"
rotate_local
rotate_target

echo ""
log "✅ Sauvegarde $BACKUP_NAME terminée."
log "   Restauration : sudo bash scripts/backup/ryvie-restore.sh ${SSH_HOST:+ssh://$SSH_HOST:}${SSH_PATH:-$TARGET}/$TS"

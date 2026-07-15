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

# Un snapshot Btrfs N'EST PAS récursif : les sous-volumes imbriqués (ex: apps/rdrive,
# apps/rpictures) apparaissent VIDES dans un snapshot du parent. Il faut donc les
# découvrir et les sauvegarder chacun individuellement, sinon toute la donnée
# applicative (fichiers rDrive, photos rPictures, bases…) est silencieusement perdue.
mangle() { printf '%s' "${1//\//%}"; }   # apps/rdrive -> apps%rdrive (nom plat sûr)

# Liste aplatie des sous-volumes à sauvegarder : chaque top-level + ses imbriqués,
# parents AVANT enfants (l'ordre de découverte le garantit).
declare -a ALL_SVS=()
for sv in "${SUBVOLS[@]}"; do
  [ -d "$DATA_ROOT/$sv" ] || die "$DATA_ROOT/$sv est introuvable (installation incomplète ?)."
  ALL_SVS+=("$sv")
  if is_subvol "$DATA_ROOT/$sv"; then
    # `btrfs subvolume list -o` renvoie les chemins relatifs à la racine du FS
    # (/data en est la racine), ex: "apps/rdrive".
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      [ -e "$DATA_ROOT/$rel" ] && ALL_SVS+=("$rel")
    done < <(btrfs subvolume list -o "$DATA_ROOT/$sv" 2>/dev/null | sed 's/.* path //')
  else
    warn "$DATA_ROOT/$sv est un dossier simple (pas un sous-volume) → envoi complet à chaque fois."
  fi
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
# Chaque sous-volume (imbriqués inclus) est snapshoté SÉPARÉMENT, à plat, sous un
# nom manglé — impossible de nicher un snapshot RO dans un autre snapshot RO.
log "Création des snapshots locaux lecture-seule…"
run mkdir -p "$SNAP_BOOK/$TS"
for rel in "${ALL_SVS[@]}"; do
  m="$(mangle "$rel")"
  if is_subvol "$DATA_ROOT/$rel"; then
    run btrfs subvolume snapshot -r "$DATA_ROOT/$rel" "$SNAP_BOOK/$TS/$m" >/dev/null
  else
    # Dossier simple → on fabrique un sous-volume lecture-seule (reflink rapide, même FS)
    run btrfs subvolume create "$SNAP_BOOK/$TS/$m" >/dev/null
    run cp -a --reflink=auto "$DATA_ROOT/$rel/." "$SNAP_BOOK/$TS/$m/"
    run btrfs property set -ts "$SNAP_BOOK/$TS/$m" ro true
  fi
done

# Parent incrémental : le snapshot local précédent, s'il existe aussi côté cible
PARENT_TS=""
if [ "$FULL" -eq 0 ]; then
  PARENT_TS=$(find "$SNAP_BOOK" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | grep -v "^$TS$" | sort | tail -1 || true)
fi

# ---------- 2. Transfert ----------
# Destination :
#   · rsync    → arbre IMBRIQUÉ ($TARGET/$TS/apps/rdrive) : lisible, portable (ext4/NTFS…)
#   · send/ssh → sous-volumes À PLAT, manglés ($TARGET/$TS/apps%rdrive) : on ne peut pas
#     nicher un sous-volume reçu (RO) sous un autre. Le manifest note le layout pour
#     que la restauration reconstruise l'arborescence.
remote_has_parent() { # $1=mangled
  case "$MODE" in
    send)     btrfs subvolume show "$TARGET/$PARENT_TS/$1" >/dev/null 2>&1 ;;
    ssh-send) ssh "$SSH_HOST" "btrfs subvolume show '$SSH_PATH/$PARENT_TS/$1'" >/dev/null 2>&1 ;;
    *)        return 1 ;;
  esac
}

case "$MODE" in
  send)
    run mkdir -p "$TARGET/$TS"
    for rel in "${ALL_SVS[@]}"; do
      m="$(mangle "$rel")"
      if [ -n "$PARENT_TS" ] && is_subvol "$DATA_ROOT/$rel" && [ -d "$SNAP_BOOK/$PARENT_TS/$m" ] && remote_has_parent "$m"; then
        log "  → $rel (incrémental depuis $PARENT_TS)"
        if [ "$DRY_RUN" -eq 0 ]; then
          btrfs send -q -p "$SNAP_BOOK/$PARENT_TS/$m" "$SNAP_BOOK/$TS/$m" | btrfs receive "$TARGET/$TS"
        else
          echo "  (dry-run) btrfs send -p …/$PARENT_TS/$m …/$TS/$m | btrfs receive $TARGET/$TS"
        fi
      else
        log "  → $rel (complet)"
        if [ "$DRY_RUN" -eq 0 ]; then
          btrfs send -q "$SNAP_BOOK/$TS/$m" | btrfs receive "$TARGET/$TS"
        else
          echo "  (dry-run) btrfs send …/$TS/$m | btrfs receive $TARGET/$TS"
        fi
      fi
    done
    ;;
  ssh-send)
    run ssh "$SSH_HOST" "mkdir -p '$SSH_PATH/$TS'"
    for rel in "${ALL_SVS[@]}"; do
      m="$(mangle "$rel")"
      if [ -n "$PARENT_TS" ] && is_subvol "$DATA_ROOT/$rel" && [ -d "$SNAP_BOOK/$PARENT_TS/$m" ] && remote_has_parent "$m"; then
        log "  → $rel (incrémental depuis $PARENT_TS, via SSH)"
        [ "$DRY_RUN" -eq 0 ] && btrfs send -q -p "$SNAP_BOOK/$PARENT_TS/$m" "$SNAP_BOOK/$TS/$m" | ssh "$SSH_HOST" "btrfs receive '$SSH_PATH/$TS'"
      else
        log "  → $rel (complet, via SSH)"
        [ "$DRY_RUN" -eq 0 ] && btrfs send -q "$SNAP_BOOK/$TS/$m" | ssh "$SSH_HOST" "btrfs receive '$SSH_PATH/$TS'"
      fi
    done
    ;;
  rsync)
    run mkdir -p "$TARGET/$TS"
    for rel in "${ALL_SVS[@]}"; do   # parents avant enfants → le parent crée le dossier vide, l'enfant le remplit
      m="$(mangle "$rel")"
      log "  → $rel (rsync)"
      run mkdir -p "$TARGET/$TS/$rel"
      # --link-dest : dédup avec la sauvegarde précédente (hardlinks) si dispo
      link_opt=()
      [ -n "$PARENT_TS" ] && [ -d "$TARGET/$PARENT_TS/$rel" ] && link_opt=(--link-dest="$TARGET/$PARENT_TS/$rel")
      run rsync -aHAX --numeric-ids --delete "${link_opt[@]}" "$SNAP_BOOK/$TS/$m/" "$TARGET/$TS/$rel/"
    done
    ;;
esac

# ---------- 3. Manifest ----------
log "Écriture du manifest…"
RYVIE_VERSION=$(git -C /opt/Ryvie describe --tags --always 2>/dev/null || echo "unknown")
APPS_LIST=$(ls -1 "$DATA_ROOT/config/manifests" 2>/dev/null | sed 's/\.json$//' | jq -R . | jq -sc . || echo '[]')
STORAGE_MODE=$(cat "$DATA_ROOT/config/system/storage-mode" 2>/dev/null || echo "unknown")
# nested (rsync) : $TS/apps/rdrive   |   flat (send) : $TS/apps%rdrive
[ "$MODE" = "rsync" ] && LAYOUT="nested" || LAYOUT="flat"
MANIFEST=$(jq -n \
  --arg date "$TS" \
  --arg host "$(hostname)" \
  --arg machineId "$(cat /etc/machine-id 2>/dev/null || echo unknown)" \
  --arg ryvieVersion "$RYVIE_VERSION" \
  --arg storageMode "$STORAGE_MODE" \
  --arg mode "$MODE" \
  --arg layout "$LAYOUT" \
  --argjson apps "$APPS_LIST" \
  --argjson subvols "$(printf '%s\n' "${ALL_SVS[@]}" | jq -R . | jq -sc .)" \
  '{date:$date, host:$host, machineId:$machineId, ryvieVersion:$ryvieVersion, storageMode:$storageMode, transferMode:$mode, layout:$layout, apps:$apps, subvolumes:$subvols}')
case "$MODE" in
  ssh-send) [ "$DRY_RUN" -eq 0 ] && echo "$MANIFEST" | ssh "$SSH_HOST" "cat > '$SSH_PATH/$TS/manifest.json'" ;;
  *)        [ "$DRY_RUN" -eq 0 ] && echo "$MANIFEST" > "$TARGET/$TS/manifest.json" ;;
esac

# ---------- 4. Rotation ----------
rotate_local() {
  # Ne garder localement QUE les snapshots de cette sauvegarde : ils serviront de
  # parents au prochain envoi incrémental. Les plus anciens dégagent.
  # Les snapshots de staging sont À PLAT (manglés) → on supprime tout sous-volume du set.
  [ -d "$SNAP_BOOK" ] || return 0
  find "$SNAP_BOOK" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | while read -r old; do
    [ "$old" = "$TS" ] && continue
    log "  rotation locale: suppression du snapshot $old"
    for s in "$SNAP_BOOK/$old"/*; do
      [ -e "$s" ] || continue
      run btrfs subvolume delete "$s" >/dev/null 2>&1 || true
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
        # sous-volumes à plat : supprimer chaque entrée du set (les enfants d'abord)
        for s in $(find "$TARGET/$old" -mindepth 1 -maxdepth 1 -type d | sort -r); do
          run btrfs subvolume delete "$s" >/dev/null 2>&1 || true
        done
        run rm -rf "${TARGET:?}/$old"
        ;;
      ssh-send)
        run ssh "$SSH_HOST" "for s in \$(find '$SSH_PATH/$old' -mindepth 1 -maxdepth 1 -type d | sort -r); do btrfs subvolume delete \"\$s\" >/dev/null 2>&1 || true; done; rm -rf '$SSH_PATH/$old'"
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

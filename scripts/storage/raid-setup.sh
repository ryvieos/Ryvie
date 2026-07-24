#!/usr/bin/env bash
# Installe/met à jour les scripts système de gestion RAID dégradé.
# Appelé par dev.sh et prod.sh à chaque démarrage pour garantir
# que toutes les machines Ryvie ont la dernière version.
set -euo pipefail

# --- 1. BOOT_DEGRADED=true dans initramfs ---
if [ -d /etc/initramfs-tools/conf.d ] && ! grep -qs "BOOT_DEGRADED=true" /etc/initramfs-tools/conf.d/mdadm 2>/dev/null; then
  echo "BOOT_DEGRADED=true" | sudo tee /etc/initramfs-tools/conf.d/mdadm > /dev/null
  sudo update-initramfs -u 2>/dev/null || true
  echo "✅ BOOT_DEGRADED=true configuré"
fi

# --- 2. Script d'assemblage auto au boot ---
ASSEMBLE_SCRIPT="/usr/local/bin/raid-assemble-auto.sh"
sudo tee "$ASSEMBLE_SCRIPT" > /dev/null << 'RAID_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
log(){ echo "[raid-assemble] $*"; }

# Si md0 est déjà actif et fonctionnel, ne rien toucher
if [ -b /dev/md0 ]; then
  ARRAY_SIZE="$(blockdev --getsize64 /dev/md0 2>/dev/null || echo 0)"
  if [ "$ARRAY_SIZE" -gt 0 ]; then
    log "md0 déjà actif ($(( ARRAY_SIZE / 1073741824 )) GiB)"
    if ! findmnt -f /data >/dev/null 2>&1; then
      log "Montage de /data..."
      mount /data 2>/dev/null && log "/data monté" || log "Échec du montage de /data"
    else
      log "/data déjà monté"
    fi
    exit 0
  fi
  log "md0 existe mais taille=0, réassemblage nécessaire"

  # Tentative 1 : activer l'array inactif en place avec --run
  # Évite la race condition stop→udev-reassemble→busy
  log "Tentative d'activation in-place avec mdadm --run..."
  if mdadm --run /dev/md0 2>&1; then
    ARRAY_SIZE="$(blockdev --getsize64 /dev/md0 2>/dev/null || echo 0)"
    if [ "$ARRAY_SIZE" -gt 0 ]; then
      log "md0 activé via --run ($(( ARRAY_SIZE / 1073741824 )) GiB)"
      mdadm --readwrite /dev/md0 2>/dev/null || true
      if ! findmnt -f /data >/dev/null 2>&1; then
        log "Montage de /data..."
        mount /data 2>/dev/null && log "/data monté" || log "Échec du montage de /data"
      fi
      # Mettre à jour mdadm.conf si possible
      if touch /etc/mdadm/.write-test 2>/dev/null; then
        rm -f /etc/mdadm/.write-test
        mdadm --detail --scan 2>/dev/null | grep -v INACTIVE > /etc/mdadm/mdadm.conf 2>/dev/null || true
        update-initramfs -u >/dev/null 2>&1 || true
      fi
      log "Terminé."
      exit 0
    fi
    log "--run OK mais taille toujours 0, passage au réassemblage complet"
  else
    log "--run a échoué, passage au réassemblage complet"
  fi
fi

# S'assurer que mdadm.conf contient la définition de md0
MD_PATTERN="^ARRAY /dev/md/?0[[:space:]]"

if ! grep -qE "$MD_PATTERN" /etc/mdadm/mdadm.conf 2>/dev/null; then
  log "mdadm.conf incomplet, génération…"
  mdadm --examine --scan > /etc/mdadm/mdadm.conf 2>/dev/null || true
fi

MD_UUID="$(grep -E "$MD_PATTERN" /etc/mdadm/mdadm.conf 2>/dev/null | grep -oP 'UUID=\K[^ ]+' || true)"
if [ -z "$MD_UUID" ]; then
  MD_UUID="$(mdadm --examine --scan 2>/dev/null | grep -E "$MD_PATTERN" | grep -oP 'UUID=\K[^ ]+' || true)"
fi
if [ -z "$MD_UUID" ]; then
  log "Impossible de déterminer l'UUID md0 — tentative assemble --scan --run"
  mdadm --assemble --scan --run || true
  if [ -b /dev/md0 ] && ! findmnt -f /data >/dev/null 2>&1; then
    mount /data 2>/dev/null || true
  fi
  exit 0
fi

log "UUID attendu pour md0: $MD_UUID"

# Trouver les disques membres
CANDIDATES=()
while read -r DEV; do
  [ -b "$DEV" ] || continue
  mdadm --examine "$DEV" 2>/dev/null | grep -q "UUID : .*${MD_UUID}" && CANDIDATES+=("$DEV")
done < <(lsblk -rno PATH,TYPE | grep " part$" | cut -d" " -f1)

while read -r DEV; do
  [ -b "$DEV" ] || continue
  mdadm --examine "$DEV" 2>/dev/null | grep -q "UUID : .*${MD_UUID}" && CANDIDATES+=("$DEV")
done < <(lsblk -rno PATH,TYPE | grep " disk$" | cut -d" " -f1)

  if [ "${#CANDIDATES[@]}" -eq 0 ]; then
    log "Aucun membre trouvé — assemble --scan --run"
    mdadm --assemble --scan --run || true
  else
    mapfile -t CANDIDATES < <(printf "%s\n" "${CANDIDATES[@]}" | sort -u)
    log "Membres trouvés: ${CANDIDATES[*]}"

    # Stopper md0 et bloquer udev pour éviter le réassemblage automatique
    if [ -b /dev/md0 ]; then
      # Masquer les règles udev mdadm temporairement
      UDEV_RULE="/lib/udev/rules.d/63-md-raid-arrays.rules"
      UDEV_RULE_BAK="${UDEV_RULE}.raid-setup-bak"
      if [ -f "$UDEV_RULE" ]; then
        mv -f "$UDEV_RULE" "$UDEV_RULE_BAK" 2>/dev/null || true
        udevadm control --reload-rules 2>/dev/null || true
      fi

      mdadm --stop /dev/md0 2>/dev/null || true
      sleep 2
    fi

    if ! mdadm --assemble --run /dev/md0 "${CANDIDATES[@]}" 2>&1; then
      log "Assemblage normal échoué, tentative --force"
      mdadm --assemble --force --run /dev/md0 "${CANDIDATES[@]}" 2>&1 || true
    fi

    # Restaurer les règles udev
    if [ -f "$UDEV_RULE_BAK" ]; then
      mv -f "$UDEV_RULE_BAK" "$UDEV_RULE" 2>/dev/null || true
      udevadm control --reload-rules 2>/dev/null || true
    fi
  fi

mdadm --readwrite /dev/md0 2>/dev/null || true

# Mettre à jour mdadm.conf si le FS racine est inscriptible
if touch /etc/mdadm/.write-test 2>/dev/null; then
  rm -f /etc/mdadm/.write-test
  {
    echo "HOMEHOST <ignore>"
    mdadm --detail --scan 2>/dev/null | grep -v "^INACTIVE-ARRAY"
  } > /etc/mdadm/mdadm.conf 2>/dev/null || true
  update-initramfs -u >/dev/null 2>&1 || true
fi

if [ -b /dev/md0 ] && ! findmnt -f /data >/dev/null 2>&1; then
  log "Montage de /data..."
  mount /data 2>/dev/null && log "/data monté" || log "Échec du montage de /data"
fi

# Auto-réparation : /data doit appartenir à l'utilisateur applicatif.
# Ce script tourne à CHAQUE boot (systemd), contrairement à prod.sh/dev.sh
# que PM2 resurrect court-circuite. Sans ce chown, un /data possédé par root
# fait crasher OpenLDAP (Permission denied) → plus d'assistant première config.
# Non récursif — ne JAMAIS chown -R (volumes Docker).
if findmnt -f /data >/dev/null 2>&1; then
  RYVIE_UID="$(id -u ryvie 2>/dev/null || echo '')"
  DATA_UID="$(stat -c '%u' /data 2>/dev/null || echo '')"
  if [ -n "$RYVIE_UID" ] && [ -n "$DATA_UID" ] && [ "$DATA_UID" != "$RYVIE_UID" ]; then
    log "Correction du propriétaire de /data ($DATA_UID → ryvie $RYVIE_UID, non récursif)"
    chown ryvie:ryvie /data 2>/dev/null || true
  fi
fi

log "Terminé."
RAID_SCRIPT
sudo chmod +x "$ASSEMBLE_SCRIPT"

# --- 3. Service systemd ---
SERVICE_FILE="/etc/systemd/system/raid-assemble-auto.service"
sudo tee "$SERVICE_FILE" > /dev/null << 'SERVICE'
[Unit]
Description=Auto-assemble degraded RAID (/dev/md0) and mount /data
DefaultDependencies=no
After=local-fs-pre.target systemd-udevd.service
Before=local-fs.target
Wants=local-fs-pre.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/raid-assemble-auto.sh
TimeoutSec=60

[Install]
WantedBy=local-fs.target
SERVICE
sudo systemctl daemon-reload
sudo systemctl enable raid-assemble-auto.service 2>/dev/null || true

# --- 4. Si /data n'est pas monté maintenant, tenter l'assemblage ---
if ! findmnt -f /data > /dev/null 2>&1; then
  echo "⚠️  /data non monté — tentative d'assemblage RAID dégradé..."
  sudo "$ASSEMBLE_SCRIPT" 2>&1 || true
fi

# --- 5. Auto-réparation : /data doit appartenir à l'utilisateur applicatif ---
# Un RAID créé par l'ISO d'installation ou une migration peut laisser /data
# possédé par root. Conséquence en cascade : OpenLDAP crashe (Permission
# denied) → check-first-time échoue → l'assistant de première configuration
# ne s'affiche jamais. On corrige à chaque démarrage (non récursif, comme
# install.sh — ne JAMAIS chown -R : cela casserait les volumes Docker).
if findmnt -f /data > /dev/null 2>&1; then
  RYVIE_UID="$(id -u ryvie 2>/dev/null || echo '')"
  DATA_UID="$(stat -c '%u' /data 2>/dev/null || echo '')"
  if [ -n "$RYVIE_UID" ] && [ -n "$DATA_UID" ] && [ "$DATA_UID" != "$RYVIE_UID" ]; then
    echo "🔧 /data appartient à l'UID $DATA_UID au lieu de ryvie ($RYVIE_UID) — correction (non récursive)"
    sudo chown ryvie:ryvie /data 2>/dev/null || true
  fi
fi

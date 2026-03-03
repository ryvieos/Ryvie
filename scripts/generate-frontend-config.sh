#!/bin/bash
# Script pour générer les fichiers JSON de configuration du frontend
# Appelé AVANT le build webpack pour garantir que tous les fichiers sont présents

set -euo pipefail

RYVIE_DIR="/opt/Ryvie"
CONFIG_DIR="$RYVIE_DIR/Ryvie-Front/src/config"

echo "📝 Génération des fichiers de configuration frontend..."

# Créer le dossier config s'il n'existe pas
mkdir -p "$CONFIG_DIR"

# 1. Générer app-ports.json (ports des apps installées)
echo "  → app-ports.json"
if [ ! -f "$CONFIG_DIR/app-ports.json" ]; then
  echo '{}' > "$CONFIG_DIR/app-ports.json"
fi

# 2. Générer apps-versions.json (versions installées)
echo "  → apps-versions.json"
if [ ! -f "$CONFIG_DIR/apps-versions.json" ]; then
  echo '{}' > "$CONFIG_DIR/apps-versions.json"
fi

# 3. Générer all-ports.json (tous les ports système)
echo "  → all-ports.json"
if [ ! -f "$CONFIG_DIR/all-ports.json" ]; then
  cat > "$CONFIG_DIR/all-ports.json" <<'EOF'
{
  "backend": 3002,
  "frontend": 3000,
  "caddy": 80,
  "keycloak": 3005,
  "openldap": 1389,
  "netbird": 3004
}
EOF
fi

# 4. Synchroniser netbird-data.json depuis /data/config si disponible
echo "  → netbird-data.json"
if [ -f "/data/config/netbird/netbird-data.json" ]; then
  cp -f "/data/config/netbird/netbird-data.json" "$CONFIG_DIR/netbird-data.json"
  echo "    ✓ Synchronisé depuis /data/config/netbird/"
elif [ ! -f "$CONFIG_DIR/netbird-data.json" ]; then
  # Créer un fichier vide par défaut
  cat > "$CONFIG_DIR/netbird-data.json" <<'EOF'
{
  "managementUrl": "",
  "setupKey": "",
  "hostname": ""
}
EOF
  echo "    ✓ Fichier par défaut créé"
fi

echo "✅ Fichiers de configuration générés"

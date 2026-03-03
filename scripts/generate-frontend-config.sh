#!/bin/bash
# Script pour initialiser les fichiers JSON de configuration frontend
# Stockés dans /data/config/frontend-view (persistant, servis par le backend)

set -euo pipefail

DATA_CONFIG_DIR="/data/config/frontend-view"

echo "📝 Initialisation des fichiers de configuration frontend..."

# Créer le dossier s'il n'existe pas
mkdir -p "$DATA_CONFIG_DIR"

# 1. Initialiser app-ports.json si absent
if [ ! -f "$DATA_CONFIG_DIR/app-ports.json" ]; then
  echo "  → Création de app-ports.json"
  echo '{}' > "$DATA_CONFIG_DIR/app-ports.json"
fi

# 2. Initialiser apps-versions.json si absent
if [ ! -f "$DATA_CONFIG_DIR/apps-versions.json" ]; then
  echo "  → Création de apps-versions.json"
  echo '{}' > "$DATA_CONFIG_DIR/apps-versions.json"
fi

# 3. Initialiser all-ports.json si absent
if [ ! -f "$DATA_CONFIG_DIR/all-ports.json" ]; then
  echo "  → Création de all-ports.json"
  echo '{}' > "$DATA_CONFIG_DIR/all-ports.json"
fi

# 4. Synchroniser netbird-data.json depuis /data/config/netbird si disponible
if [ -f "/data/config/netbird/netbird-data.json" ]; then
  cp -f "/data/config/netbird/netbird-data.json" "$DATA_CONFIG_DIR/netbird-data.json"
  echo "  → netbird-data.json synchronisé depuis /data/config/netbird/"
elif [ ! -f "$DATA_CONFIG_DIR/netbird-data.json" ]; then
  cat > "$DATA_CONFIG_DIR/netbird-data.json" <<'EOF'
{
  "managementUrl": "",
  "setupKey": "",
  "hostname": ""
}
EOF
  echo "  → netbird-data.json par défaut créé"
fi

echo "✅ Configuration frontend initialisée dans $DATA_CONFIG_DIR"

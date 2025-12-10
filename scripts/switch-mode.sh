#!/bin/bash
# Script pour basculer entre dev et prod

MODE=$1

if [ -z "$MODE" ]; then
  echo "Usage: ./switch-mode.sh [dev|prod]"
  echo ""
  echo "Modes disponibles:"
  echo "  dev  - Mode développement (hot-reload, webpack)"
  echo "  prod - Mode production (optimisé, léger)"
  exit 1
fi

if [ "$MODE" == "dev" ]; then
  /opt/Ryvie/scripts/dev.sh
elif [ "$MODE" == "prod" ]; then
  /opt/Ryvie/scripts/prod.sh
else
  echo "❌ Mode invalide: $MODE"
  echo "Utilisez 'dev' ou 'prod'"
  exit 1
fi

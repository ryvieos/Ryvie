#!/bin/bash
# Script pour démarrer Ryvie en mode PRODUCTION

echo "🏭 Démarrage de Ryvie en mode PRODUCTION..."
echo ""

# Arrêter les processus dev s'ils tournent
pm2 stop ryvie-backend-dev ryvie-frontend-dev 2>/dev/null || true
pm2 delete ryvie-backend-dev ryvie-frontend-dev 2>/dev/null || true

# Synchroniser les fichiers de configuration depuis /data/config
echo "🔄 Synchronisation des fichiers de configuration..."
if [ -f /data/config/backend-view/.env ]; then
  cp /data/config/backend-view/.env /opt/Ryvie/Ryvie-Back/.env
  echo "✅ Fichier .env synchronisé depuis /data/config/backend-view/"
else
  echo "⚠️  Fichier .env non trouvé dans /data/config/backend-view/"
  echo "💡 Le backend risque de ne pas démarrer sans configuration"
fi

# Nettoyer les anciens node_modules pour éviter les problèmes de permissions
echo "🧹 Nettoyage des dépendances obsolètes..."
sudo rm -rf /opt/Ryvie/Ryvie-Back/node_modules
sudo rm -rf /opt/Ryvie/Ryvie-Front/node_modules

# Installer les dépendances backend (avec devDependencies pour tsc)
echo "📦 Installation des dépendances backend..."
cd /opt/Ryvie/Ryvie-Back
npm install --include=dev

# Installer les dépendances frontend (avec devDependencies pour webpack)
echo "📦 Installation des dépendances frontend..."
cd /opt/Ryvie/Ryvie-Front
npm install --include=dev

# Vérifier et corriger les permissions si nécessaire
echo "🔐 Vérification des permissions..."
CURRENT_USER=$(whoami)
if [ "$CURRENT_USER" = "ryvie" ]; then
  # Si on est déjà ryvie, vérifier que tout appartient bien à ryvie
  if [ -d "/opt/Ryvie/Ryvie-Back/node_modules" ]; then
    sudo chown -R ryvie:ryvie /opt/Ryvie/Ryvie-Back/node_modules 2>/dev/null || true
  fi
  if [ -d "/opt/Ryvie/Ryvie-Front/node_modules" ]; then
    sudo chown -R ryvie:ryvie /opt/Ryvie/Ryvie-Front/node_modules 2>/dev/null || true
  fi
  echo "✅ Permissions vérifiées"
fi

# Build backend
echo "📦 Build du backend..."
cd /opt/Ryvie/Ryvie-Back
npm run build
if [ $? -ne 0 ]; then
  echo "❌ Erreur lors du build du backend"
  exit 1
fi

# Build frontend
echo "📦 Build du frontend..."
cd /opt/Ryvie/Ryvie-Front
rm -rf dist
NODE_ENV=production npm run build
if [ $? -ne 0 ]; then
  echo "❌ Erreur lors du build du frontend"
  exit 1
fi

# Arrêter les anciens processus prod s'ils existent
pm2 delete ryvie-backend-prod ryvie-frontend-prod 2>/dev/null || true

# Démarrer les processus prod
echo "🚀 Démarrage des processus..."
pm2 start /opt/Ryvie/ecosystem.config.js --only ryvie-backend-prod,ryvie-frontend-prod

# Sauvegarder la config PM2
pm2 save

echo ""
echo "✅ Ryvie démarré en mode PRODUCTION"
echo ""
echo "📊 Accès:"
echo "  - Frontend: http://localhost:3000"
echo "  - Backend:  http://localhost:3002"
echo ""
echo "💡 Optimisations actives:"
echo "  - Code minifié"
echo "  - Pas de webpack (serveur statique léger)"
echo "  - Consommation CPU/RAM réduite (~170MB vs 2GB en dev)"
echo ""
echo "📝 Logs:"
echo "  pm2 logs ryvie-backend-prod"
echo "  pm2 logs ryvie-frontend-prod"
echo ""
echo "🛑 Arrêter:"
echo "  pm2 stop ryvie-backend-prod ryvie-frontend-prod"

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

# Vérifier et corriger les permissions des node_modules existants si nécessaire
echo "🔍 Vérification des node_modules existants..."
if [ -d "/opt/Ryvie/Ryvie-Back/node_modules" ]; then
  echo "  ✓ node_modules backend trouvé, vérification des permissions..."
  sudo chown -R ryvie:ryvie /opt/Ryvie/Ryvie-Back/node_modules 2>/dev/null || true
fi
if [ -d "/opt/Ryvie/Ryvie-Front/node_modules" ]; then
  echo "  ✓ node_modules frontend trouvé, vérification des permissions..."
  sudo chown -R ryvie:ryvie /opt/Ryvie/Ryvie-Front/node_modules 2>/dev/null || true
fi

# Installer les dépendances backend (avec devDependencies pour tsc)
# npm install mettra à jour uniquement les dépendances modifiées
echo "📦 Installation des dépendances backend..."
cd /opt/Ryvie/Ryvie-Back
if ! npm install --include=dev; then
  echo "❌ Erreur lors de l'installation des dépendances backend"
  exit 1
fi
if [ ! -d "node_modules" ]; then
  echo "❌ Erreur: node_modules du backend non créé"
  exit 1
fi
echo "✅ Dépendances backend installées"

# Installer les dépendances frontend (avec devDependencies pour webpack)
echo "📦 Installation des dépendances frontend..."
cd /opt/Ryvie/Ryvie-Front
if ! npm install --include=dev; then
  echo "❌ Erreur lors de l'installation des dépendances frontend"
  exit 1
fi
if [ ! -d "node_modules" ]; then
  echo "❌ Erreur: node_modules du frontend non créé"
  exit 1
fi
echo "✅ Dépendances frontend installées"

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

# Générer les fichiers de configuration frontend avant le build
echo "📝 Génération des fichiers de configuration frontend..."
bash /opt/Ryvie/scripts/generate-frontend-config.sh
if [ $? -ne 0 ]; then
  echo "⚠️  Avertissement: génération des configs frontend échouée (non critique)"
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

# Réinstaller uniquement les dépendances de production (optimisation)
echo "🧹 Nettoyage des devDependencies pour la production..."
cd /opt/Ryvie/Ryvie-Back
if ! npm prune --production; then
  echo "⚠️  Avertissement: npm prune a échoué pour le backend (non critique)"
fi
cd /opt/Ryvie/Ryvie-Front
if ! npm prune --production; then
  echo "⚠️  Avertissement: npm prune a échoué pour le frontend (non critique)"
fi

# Vérifier que serve est toujours présent après le prune
if [ ! -f "/opt/Ryvie/Ryvie-Front/node_modules/.bin/serve" ] && [ ! -d "/opt/Ryvie/Ryvie-Front/node_modules/serve" ]; then
  echo "❌ ERREUR CRITIQUE: serve a été supprimé par npm prune!"
  echo "🔄 Réinstallation de serve..."
  cd /opt/Ryvie/Ryvie-Front
  npm install serve --save
fi

echo "✅ Environnement de production optimisé"

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

#!/bin/bash
# Script pour rebuilder et redémarrer Ryvie en mode PRODUCTION
# Utile quand vous avez modifié du code et voulez déployer rapidement

echo "🔄 Rebuild et redémarrage en mode PRODUCTION..."
echo ""

# Installer les dépendances backend
echo "📦 Installation des dépendances backend..."
cd /opt/Ryvie/Ryvie-Back
npm install

# Installer les dépendances frontend
echo "📦 Installation des dépendances frontend..."
cd /opt/Ryvie/Ryvie-Front
npm install

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

# Redémarrer les processus prod
echo "🔄 Redémarrage des processus..."
pm2 restart ryvie-backend-prod ryvie-frontend-prod

echo ""
echo "✅ Ryvie mis à jour et redémarré en mode PRODUCTION"
echo ""
echo "📝 Vérifier les logs:"
echo "  pm2 logs ryvie-backend-prod"
echo "  pm2 logs ryvie-frontend-prod"

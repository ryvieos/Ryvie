#!/bin/bash
# Script pour démarrer Ryvie en mode DÉVELOPPEMENT

echo "🚀 Démarrage de Ryvie en mode DÉVELOPPEMENT..."
echo ""
echo "✨ Fonctionnalités actives:"
echo "  - Hot-reload backend (tsc --watch + nodemon)"
echo "  - Hot-reload frontend (webpack-dev-server)"
echo "  - Sourcemaps activés"
echo "  - Logs détaillés"
echo ""

# Arrêter les processus prod s'ils tournent
pm2 stop ryvie-backend-prod ryvie-frontend-prod 2>/dev/null || true
pm2 delete ryvie-backend-prod ryvie-frontend-prod 2>/dev/null || true

# Arrêter les anciens processus dev s'ils existent
pm2 delete ryvie-backend-dev ryvie-frontend-dev 2>/dev/null || true

# Installer les dépendances backend
echo "📦 Installation des dépendances backend..."
cd /opt/Ryvie/Ryvie-Back
npm install

# Installer les dépendances frontend
echo "📦 Installation des dépendances frontend..."
cd /opt/Ryvie/Ryvie-Front
npm install

# Build initial du backend (nécessaire pour nodemon)
echo "📦 Build initial du backend..."
cd /opt/Ryvie/Ryvie-Back
npm run build

# Démarrer les processus dev
echo "🚀 Démarrage des processus..."
pm2 start /opt/Ryvie/ecosystem.config.js --only ryvie-backend-dev,ryvie-frontend-dev

# Sauvegarder la config PM2
pm2 save

echo ""
echo "✅ Ryvie démarré en mode DEV"
echo ""
echo "📊 Accès:"
echo "  - Frontend: http://localhost:3000"
echo "  - Backend:  http://localhost:3002"
echo ""
echo "💡 Hot-reload actif:"
echo "  - Modifiez un fichier .ts ou .js"
echo "  - Sauvegardez (Ctrl+S)"
echo "  - Rechargement automatique !"
echo ""
echo "📝 Logs:"
echo "  pm2 logs ryvie-backend-dev"
echo "  pm2 logs ryvie-frontend-dev"
echo ""
echo "🛑 Arrêter:"
echo "  pm2 stop ryvie-backend-dev ryvie-frontend-dev"

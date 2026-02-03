#!/bin/bash

# Script pour ajouter un nouveau client OAuth à Keycloak
# Usage: ./add-client.sh <client-id> <client-name> <port> [secret]

set -e

CLIENT_ID="$1"
CLIENT_NAME="$2"
PORT="$3"
CLIENT_SECRET="${4:-$(openssl rand -hex 32)}"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_NAME" ] || [ -z "$PORT" ]; then
    echo "Usage: $0 <client-id> <client-name> <port> [secret]"
    echo "Example: $0 rpictures 'rPictures Application' 3013"
    exit 1
fi

REALM_FILE="/opt/Ryvie/keycloak/import/ryvie-realm.json"

echo "🔧 Ajout du client OAuth : $CLIENT_ID"
echo "   Nom: $CLIENT_NAME"
echo "   Port: $PORT"
echo "   Secret: $CLIENT_SECRET"
echo ""

# Créer le nouveau client JSON
NEW_CLIENT=$(cat <<EOF
{
  "clientId": "$CLIENT_ID",
  "name": "$CLIENT_NAME",
  "description": "OAuth client for $CLIENT_NAME",
  "enabled": true,
  "clientAuthenticatorType": "client-secret",
  "secret": "$CLIENT_SECRET",
  "redirectUris": [
    "http://ryvie.local:$PORT/*",
    "http://ryvie.local:$PORT/api/auth/callback",
    "http://*:$PORT/*",
    "http://*:$PORT/api/auth/callback"
  ],
  "webOrigins": [
    "http://ryvie.local:$PORT",
    "http://*:$PORT"
  ],
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": true,
  "publicClient": false,
  "protocol": "openid-connect",
  "attributes": {
    "post.logout.redirect.uris": "http://ryvie.local:$PORT##http://ryvie.local:$PORT/login"
  }
}
EOF
)

# Vérifier si le client existe déjà
if jq -e ".clients[] | select(.clientId == \"$CLIENT_ID\")" "$REALM_FILE" > /dev/null 2>&1; then
    echo "⚠️  Le client '$CLIENT_ID' existe déjà dans la configuration."
    echo "   Voulez-vous le remplacer ? (y/N)"
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
        echo "❌ Annulé."
        exit 0
    fi
    
    # Supprimer l'ancien client
    jq "del(.clients[] | select(.clientId == \"$CLIENT_ID\"))" "$REALM_FILE" > "$REALM_FILE.tmp"
    mv "$REALM_FILE.tmp" "$REALM_FILE"
    echo "🗑️  Ancien client supprimé."
fi

# Ajouter le nouveau client
jq ".clients += [$NEW_CLIENT]" "$REALM_FILE" > "$REALM_FILE.tmp"
mv "$REALM_FILE.tmp" "$REALM_FILE"

echo "✅ Client '$CLIENT_ID' ajouté avec succès !"
echo ""
echo "📋 Configuration pour votre application :"
echo "   OIDC_ISSUER=http://ryvie.local:3005/realms/ryvie"
echo "   OIDC_CLIENT_ID=$CLIENT_ID"
echo "   OIDC_CLIENT_SECRET=$CLIENT_SECRET"
echo "   OIDC_REDIRECT_URI=http://ryvie.local:$PORT/api/auth/callback"
echo ""
echo "🔄 Redémarrez Keycloak pour appliquer les changements :"
echo "   docker compose -f /opt/Ryvie/keycloak/docker-compose.yml restart keycloak"

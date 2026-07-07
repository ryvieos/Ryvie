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

REALM_FILE="/data/config/keycloak/import/ryvie-realm.json"

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
    "*"
  ],
  "webOrigins": [
    "*"
  ],
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": true,
  "publicClient": false,
  "protocol": "openid-connect",
  "attributes": {
    "post.logout.redirect.uris": "+"
  }
}
EOF
)

# Si le client existe déjà, le supprimer automatiquement
if jq -e ".clients[] | select(.clientId == \"$CLIENT_ID\")" "$REALM_FILE" > /dev/null 2>&1; then
    echo "⚠️  Le client '$CLIENT_ID' existe déjà — remplacement automatique."
    jq "del(.clients[] | select(.clientId == \"$CLIENT_ID\"))" "$REALM_FILE" > "$REALM_FILE.tmp"
    mv "$REALM_FILE.tmp" "$REALM_FILE"
    echo "🗑️  Ancien client supprimé du realm JSON."
fi

# Ajouter le nouveau client
jq ".clients += [$NEW_CLIENT]" "$REALM_FILE" > "$REALM_FILE.tmp"
mv "$REALM_FILE.tmp" "$REALM_FILE"

echo "✅ Client '$CLIENT_ID' ajouté au fichier realm JSON."
echo ""

# Appliquer en live via l'API admin Keycloak (si le conteneur tourne)
if docker ps --filter "name=keycloak" --format "{{.Names}}" 2>/dev/null | grep -q "^keycloak$"; then
    echo "🔄 Application en live via l'API admin Keycloak..."
    docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
        --server http://localhost:8080 --realm master \
        --user admin --password "${KEYCLOAK_ADMIN_PASSWORD:-changeme123}" 2>/dev/null

    # Vérifier si le client existe déjà dans Keycloak
    EXISTING_ID=$(docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r ryvie \
        --fields id,clientId 2>/dev/null | grep -B1 "\"$CLIENT_ID\"" | grep '"id"' | sed 's/.*: "\(.*\)".*/\1/')

    if [ -n "$EXISTING_ID" ]; then
        docker exec keycloak /opt/keycloak/bin/kcadm.sh delete "clients/$EXISTING_ID" -r ryvie 2>/dev/null
        echo "   🗑️  Ancien client supprimé de Keycloak."
    fi

    echo "$NEW_CLIENT" | docker exec -i keycloak /opt/keycloak/bin/kcadm.sh create clients -r ryvie -f - 2>/dev/null
    echo "   ✅ Client créé en live dans Keycloak."
else
    echo "⚠️  Keycloak n'est pas en cours d'exécution."
    echo "   Les changements seront appliqués au prochain démarrage."
    echo "   docker compose -f /opt/Ryvie/keycloak/docker-compose.yml restart keycloak"
fi

echo ""
echo "📋 Configuration pour votre application :"
echo "   OIDC_ISSUER=http://ryvie.local/auth/realms/ryvie"
echo "   OIDC_CLIENT_ID=$CLIENT_ID"
echo "   OIDC_CLIENT_SECRET=$CLIENT_SECRET"

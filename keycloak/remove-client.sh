#!/bin/bash

# Script pour supprimer un client OAuth de Keycloak
# Usage: ./remove-client.sh <client-id>

set -e

CLIENT_ID="$1"

if [ -z "$CLIENT_ID" ]; then
    echo "Usage: $0 <client-id>"
    echo "Example: $0 ryvie-rpictures"
    echo ""
    echo "Clients actuels :"
    REALM_FILE="/opt/Ryvie/keycloak/import/ryvie-realm.json"
    if [ -f "$REALM_FILE" ]; then
        jq -r '.clients[] | select(.clientId | startswith("ryvie-")) | "   - \(.clientId) (\(.name // "N/A"))"' "$REALM_FILE"
    fi
    exit 1
fi

REALM_FILE="/opt/Ryvie/keycloak/import/ryvie-realm.json"

# Vérifier que le fichier realm existe
if [ ! -f "$REALM_FILE" ]; then
    echo "❌ Fichier realm introuvable : $REALM_FILE"
    exit 1
fi

# Vérifier que le client existe dans le fichier realm
if ! jq -e ".clients[] | select(.clientId == \"$CLIENT_ID\")" "$REALM_FILE" > /dev/null 2>&1; then
    echo "❌ Le client '$CLIENT_ID' n'existe pas dans la configuration."
    echo ""
    echo "Clients disponibles :"
    jq -r '.clients[] | select(.clientId | startswith("ryvie-")) | "   - \(.clientId) (\(.name // "N/A"))"' "$REALM_FILE"
    exit 1
fi

# Afficher les infos du client
echo "🗑️  Suppression du client OAuth : $CLIENT_ID"
CLIENT_NAME=$(jq -r ".clients[] | select(.clientId == \"$CLIENT_ID\") | .name // \"N/A\"" "$REALM_FILE")
echo "   Nom: $CLIENT_NAME"
echo ""

# Confirmation
echo "⚠️  Êtes-vous sûr de vouloir supprimer ce client ? (y/N)"
read -r response
if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo "❌ Annulé."
    exit 0
fi

# Supprimer du fichier realm JSON
jq "del(.clients[] | select(.clientId == \"$CLIENT_ID\"))" "$REALM_FILE" > "$REALM_FILE.tmp"
mv "$REALM_FILE.tmp" "$REALM_FILE"
echo "✅ Client supprimé du fichier realm JSON."

# Supprimer aussi les rôles client associés s'ils existent
if jq -e ".roles.client[\"$CLIENT_ID\"]" "$REALM_FILE" > /dev/null 2>&1; then
    jq "del(.roles.client[\"$CLIENT_ID\"])" "$REALM_FILE" > "$REALM_FILE.tmp"
    mv "$REALM_FILE.tmp" "$REALM_FILE"
    echo "   Rôles client associés supprimés."
fi

# Supprimer en live via l'API admin Keycloak (si le conteneur tourne)
if docker ps --filter "name=keycloak" --format "{{.Names}}" 2>/dev/null | grep -q "^keycloak$"; then
    echo ""
    echo "🔄 Suppression en live via l'API admin Keycloak..."
    docker exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
        --server http://localhost:8080 --realm master \
        --user admin --password "${KEYCLOAK_ADMIN_PASSWORD:-changeme123}" 2>/dev/null

    # Trouver l'ID interne du client
    EXISTING_ID=$(docker exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r ryvie \
        --fields id,clientId 2>/dev/null | grep -B1 "\"$CLIENT_ID\"" | grep '"id"' | sed 's/.*: "\(.*\)".*/\1/')

    if [ -n "$EXISTING_ID" ]; then
        docker exec keycloak /opt/keycloak/bin/kcadm.sh delete "clients/$EXISTING_ID" -r ryvie 2>/dev/null
        echo "   ✅ Client supprimé en live dans Keycloak."
    else
        echo "   ⚠️  Client non trouvé dans Keycloak (déjà supprimé ?)."
    fi
else
    echo ""
    echo "⚠️  Keycloak n'est pas en cours d'exécution."
    echo "   Les changements seront appliqués au prochain démarrage."
    echo "   docker compose -f /opt/Ryvie/keycloak/docker-compose.yml restart keycloak"
fi

echo ""
echo "✅ Client '$CLIENT_ID' supprimé avec succès."

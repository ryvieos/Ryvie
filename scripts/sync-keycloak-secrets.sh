#!/bin/bash
# Script pour synchroniser les secrets des clients OAuth Keycloak
# avec ceux définis dans le realm JSON (source de vérité).
# Appelé automatiquement au démarrage de la stack (dev.sh / prod.sh).

set -euo pipefail

REALM_FILE="/data/config/keycloak/import/ryvie-realm.json"
KEYCLOAK_ENV="/opt/Ryvie/keycloak/.env"
KCADM="docker exec keycloak /opt/keycloak/bin/kcadm.sh"

# Charger le mot de passe admin Keycloak
if [ -f "$KEYCLOAK_ENV" ]; then
  KEYCLOAK_ADMIN_PASSWORD=$(grep "^KEYCLOAK_ADMIN_PASSWORD=" "$KEYCLOAK_ENV" | cut -d'=' -f2-)
else
  echo "⚠️  [sync-keycloak-secrets] Fichier $KEYCLOAK_ENV introuvable, abandon."
  exit 0
fi

if [ -z "${KEYCLOAK_ADMIN_PASSWORD:-}" ]; then
  echo "⚠️  [sync-keycloak-secrets] KEYCLOAK_ADMIN_PASSWORD non défini, abandon."
  exit 0
fi

if [ ! -f "$REALM_FILE" ]; then
  echo "⚠️  [sync-keycloak-secrets] Fichier realm $REALM_FILE introuvable, abandon."
  exit 0
fi

# Attendre que Keycloak soit prêt (max 120s)
echo "🔄 [sync-keycloak-secrets] Attente de Keycloak..."
MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  if curl -sf --max-time 3 http://localhost:3005/realms/ryvie/.well-known/openid-configuration > /dev/null 2>&1; then
    echo "✅ [sync-keycloak-secrets] Keycloak est prêt (${ELAPSED}s)"
    break
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done

if [ $ELAPSED -ge $MAX_WAIT ]; then
  echo "⚠️  [sync-keycloak-secrets] Timeout: Keycloak non disponible après ${MAX_WAIT}s, abandon."
  exit 0
fi

# Se connecter à l'API admin
echo "🔑 [sync-keycloak-secrets] Connexion à l'API admin Keycloak..."
if ! $KCADM config credentials --server http://localhost:8080 --realm master --user admin --password "$KEYCLOAK_ADMIN_PASSWORD" 2>/dev/null; then
  echo "⚠️  [sync-keycloak-secrets] Impossible de se connecter à l'API admin, abandon."
  exit 0
fi

# Extraire les clients custom du realm JSON (ceux avec un secret défini, hors clients Keycloak internes)
CLIENTS=$(python3 -c "
import json, sys
with open('$REALM_FILE') as f:
    data = json.load(f)
for c in data.get('clients', []):
    cid = c.get('clientId', '')
    secret = c.get('secret', '')
    if secret and cid not in ('account', 'account-console', 'admin-cli', 'broker', 'realm-management', 'security-admin-console'):
        print(f'{cid}|{secret}')
" 2>/dev/null)

if [ -z "$CLIENTS" ]; then
  echo "ℹ️  [sync-keycloak-secrets] Aucun client custom avec secret trouvé dans le realm JSON."
  exit 0
fi

# Pour chaque client, forcer le secret dans Keycloak
SYNC_COUNT=0
while IFS='|' read -r CLIENT_ID CLIENT_SECRET; do
  # Récupérer l'UUID du client dans Keycloak
  CLIENT_UUID=$($KCADM get clients -r ryvie -q "clientId=$CLIENT_ID" --fields id 2>/dev/null | python3 -c "import json,sys; data=json.load(sys.stdin); print(data[0]['id'] if data else '')" 2>/dev/null || echo "")

  if [ -z "$CLIENT_UUID" ]; then
    echo "  ⚠️  Client '$CLIENT_ID' non trouvé dans Keycloak, ignoré."
    continue
  fi

  # Forcer le secret
  if $KCADM update "clients/$CLIENT_UUID" -r ryvie -s "secret=$CLIENT_SECRET" 2>/dev/null; then
    echo "  ✅ Secret synchronisé pour '$CLIENT_ID'"
    SYNC_COUNT=$((SYNC_COUNT + 1))
  else
    echo "  ⚠️  Échec de la synchronisation du secret pour '$CLIENT_ID'"
  fi
done <<< "$CLIENTS"

echo "✅ [sync-keycloak-secrets] $SYNC_COUNT client(s) synchronisé(s)."

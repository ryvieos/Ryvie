#!/bin/bash
set -euo pipefail

echo "================================================="
echo "Ryvie - Application des correctifs d'architecture"
echo "================================================="

DATA_ROOT="${DATA_ROOT:-/data}"

# 1. Verification BTRFS
if ! findmnt -f "$DATA_ROOT" | grep -q btrfs; then
    echo "WARNING: $DATA_ROOT n'est pas en BTRFS."
    echo "Assurez-vous que votre baie est bien montee."
fi

# 2. Creation des reseaux externes manquants
for net in ryvie-network ldap_my_custom_network; do
    if ! sudo docker network ls --format '{{.Name}}' | grep -qx "$net"; then
        echo "Creation du reseau docker: $net"
        sudo docker network create "$net" || true
    else
        echo "OK: $net existe."
    fi
done

# 3. Garantir les repertoires persistants
echo "Verification des repertoires persistants..."
for dir in \
    "$DATA_ROOT/config/ldap/data" \
    "$DATA_ROOT/config/keycloak/postgres" \
    "$DATA_ROOT/config/keycloak/import" \
    "$DATA_ROOT/config/keycloak/themes" \
    "$DATA_ROOT/config/reverse-proxy/data" \
    "$DATA_ROOT/config/reverse-proxy/config" \
    "$DATA_ROOT/config/portainer" \
    "$DATA_ROOT/portainer"; do
    sudo mkdir -p "$dir"
done
echo "OK: repertoires persistants verifies."

# 4. Normalisation du compose LDAP (dual-network: legacy + moderne)
LDAP_COMPOSE="$DATA_ROOT/config/ldap/docker-compose.yml"
LDAP_ENV="$DATA_ROOT/config/ldap/.env"
LDAP_ADMIN_PASSWORD="admin"
LDAP_ROOT="dc=example,dc=org"

if [ -f "$LDAP_ENV" ]; then
    LDAP_ADMIN_PASSWORD=$(grep -oP 'LDAP_ADMIN_PASSWORD=\K.*' "$LDAP_ENV" 2>/dev/null || echo "admin")
fi

if [ -f "$LDAP_COMPOSE" ]; then
    # Extraire les valeurs existantes du compose actuel
    EXISTING_PW=$(grep -oP 'LDAP_ADMIN_PASSWORD=\K[^\s]+' "$LDAP_COMPOSE" 2>/dev/null | head -1 || true)
    EXISTING_ROOT=$(grep -oP 'LDAP_ROOT=\K[^\s]+' "$LDAP_COMPOSE" 2>/dev/null | head -1 || true)
    [ -n "$EXISTING_PW" ] && LDAP_ADMIN_PASSWORD="$EXISTING_PW"
    [ -n "$EXISTING_ROOT" ] && LDAP_ROOT="$EXISTING_ROOT"
fi

NEEDS_FIX=false
if [ -f "$LDAP_COMPOSE" ]; then
    # Verifier si le compose a les deux reseaux et le bind mount correct
    if ! grep -q 'ldap_my_custom_network' "$LDAP_COMPOSE" || \
       ! grep -q 'ryvie-network' "$LDAP_COMPOSE" || \
       ! grep -q '/data/config/ldap/data:/bitnami/openldap' "$LDAP_COMPOSE"; then
        NEEDS_FIX=true
    fi
else
    NEEDS_FIX=true
fi

if [ "$NEEDS_FIX" = true ]; then
    echo "Normalisation du compose LDAP (dual-network + bind mount)..."
    cat > /tmp/ryvie-ldap-compose.yml <<LDAPEOF
version: '3.8'

services:
  openldap:
    image: julescloud/ryvieldap:latest
    container_name: openldap
    environment:
      - LDAP_ADMIN_USERNAME=admin
      - LDAP_ADMIN_PASSWORD=${LDAP_ADMIN_PASSWORD}
      - LDAP_ROOT=${LDAP_ROOT}
    ports:
      - "389:1389"
      - "636:1636"
    networks:
      - ldap_my_custom_network
      - ryvie-network
    volumes:
      - /data/config/ldap/data:/bitnami/openldap
    restart: unless-stopped

networks:
  ldap_my_custom_network:
    external: true
  ryvie-network:
    external: true
LDAPEOF
    sudo cp /tmp/ryvie-ldap-compose.yml "$LDAP_COMPOSE"
    sudo chown root:root "$LDAP_COMPOSE"
    rm -f /tmp/ryvie-ldap-compose.yml
    echo "OK: compose LDAP normalise."
else
    echo "OK: compose LDAP deja conforme."
fi

# 5. Migration de Portainer vers docker-compose
PORTAINER_DIR="$DATA_ROOT/config/portainer"
if [ ! -f "$PORTAINER_DIR/docker-compose.yml" ]; then
    echo "Migration de Portainer vers docker-compose..."
    cat > /tmp/portainer-compose.yml <<PEOF
version: '3.8'

services:
  portainer:
    image: portainer/portainer-ce:latest
    container_name: portainer
    restart: always
    ports:
      - "8000:8000"
      - "9443:9443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - $DATA_ROOT/portainer:/data
PEOF
    sudo mv /tmp/portainer-compose.yml "$PORTAINER_DIR/docker-compose.yml"

    if sudo docker ps -a --format '{{.Names}}' | grep -qx 'portainer'; then
        echo "Remplacement du conteneur Portainer standalone..."
        sudo docker rm -f portainer
    fi

    cd "$PORTAINER_DIR"
    sudo docker compose up -d
    echo "OK: Portainer en stack compose."
else
    echo "OK: Portainer deja versionne."
fi

# 6. Relancer les services core
echo "Redemarrage des services core..."
for dir in "$DATA_ROOT/config/ldap" "/opt/Ryvie/keycloak" "$DATA_ROOT/config/reverse-proxy"; do
    if [ -f "$dir/docker-compose.yml" ]; then
        echo "  -> $(basename "$dir")"
        cd "$dir"
        sudo docker compose up -d
    fi
done

# 7. Rattacher OpenLDAP aux deux reseaux si necessaire
if sudo docker ps --filter "name=^openldap$" --filter "status=running" -q | grep -q .; then
    NETWORKS=$(sudo docker inspect openldap --format '{{json .NetworkSettings.Networks}}' 2>/dev/null || echo "{}")
    for net in ldap_my_custom_network ryvie-network; do
        if ! echo "$NETWORKS" | grep -q "$net"; then
            echo "Connexion d'openldap au reseau $net..."
            sudo docker network connect "$net" openldap 2>/dev/null || true
        fi
    done
fi

echo "================================================="
echo "Architecture corrigee. Pret pour migration stockage."
echo "================================================="

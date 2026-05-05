# Ryvie - Checklist de verification post-migration RAID

Utilise ce fichier apres une migration de disques ou de baie pour confirmer que Ryvie est bien pret a repartir.

## 1. Stockage et montage

- Verifier que `/data` est bien monte.
- Verifier que le point de montage est `btrfs`.
- Verifier que le device attendu correspond bien au nouvel array.
- Verifier que `/data/config`, `/data/apps`, `/data/images` et `/data/logs` existent.

Commandes utiles:

```bash
findmnt /data
lsblk -f
```

## 2. Reseaux Docker

- Verifier que `ryvie-network` existe.
- Verifier que `ldap_my_custom_network` existe pour les apps legacy.
- Verifier qu'OpenLDAP est branche sur les deux reseaux.
- Verifier que Keycloak et Caddy sont sur `ryvie-network`.

Commandes utiles:

```bash
docker network ls
docker inspect openldap --format '{{json .NetworkSettings.Networks}}'
docker inspect keycloak --format '{{json .NetworkSettings.Networks}}'
docker inspect caddy --format '{{json .NetworkSettings.Networks}}'
```

## 3. Services critiques

- OpenLDAP doit demarrer sans erreur et voir ses donnees dans `/data/config/ldap/data`.
- Keycloak doit demarrer avec `keycloak-postgres` et garder ses donnees dans `/data/config/keycloak/postgres`.
- Caddy doit servir le `Caddyfile` depuis `/data/config/reverse-proxy/Caddyfile`.
- Portainer doit utiliser `/data/portainer`.

Commandes utiles:

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Networks}}'
docker inspect openldap --format '{{range .Mounts}}{{println .Destination "<-" .Source "(" .Type ")"}}{{end}}'
docker inspect keycloak-postgres --format '{{range .Mounts}}{{println .Destination "<-" .Source "(" .Type ")"}}{{end}}'
docker inspect caddy --format '{{range .Mounts}}{{println .Destination "<-" .Source "(" .Type ")"}}{{end}}'
docker inspect portainer --format '{{range .Mounts}}{{println .Destination "<-" .Source "(" .Type ")"}}{{end}}'
```

## 4. Compatibilite LDAP legacy

- Confirmer que rDrive, rTransfer et rpictures peuvent toujours joindre LDAP.
- Confirmer que les anciennes stacks qui utilisent `ldap_my_custom_network` n'ont pas casse.
- Confirmer que le compose LDAP a ete normalise par le backend si besoin.

Commandes utiles:

```bash
docker inspect app-rdrive-node --format '{{json .NetworkSettings.Networks}}'
docker inspect app-rpictures-server --format '{{json .NetworkSettings.Networks}}'
docker inspect app-rtransfer --format '{{json .NetworkSettings.Networks}}'
```

## 5. Démarrage Ryvie

- Lancer `dev.sh` ou `prod.sh` selon le mode voulu.
- Confirmer que le backend applique `enforceArchitectureBase()` au boot.
- Confirmer que l'etat `architecture` passe en OK dans le startup tracker.

Points a surveiller:

- le backend doit creer les dossiers persistants manquants si necessaire;
- le backend doit reparer le compose LDAP legacy si necessaire;
- le backend doit rattacher OpenLDAP aux bons reseaux si necessaire;
- aucune erreur critique ne doit bloquer le lancement de Caddy ou Keycloak.

## 6. Validation fonctionnelle

- Ouvrir l'interface Ryvie.
- Verifier que l'etat des services est coherent.
- Verifier que les apps sont visibles et que leurs compose sont reconstruits.
- Verifier que le SSO fonctionne.
- Verifier qu'aucun conteneur critique ne depend d'un volume Docker legacy comme source de verite.

## 7. Critere de succes

La migration est consideree comme reussie si:

- `/data` est monte sur le bon device BTRFS;
- `ryvie-network` et `ldap_my_custom_network` existent;
- OpenLDAP est sur les deux reseaux;
- Keycloak, Caddy et Portainer pointent vers des bind mounts persistants;
- les apps legacy rDrive, rTransfer et rpictures fonctionnent toujours;
- Ryvie demarre sans erreur critique;
- aucun runtime Docker copié n'est necessaire pour relancer la pile.

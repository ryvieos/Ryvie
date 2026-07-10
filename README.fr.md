<p align="center">
 <img src="Ryvie-Front/src/icons/ryvielogo0.png" alt="Ryvie" width="160" />
</p>

<h1 align="center">Ryvie</h1>

<p align="center">
 <b>Votre cloud personnel.</b><br/>
 <sub>Un OS auto-hébergé (source-available) qui transforme un VPS ou une machine physique en cloud privé. Une expérience sans ligne de commande, sans avoir besoin de savoir ce qu'est un serveur. Vos apps, vos fichiers, vos données, gratuitement et sous votre contrôle.</sub>
</p>

<p align="center">
 <a href="README.md">English</a> · <b>Français</b>
</p>

<p align="center">
 <a href="https://github.com/ryvieos/Ryvie/releases"><img alt="Version" src="https://img.shields.io/github/package-json/v/ryvieos/Ryvie?color=6366f1&label=version" /></a>
 <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-RSAL%20v1.1-blue" /></a>
 <a href="https://github.com/ryvieos/Ryvie/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/ryvieos/Ryvie?style=flat&color=f5c518" /></a>
 <a href="https://github.com/ryvieos/Ryvie/network/members"><img alt="Forks" src="https://img.shields.io/github/forks/ryvieos/Ryvie?style=flat" /></a>
 <a href="https://github.com/ryvieos/Ryvie/issues"><img alt="Issues" src="https://img.shields.io/github/issues/ryvieos/Ryvie" /></a>
 <a href="https://github.com/ryvieos/Ryvie/commits"><img alt="Last commit" src="https://img.shields.io/github/last-commit/ryvieos/Ryvie" /></a>
 <a href="CONTRIBUTING.md"><img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen" /></a>
 <a href="https://ryvie.fr"><img alt="Website" src="https://img.shields.io/badge/site-ryvie.fr-6366f1" /></a>
</p>

<p align="center">
 <a href="https://ryvie.fr"> Site</a> ·
 <a href="https://ryvie.fr/docs"> Documentation</a> ·
 <a href="https://ryvie.fr"> Télécharger</a> ·
 <a href="https://github.com/ryvieos/Ryvie/issues"> Signaler un bug</a> ·
 <a href="CONTRIBUTING.md"> Contribuer</a>
</p>

<p align="center">
 <img width="900" alt="Ryvie" src="https://github.com/user-attachments/assets/c432252e-0cf7-46d4-8b3b-8a5e0344003d" />
</p>

<p align="center">
 <i>⭐ Si Ryvie vous plaît, mettez une étoile : ça aide vraiment le projet à gagner en visibilité !</i>
</p>

---

## Sommaire

- [Pourquoi Ryvie ?](#-pourquoi-ryvie-)
- [Fonctionnalités](#-fonctionnalités)
- [Installation](#-installation)
- [Stack technique](#-stack-technique)
- [Architecture](#-architecture)
- [Prérequis](#-prérequis)
- [Contribuer](#-contribuer)
- [Licence](#-licence)
- [Équipe](#-équipe)

---

## ✨ Pourquoi Ryvie ?

Les clouds classiques (Google Drive, iCloud, Dropbox…) sont pratiques mais **louent l'accès à vos propres données** et les hébergent sur des serveurs que vous ne contrôlez pas. Ryvie inverse la logique :

- **Votre propre serveur, sans ligne de commande.** Installez des dizaines d'apps et services open source (photos, drive, CRM, automatisation…) en un clic, sans jamais toucher au terminal.
- **Vos données restent chez vous.** Sur votre matériel, chiffrées, jamais revendues.
- **Simple comme un smartphone.** Un launcher en grille, pas une console d'admin Linux.
- **Multi-utilisateurs avec droits.** Créez des comptes pour votre famille ou votre équipe, chacun avec ses accès et permissions, grâce au SSO centralisé.
- **Accessible partout.** Tunnel VPN privé intégré (Netbird) et génération d'adresse publique, sans ouvrir de ports ni configurer votre box.
- **Déployable où vous voulez.** Sur un VPS ou une machine physique chez vous, via l'OS Ryvie.

> Ryvie, c'est la puissance d'un serveur auto-hébergé avec la simplicité d'un smartphone.

---

## 🚀 Fonctionnalités

| Fonctionnalité | Description |
|---|---|
| **Launcher en grille** | Interface responsive façon smartphone : drag & drop, dossiers, widgets (météo, CPU/RAM, stockage). |
| **App Store auto-hébergé** | Des dizaines d'apps et services open source installables en un clic, sans ligne de commande (détection auto des manifests, icônes, ports). |
| **Gestion multi-utilisateurs** | Plusieurs comptes avec rôles et permissions ; SSO centralisé (Keycloak + LDAP) partagé par toutes vos apps. |
| **Accès à distance + IP publique** | Tunnel VPN privé (Netbird) et génération d'adresse publique pour exposer vos apps, sans ouvrir de port ni configurer votre box. |
| **Stockage RAID géré** | Création/migration de RAID (mdadm), suivi SMART, extension à chaud, déplacement de Docker entre disques/partitions, le tout depuis l'interface. |
| **Passerelle IA privée** | Un fournisseur LLM (LiteLLM) connecté une fois, partagé par vos apps, votre clé jamais exposée. Désactivable pour économiser de la RAM. |
| **Monitoring temps réel** | État du système en direct via Socket.IO. |
| **Personnalisation** | Thèmes, fond d'écran et disposition, par utilisateur. |
| **Déploiement flexible** | Sur un VPS ou une machine physique, via l'OS Ryvie. |

---

## 💻 Installation

> **Tutoriel complet : [ryvie.fr/docs](https://ryvie.fr/docs)**

1. **Installer l'OS Ryvie.** Téléchargez l'image depuis [ryvie.fr](https://ryvie.fr) et installez-la sur un VPS ou une machine physique (mini-PC, serveur, vieux PC…).
2. **Installer le client Ryvie Desktop.** Disponible pour macOS, Windows et Linux sur [ryvie.fr](https://ryvie.fr).
3. **Se connecter.** Ouvrez le client, connectez-vous à votre instance, et gérez vos apps, votre grille et votre espace.

---

## 🛠️ Stack technique

<p>
 <img alt="React" src="https://img.shields.io/badge/React_18-20232a?logo=react&logoColor=61dafb" />
 <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white" />
 <img alt="Node.js" src="https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white" />
 <img alt="Express" src="https://img.shields.io/badge/Express-000?logo=express&logoColor=white" />
 <img alt="Electron" src="https://img.shields.io/badge/Electron-47848f?logo=electron&logoColor=white" />
 <img alt="Socket.IO" src="https://img.shields.io/badge/Socket.IO-010101?logo=socket.io&logoColor=white" />
 <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ed?logo=docker&logoColor=white" />
 <img alt="Keycloak" src="https://img.shields.io/badge/Keycloak-4d4d4d?logo=keycloak&logoColor=white" />
 <img alt="Caddy" src="https://img.shields.io/badge/Caddy-1f88c0?logo=caddy&logoColor=white" />
</p>

---

## 🏗️ Architecture

<p align="center">
 <img width="900" alt="Architecture Ryvie" src="https://github.com/user-attachments/assets/f3cb3336-77f4-47c9-86b0-de1c49169243" />
</p>

- **Backend** (`Ryvie-Back/`) : API Express + Socket.IO, orchestration Docker, SSO (Keycloak/LDAP), stockage RAID, passerelle IA.
- **Frontend** (`Ryvie-Front/`) : React 18 + Electron pour une expérience desktop fluide.
- **Données** (`/data/`) : configuration, manifests d'apps et stockage utilisateur (bind-mounts portables).
- **Reverse proxy** : Caddy (routage des apps, TLS, same-origin).

---

## 📋 Prérequis

| Ressource | Minimum | Recommandé |
|---|---|---|
| **CPU** | 4 cœurs | 4+ cœurs |
| **RAM** | 8 Go | 16 Go |
| **Stockage** | 50 Go | SSD/NVMe + disque(s) pour `/data` |

---

## 🤝 Contribuer

Les contributions sont les bienvenues !

**Avant de contribuer**, lisez le [Guide de contribution](CONTRIBUTING.md) et signez le [CLA](CLA.md) (processus automatisé via le bot CLA Assistant).

- **[Guide de contribution](CONTRIBUTING.md)** : comment mettre en place l'environnement et proposer des changements.
- **[CLA](CLA.md)** : Contributor License Agreement (requis pour toute contribution).
- **Issues** : signalez un bug ou proposez une idée avec un maximum de détails.
- **Pull requests** : créez une branche dédiée et expliquez clairement vos modifications.

Le CLA protège à la fois vous (vous conservez la propriété de votre code) et le projet (maintenance et évolution).

---

## 📄 Licence

Distribué sous la **Ryvie Source-Available License (RSAL) v1.1**. Voir [`LICENSE`](LICENSE) pour les détails.

---

## ⚠️ Disclaimer

Ce projet est fourni **« tel quel »**, sans garantie d'aucune sorte. L'équipe Ryvie ne pourra être tenue responsable des dommages, pertes de données ou indisponibilités résultant de l'utilisation de la plateforme.

---

## 👥 Équipe

- **Jules Maisonnave** ([@maisonnavejul](https://github.com/maisonnavejul)) · *Initial work & Lead Development*
- **Driss Bendahan** ([@thegreenprogrammer](https://github.com/thegreenprogrammer)) · *Infrastructure & DevOps*
- **Paul Quiquempois** ([@Loghin01](https://github.com/Loghin01)) · *Development & CI/CD*

<p align="center">
 <sub>Fait avec ❤️ par l'équipe Ryvie · <a href="https://ryvie.fr">ryvie.fr</a></sub><br/>
 <sub>Une étoile fait toute la différence pour la visibilité du projet.</sub>
</p>

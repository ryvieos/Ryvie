<p align="center">
 <img src="Ryvie-Front/src/icons/ryvielogo0.png" alt="Ryvie" width="160" />
</p>

<h1 align="center">Ryvie, the Self-Hosted Personal Cloud OS</h1>

<p align="center">
 <b>Your personal cloud.</b><br/>
 <sub>A source-available, self-hosted personal cloud OS that turns any VPS or physical machine into your own private cloud. No command line, no need to know what a server is. Your apps, your files, your data, free and fully under your control. A privacy-first alternative to CasaOS, Umbrel and Nextcloud.</sub>
</p>

<p align="center">
 <b>English</b> · <a href="README.fr.md">Français</a>
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
 <a href="https://ryvie.fr"> Website</a> ·
 <a href="https://ryvie.fr/docs"> Documentation</a> ·
 <a href="https://ryvie.fr"> Download</a> ·
 <a href="https://github.com/ryvieos/Ryvie/issues"> Report a bug</a> ·
 <a href="CONTRIBUTING.md"> Contribute</a>
</p>

<p align="center">
 <img width="900" alt="Ryvie self-hosted personal cloud dashboard" src="https://github.com/user-attachments/assets/c432252e-0cf7-46d4-8b3b-8a5e0344003d" />
</p>

<p align="center">
 <i>⭐ If you like Ryvie, star the repo. It genuinely helps the project gain visibility!</i>
</p>

---

## Table of contents

- [Why Ryvie?](#-why-ryvie)
- [Features](#-features)
- [Installation](#-installation)
- [Tech stack](#-tech-stack)
- [Architecture](#-architecture)
- [Requirements](#-requirements)
- [Contributing](#-contributing)
- [License](#-license)
- [Team](#-team)

---

## ✨ Why Ryvie?

Mainstream clouds (Google Drive, iCloud, Dropbox…) are convenient, but they **rent you access to your own data** and store it on servers you don't control. Ryvie flips that model. You self-host everything and own your data.

- **Your own server, no command line.** Install dozens of open-source apps and services (photos, drive, CRM, automation…) in one click, never touching a terminal.
- **Your data stays home.** On your own hardware, encrypted, never sold.
- **As simple as a smartphone.** A grid launcher, not a Linux admin console.
- **Multi-user with permissions.** Create accounts for your family or team, each with its own access and rights, through centralized SSO.
- **Reachable anywhere.** Built-in private VPN tunnel (Netbird) and public-address generation, with no port forwarding and no router config.
- **Deploy anywhere.** On a VPS or a physical machine at home, via the Ryvie OS.

> Ryvie brings the power of a self-hosted server with the simplicity of a smartphone.

**Compared to other self-hosted platforms**, think of Ryvie as a [CasaOS](https://github.com/IceWhaleTech/CasaOS) or [Umbrel](https://github.com/getumbrel/umbrel) alternative, but with built-in centralized SSO, managed RAID storage, an integrated VPN and a private AI gateway out of the box.

---

## 🚀 Features

| Feature | Description |
|---|---|
| **Grid launcher** | Responsive, smartphone-style UI: drag & drop, folders, widgets (weather, CPU/RAM, storage). |
| **Self-hosted app store** | Dozens of open-source apps and services installable in one click, no command line (auto-detects manifests, icons, ports). |
| **Multi-user management** | Multiple accounts with roles and permissions; centralized SSO (Keycloak + LDAP) shared by all your apps. |
| **Remote access + public IP** | Private VPN tunnel (Netbird) and public-address generation to expose your apps, with no port forwarding or router setup. |
| **Managed RAID storage** | Create/migrate RAID arrays (mdadm), SMART monitoring, hot-grow, move Docker across disks/partitions, all from the UI. |
| **Private AI gateway** | Connect one LLM provider (via LiteLLM) once, shared across your apps, your key never exposed. Toggle off to save RAM. |
| **Real-time monitoring** | Live system status over Socket.IO. |
| **Customization** | Per-user themes, wallpaper and layout. |
| **Flexible deployment** | On a VPS or a physical machine, via the Ryvie OS. |

---

## 💻 Installation

> **Full guide: [ryvie.fr/docs](https://ryvie.fr/docs)**

1. **Install the Ryvie OS.** Download the image from [ryvie.fr](https://ryvie.fr) and install it on a VPS or a physical machine (mini-PC, server, old desktop…).
2. **Install the Ryvie Desktop client.** Available for macOS, Windows and Linux at [ryvie.fr](https://ryvie.fr).
3. **Sign in.** Open the client, connect to your instance, and manage your apps, grid and storage.

---

## 🛠️ Tech stack

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
 <img width="900" alt="Ryvie architecture diagram" src="https://github.com/user-attachments/assets/f3cb3336-77f4-47c9-86b0-de1c49169243" />
</p>

- **Backend** (`Ryvie-Back/`): Express + Socket.IO API, Docker orchestration, SSO (Keycloak/LDAP), RAID storage, AI gateway.
- **Frontend** (`Ryvie-Front/`): React 18 + Electron for a smooth desktop experience.
- **Data** (`/data/`): configuration, app manifests and user storage (portable bind-mounts).
- **Reverse proxy**: Caddy (app routing, TLS, same-origin).

---

## 📋 Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| **CPU** | 4 cores | 4+ cores |
| **RAM** | 8 GB | 16 GB |
| **Storage** | 50 GB | SSD/NVMe + disk(s) for `/data` |

---

## 🤝 Contributing

Contributions are welcome!

**Before contributing**, read the [Contributing guide](CONTRIBUTING.md) and sign the [CLA](CLA.md) (automated via the CLA Assistant bot).

- **[Contributing guide](CONTRIBUTING.md)**: how to set up the environment and propose changes.
- **[CLA](CLA.md)**: Contributor License Agreement (required for any contribution).
- **Issues**: report a bug or suggest an idea with as much detail as possible.
- **Pull requests**: create a dedicated branch and clearly explain your changes.

The CLA protects both you (you keep ownership of your code) and the project (maintenance and evolution).

---

## 📄 License

Distributed under the **Ryvie Source-Available License (RSAL) v1.1**. See [`LICENSE`](LICENSE) for details.

---

## ⚠️ Disclaimer

This project is provided **"as is"**, without warranty of any kind. The Ryvie team cannot be held responsible for damages, data loss or downtime resulting from the use of the platform.

---

## 👥 Team

- **Jules Maisonnave** ([@maisonnavejul](https://github.com/maisonnavejul)) · *Initial work & Lead Development*
- **Driss Bendahan** ([@thegreenprogrammer](https://github.com/thegreenprogrammer)) · *Infrastructure & DevOps*
- **Paul Quiquempois** ([@Loghin01](https://github.com/Loghin01)) · *Development & CI/CD*

<p align="center">
 <sub>Made with ❤️ by the Ryvie team · <a href="https://ryvie.fr">ryvie.fr</a></sub><br/>
 <sub>A single star makes a real difference for the project's visibility.</sub>
</p>

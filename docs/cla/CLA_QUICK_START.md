# CLA Quick Start Guide - 5 Minutes Setup

This guide will get your CLA system up and running in **5 minutes**.

## 🚀 Quick Setup (3 Steps)

### Step 1: Create the Signatures Repository (2 minutes)

1. Go to GitHub: https://github.com/organizations/maisonnavejul/repositories/new
   - Or: https://github.com/new if personal account
2. Repository name: `Ryvie-CLA-signatures`
3. Description: "CLA signatures for Ryvie contributors"
4. Visibility: **Private** (recommended)
5. ✅ Initialize with README
6. Click **Create repository**

### Step 2: Create Personal Access Token (2 minutes)

1. Go to: https://github.com/settings/tokens/new
2. Note: `CLA Assistant Token for Ryvie`
3. Expiration: **No expiration** (or 1 year)
4. Select scopes:
   - ✅ `repo` (all checkboxes under repo)
   - ✅ `workflow`
5. Click **Generate token**
6. **COPY THE TOKEN** (you won't see it again!)

### Step 3: Add Token to Repository Secrets (1 minute)

1. Go to: https://github.com/maisonnavejul/Ryvie/settings/secrets/actions
2. Click **New repository secret**
3. Name: `CLA_PAT`
4. Value: [Paste the token from Step 2]
5. Click **Add secret**

## ✅ You're Done!

The CLA system is now active. When someone opens a PR, the bot will automatically:
1. Check if they've signed the CLA
2. Comment with instructions if not signed
3. Record their signature when they sign
4. Unlock the PR for review

## 🧪 Test It (Optional)

Create a test PR from a secondary GitHub account to verify the bot works.

## 📚 Full Documentation

- **Detailed setup**: `.github/CLA_SETUP.md`
- **Launch checklist**: `docs/CLA_LAUNCH_CHECKLIST.md`
- **CLA document**: `CLA.md`
- **Contributing guide**: `CONTRIBUTING.md`

## ❓ Troubleshooting

**Bot doesn't comment?**
- Check that `CLA_PAT` secret is set correctly
- Verify the signatures repository exists
- Check GitHub Actions logs

**Need help?**
- Email: contact@ryvie.fr
- Read: `.github/CLA_SETUP.md`

---

**That's it! Your CLA system is protecting Ryvie's future.** 🎉

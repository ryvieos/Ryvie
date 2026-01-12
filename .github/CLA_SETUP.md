# CLA Assistant Setup Guide for Ryvie Maintainers

This document explains how to set up and maintain the CLA (Contributor License Agreement) system for Ryvie.

## Overview

Ryvie uses **CLA Assistant** to automate the CLA signing process. When contributors submit their first Pull Request, they are automatically prompted to sign the CLA via a GitHub comment.

## Prerequisites

Before the CLA Assistant can work, you need to complete the following setup steps:

### 1. Create a Dedicated Repository for CLA Signatures

The CLA signatures are stored in a **separate repository** to keep them organized and secure.

**Steps:**
1. Create a new GitHub repository: `Ryvie-CLA-signatures`
2. Make it **private** (recommended) or public
3. Initialize it with a README
4. The CLA Assistant will automatically create the signatures file

**Repository URL**: `https://github.com/maisonnavejul/Ryvie-CLA-signatures`

### 2. Create a Personal Access Token (PAT)

The CLA Assistant needs a GitHub Personal Access Token to write signatures to the separate repository.

**Steps:**
1. Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Name it: `CLA Assistant Token`
4. Set expiration: **No expiration** (or set a long expiration and remember to renew)
5. Select the following scopes:
   - ✅ `repo` (Full control of private repositories)
   - ✅ `workflow` (Update GitHub Action workflows)
6. Click "Generate token"
7. **Copy the token immediately** (you won't see it again!)

### 3. Add the PAT as a Repository Secret

**Steps:**
1. Go to the Ryvie repository: `https://github.com/maisonnavejul/Ryvie`
2. Navigate to: **Settings** → **Secrets and variables** → **Actions**
3. Click "New repository secret"
4. Name: `CLA_PAT`
5. Value: Paste the Personal Access Token from step 2
6. Click "Add secret"

### 4. Verify the Workflow Configuration

The CLA workflow is configured in `.github/workflows/cla.yml`. Key settings:

```yaml
remote-organization-name: 'maisonnavejul'
remote-repository-name: 'Ryvie-CLA-signatures'
path-to-document: 'https://github.com/maisonnavejul/Ryvie/blob/main/CLA.md'
path-to-signatures: 'signatures/version1/cla.json'
branch: 'main'
```

**Important**: If you change the organization name or repository name, update these values.

## How It Works

### For Contributors

1. **Contributor opens a PR** → CLA Assistant bot checks if they've signed
2. **If not signed** → Bot comments with instructions and a link to the CLA
3. **Contributor comments**: `I have read the CLA Document and I hereby sign the CLA`
4. **Bot records signature** → Stores in `Ryvie-CLA-signatures/signatures/version1/cla.json`
5. **PR is unlabeled** → Ready for review and merge

### Signature Storage Format

Signatures are stored in JSON format:
```json
{
  "signedContributors": [
    {
      "name": "username",
      "id": 12345678,
      "comment_id": 987654321,
      "created_at": "2025-01-12T14:30:00Z",
      "repoId": 123456789,
      "pullRequestNo": 42
    }
  ]
}
```

## Allowlist

The following accounts are automatically exempt from CLA signing:
- `bot*` - All bot accounts
- `dependabot*` - Dependabot PRs
- `renovate*` - Renovate bot
- `github-actions*` - GitHub Actions

To add more exemptions, update the `allowlist` in `.github/workflows/cla.yml`.

## Troubleshooting

### Problem: Bot doesn't comment on PRs

**Possible causes:**
1. `CLA_PAT` secret is not set or is invalid
2. The PAT doesn't have the correct permissions
3. The `Ryvie-CLA-signatures` repository doesn't exist

**Solution:**
- Verify the PAT in repository secrets
- Check the Actions logs for error messages
- Ensure the signatures repository exists and is accessible

### Problem: "Resource not accessible by integration"

**Cause:** The `GITHUB_TOKEN` doesn't have sufficient permissions.

**Solution:** The workflow already has the correct permissions set:
```yaml
permissions:
  actions: write
  contents: write
  pull-requests: write
  statuses: write
```

### Problem: Contributors can't sign the CLA

**Possible causes:**
1. They're not commenting with the exact phrase
2. They're commenting on the wrong PR
3. Network/GitHub issues

**Solution:**
- Ensure they use: `I have read the CLA Document and I hereby sign the CLA`
- They can also comment `recheck` to trigger the bot again

## Maintenance

### Viewing Signatures

1. Go to the `Ryvie-CLA-signatures` repository
2. Navigate to `signatures/version1/cla.json`
3. View all signed contributors

### Revoking a Signature

If needed, you can manually edit `cla.json` to remove a contributor. However, this is rarely necessary.

### Updating the CLA

If you need to update the CLA terms:

1. Update `CLA.md` with the new version
2. Update the version number in the CLA document
3. Update `path-to-signatures` in the workflow to a new version:
   ```yaml
   path-to-signatures: 'signatures/version2/cla.json'
   ```
4. All contributors will need to re-sign the new version

## Alternative: DCO (Developer Certificate of Origin)

If you prefer a lighter approach, you can use DCO instead:

**Pros:**
- Simpler (just add `Signed-off-by` to commits)
- Used by Linux kernel and many large projects
- No external bot needed

**Cons:**
- Less protective for future license changes
- Harder to enforce automatically
- Not ideal for commercial pivots

**To enable DCO:**
```yaml
use-dco-flag: true
```

However, for Ryvie's "Apple-like" ambitions and potential commercial future, the **full CLA is recommended**.

## Security Considerations

1. **Keep the PAT secure** - Never commit it to the repository
2. **Use a dedicated PAT** - Don't reuse tokens from other projects
3. **Monitor the signatures repository** - Set up notifications for changes
4. **Regular audits** - Periodically review who has signed

## Legal Compliance

The CLA is designed to:
- ✅ Protect Ryvie's ability to change licenses
- ✅ Enable commercial opportunities (sales, acquisitions, etc.)
- ✅ Ensure all code is properly licensed
- ✅ Maintain contributor rights (they keep ownership)

**Important**: This CLA allows Ryvie to:
- Change to a proprietary license
- Sell or transfer the project
- Create commercial versions
- Accept acquisition offers

This flexibility is **crucial** for long-term sustainability and commercial viability.

## Resources

- **CLA Assistant GitHub**: https://github.com/contributor-assistant/github-action
- **CLA Document**: [CLA.md](../CLA.md)
- **Contributing Guide**: [CONTRIBUTING.md](../CONTRIBUTING.md)

## Questions?

For setup issues or questions, contact:
- **Email**: contact@ryvie.fr
- **GitHub Issues**: Open an issue with the `infrastructure` label

---

**Last updated**: January 12, 2025  
**Maintainer**: Ryvie Team

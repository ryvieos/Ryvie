# CLA Launch Checklist for Ryvie

This checklist ensures the CLA (Contributor License Agreement) system is properly configured before accepting external contributions.

## ✅ Pre-Launch Checklist

### 1. Repository Setup

- [ ] **LICENSE file exists** at `/opt/Ryvie/LICENSE`
  - ✅ RSAL v1.1 is in place
  - Contains copyright notice and terms

- [ ] **CLA.md created** at `/opt/Ryvie/CLA.md`
  - ✅ Clear terms for contributors
  - ✅ Explains rights, warranties, and future licensing

- [ ] **CONTRIBUTING.md created** at `/opt/Ryvie/CONTRIBUTING.md`
  - ✅ References CLA requirement
  - ✅ Provides contribution guidelines
  - ✅ Includes code standards and PR process

### 2. GitHub Configuration

- [ ] **Create CLA signatures repository**
  - Repository name: `Ryvie-CLA-signatures`
  - Organization: `maisonnavejul`
  - Visibility: Private (recommended) or Public
  - URL: `https://github.com/maisonnavejul/Ryvie-CLA-signatures`
  - Initialize with README

- [ ] **Generate Personal Access Token (PAT)**
  - Go to: GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
  - Name: `CLA Assistant Token`
  - Expiration: No expiration (or long duration)
  - Scopes required:
    - ✅ `repo` (Full control of private repositories)
    - ✅ `workflow` (Update GitHub Action workflows)
  - **Save the token securely!**

- [ ] **Add PAT as repository secret**
  - Go to: Ryvie repository → Settings → Secrets and variables → Actions
  - Click "New repository secret"
  - Name: `CLA_PAT`
  - Value: [Paste the PAT from previous step]
  - Click "Add secret"

### 3. Workflow Files

- [ ] **CLA workflow exists** at `.github/workflows/cla.yml`
  - ✅ Configured with correct repository names
  - ✅ Custom messages in French
  - ✅ Proper permissions set

- [ ] **PR template exists** at `.github/PULL_REQUEST_TEMPLATE.md`
  - ✅ Includes CLA checkbox
  - ✅ Comprehensive checklist

- [ ] **Issue templates exist** at `.github/ISSUE_TEMPLATE/`
  - ✅ `bug_report.md`
  - ✅ `feature_request.md`

### 4. Documentation

- [ ] **CLA setup guide** at `.github/CLA_SETUP.md`
  - ✅ Detailed maintainer instructions
  - ✅ Troubleshooting section

- [ ] **README updated** to reference CLA
  - ✅ Contributing section mentions CLA
  - ✅ Links to CONTRIBUTING.md and CLA.md

### 5. Testing the CLA Bot

- [ ] **Create a test PR from a secondary account**
  - Fork the repository
  - Make a small change
  - Open a Pull Request
  - Verify the CLA bot comments
  - Sign the CLA
  - Verify the signature is recorded

- [ ] **Check signatures repository**
  - Navigate to `Ryvie-CLA-signatures`
  - Verify `signatures/version1/cla.json` was created
  - Verify your test signature appears

### 6. Communication

- [ ] **Announce CLA requirement**
  - Create a GitHub Discussion or Issue
  - Explain why the CLA is needed
  - Link to CLA.md and CONTRIBUTING.md
  - Set expectations for contributors

- [ ] **Update project website** (if applicable)
  - Add CLA information to ryvie.fr
  - Link to GitHub CLA documentation

## 🚀 Post-Launch Monitoring

### First Week

- [ ] Monitor all new PRs for CLA bot activity
- [ ] Respond to contributor questions about CLA
- [ ] Check GitHub Actions logs for errors
- [ ] Verify signatures are being recorded correctly

### Ongoing

- [ ] Review CLA signatures monthly
- [ ] Renew PAT before expiration (if set)
- [ ] Update CLA version if terms change
- [ ] Audit contributor list quarterly

## 🔧 Configuration Reference

### Current Settings

```yaml
Organization: maisonnavejul
Main Repository: Ryvie
Signatures Repository: Ryvie-CLA-signatures
CLA Document: https://github.com/maisonnavejul/Ryvie/blob/main/CLA.md
Signatures Path: signatures/version1/cla.json
Branch: main
```

### Allowlist (Auto-exempt)

- `bot*`
- `dependabot*`
- `renovate*`
- `github-actions*`

## ❓ Common Questions

### "Why do we need a CLA?"

The CLA is essential for Ryvie's future:
- **Legal clarity**: Ensures all code is properly licensed
- **Commercial flexibility**: Allows license changes, sales, acquisitions
- **Contributor protection**: Contributors keep ownership
- **Project sustainability**: Enables commercial opportunities

### "What if a contributor refuses to sign?"

- Politely explain the importance of the CLA
- Offer to answer questions via email (contact@ryvie.fr)
- If they still refuse, their PR cannot be merged
- Consider if the contribution is critical enough to negotiate

### "Can we change the CLA later?"

Yes, but:
- Update the version number in CLA.md
- Change `path-to-signatures` to a new version (e.g., `version2`)
- All contributors must re-sign the new version
- Communicate changes clearly

## 📞 Support

For issues or questions:
- **Technical issues**: Check `.github/CLA_SETUP.md`
- **Legal questions**: Consult with legal counsel
- **General questions**: contact@ryvie.fr

## 🎯 Success Criteria

The CLA system is successfully deployed when:
- ✅ Bot comments on all new PRs from non-allowlisted users
- ✅ Contributors can sign the CLA via GitHub
- ✅ Signatures are recorded in the signatures repository
- ✅ PRs are automatically unlabeled after signing
- ✅ No errors in GitHub Actions logs

---

**Version**: 1.0  
**Last updated**: January 12, 2025  
**Maintained by**: Ryvie Core Team

---

## 🔐 Security Notes

1. **Never commit the PAT** to any repository
2. **Rotate the PAT** if compromised
3. **Monitor the signatures repository** for unauthorized changes
4. **Keep the CLA_PAT secret** secure in GitHub Secrets
5. **Audit access** to the signatures repository regularly

## 📚 Additional Resources

- [CLA Assistant Documentation](https://github.com/contributor-assistant/github-action)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Open Source Guides](https://opensource.guide/)

---

**Ready to launch? Complete this checklist and start accepting contributions with confidence!** 🚀

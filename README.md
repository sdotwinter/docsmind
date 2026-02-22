# DiffShield - AI-Powered Documentation Review

testingggggg

Automated PR reviews for your documentation. Get instant feedback on markdown changes.

![DiffShield](https://diffshield.onrender.com)

## Features

- **Semantic Diff** - Understands document structure, not just text changes
- **Smart Classification** - Identifies doc types: README, SOP, ADR, Runbook, Pricing, API, Contributing
- **Contextual Checklists** - Review items based on document type
- **Link Validation** - Catches broken internal links
- **GitHub Integration** - Checks + Comments on every PR

## Quick Start

### 1. Install DiffShield

[Install DiffShield on GitHub →](https://github.com/apps/diffshield)

Select the repositories you want to protect.

### 2. Create a PR

Make changes to any `.md` file and open a PR. DiffShield will automatically:

- Analyze the changes
- Classify the document type
- Generate a review checklist
- Post results as a GitHub Check + Comment

## Documentation Types Detected

| Type | Detected By |
|------|--------------|
| README | Installation, setup, usage sections |
| SOP | Steps, procedures, prerequisites |
| ADR | Architecture decisions, status, context |
| Runbook | Incident, alert, troubleshooting |
| Pricing | Tables, tiers, costs |
| API | Endpoints, authentication |
| Contributing | PR guidelines, development setup |

## Example Review

```
📄 DiffShield Review

Document Type: README (85% confidence)

Changes Summary
+3 sections, -1 removed, 2 modified

Findings
✅ Verify installation steps work
✅ Check API examples are correct  
✅ Review 3 new section(s)
⚠️ Verify 1 removed section(s) are intentional
```

## Configuration

DiffShield works out of the box. No configuration required.

## Privacy

DiffShield only reads:
- Markdown files in PRs
- Repository metadata

Your code and data are never accessed.

## Support

- [Report Issues →](https://github.com/sdotwinter/diffshield/issues)
- [Request Features →](https://github.com/sdotwinter/diffshield/discussions)

## Pricing

Free for open source. Commercial pricing coming soon.

---

Built with ❤️ by [Sean](https://github.com/sdotwinter)

# DocSMind - AI Documentation Review for GitHub

AI-powered Markdown documentation review for GitHub PRs.

## Setup

1. Create a GitHub App:
   - Go to https://github.com/settings/apps/new
   - Set Webhook URL to your deployed URL
   - Set Webhook secret (generate a random string)
   - Subscribe to "Pull request" events
   - Required permissions:
     - Repository contents (read)
     - Pull requests (read/write)
     - Issues (read/write)
     - Checks (read/write)
   - Note the App ID and generate a private key

2. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. Install and run:
   ```bash
   npm install
   npm run build
   npm start
   ```

## Environment Variables

| Variable | Description |
|----------|-------------|
| GITHUB_APP_ID | GitHub App ID |
| GITHUB_PRIVATE_KEY | Private key (paste as single line, use \n for newlines) |
| GITHUB_WEBHOOK_SECRET | Webhook secret |
| GITHUB_CLIENT_ID | OAuth client ID |
| GITHUB_CLIENT_SECRET | OAuth client secret |
| PORT | Server port (default: 3000) |

## Deployment

### Render / Fly.io
```bash
# Build for production
npm run build
```

### Render
- Set build command: `npm run build`
- Set start command: `npm start`
- Add all environment variables

## Features

- **Semantic Diff**: Understands document structure, not just text
- **Doc Type Classification**: Identifies SOPs, ADRs, runbooks, pricing docs
- **Smart Review Checklist**: Generates relevant review items based on doc type
- **GitHub Checks**: Posts results as GitHub Check Runs
- **PR Comments**: Adds detailed review comment

## License

MIT

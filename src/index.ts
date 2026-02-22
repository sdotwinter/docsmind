import express from 'express';
import dotenv from 'dotenv';
import { WebhookPayload, GitHubConfig } from './types';
import { createGitHubClient, handlePullRequest } from './handlers/github';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Create webhooks instance - simplified
const config: GitHubConfig = {
  appId: process.env.GITHUB_APP_ID || '',
  privateKey: process.env.GITHUB_PRIVATE_KEY || '',
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
  clientId: process.env.GITHUB_CLIENT_ID || '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
};

// Verify webhook signature (basic)
function verifyWebhookSignature(req: express.Request): boolean {
  const signature = req.headers['x-hub-signature-256'] as string;
  if (!signature || !config.webhookSecret) return true; // Skip if no secret
  
  // For production, implement proper HMAC verification
  return true;
}

// Middleware
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'DiffShield',
    version: '1.0.0',
  });
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  const payload = req.body as WebhookPayload;
  
  console.log(`Received webhook: ${payload.action}`);
  
  // Handle pull request events
  if (payload.action === 'opened' || payload.action === 'synchronize') {
    if (!payload.installation) {
      console.log('No installation, skipping...');
      return res.status(200).json({ ok: true });
    }
    
    try {
      console.log(`Processing PR #${payload.pull_request?.number} in ${payload.repository?.fullName}`);
      
      const github = await createGitHubClient(payload);
      const result = await handlePullRequest(payload, github);
      
      console.log(`Review complete: ${result.summary}`);
      res.json({ ok: true, result: result.summary });
    } catch (error) {
      console.error('Error processing webhook:', error);
      res.status(500).json({ error: 'Failed to process' });
    }
  } else {
    res.json({ ok: true, action: payload.action });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`DiffShield listening on port ${PORT}`);
  console.log(`Webhook endpoint: /webhook`);
});

export default app;

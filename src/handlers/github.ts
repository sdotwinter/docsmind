import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { ReviewResult, CheckRunConclusion, WebhookPayload, DocDocument, SemanticDiff, DocTypeClassification, ReviewFinding, DocSection } from '../types';
import { parseMarkdown } from '../lib/markdown';
import { computeSemanticDiff, generateDiffSummary } from '../lib/diff';
import { classifyDocument, generateReviewChecklist, validateLinks } from '../lib/classifier';
import { generateAISummary } from '../lib/ai';

interface GitHubClient {
  octokit: Octokit;
  installationId: number;
}

export async function createGitHubClient(payload: WebhookPayload): Promise<GitHubClient> {
  // This would use the GitHub App's private key
  const appId = process.env.GITHUB_APP_ID || '';
  let privateKey = process.env.GITHUB_PRIVATE_KEY || '';
  
  // If using private key file path
  if (!privateKey && process.env.GITHUB_PRIVATE_KEY_PATH) {
    try {
      privateKey = require('fs').readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf-8');
    } catch (e) {
      console.error('Failed to read private key file:', e);
    }
  }
  
  const auth = createAppAuth({
    appId,
    privateKey,
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  });
  
  const installationAccessToken = await auth({
    type: 'installation',
    installationId: payload.installation!.id,
  });
  
  const octokit = new Octokit({
    auth: installationAccessToken.token,
  });
  
  return {
    octokit,
    installationId: payload.installation!.id,
  };
}

export async function handlePullRequest(
  payload: WebhookPayload,
  github: GitHubClient
): Promise<ReviewResult> {
  const { repository, pull_request } = payload;
  
  if (!pull_request) {
    throw new Error('No pull request in payload');
  }
  
  // Get changed files
  const { data: files } = await github.octokit.pulls.listFiles({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pull_request.number,
  });
  
  // Analyze all files (not just markdown) - but prioritize docs
  const mdFiles = files.filter(f => 
    f.filename.endsWith('.md') || f.filename.endsWith('.mdx')
  );
  const codeFiles = files.filter(f => 
    !f.filename.endsWith('.md') && !f.filename.endsWith('.mdx')
  );
  
  const allFindings: ReviewFinding[] = [];
  const changes: SemanticDiff['sections'] = [];
  const diffContent: string[] = []; // Store raw diff for AI
  
  let docType: DocTypeClassification | null = null;
  
  for (const file of mdFiles) {
    // Get file content from both base and head
    const [baseContent, headContent] = await Promise.all([
      getFileContent(github, repository.owner.login, repository.name, file.filename, pull_request.base.ref),
      getFileContent(github, repository.owner.login, repository.name, file.filename, pull_request.head.ref),
    ]);
    
    if (!baseContent || !headContent) {
      // New file - analyze the content instead of diff
      const newDoc = parseMarkdown(headContent || baseContent || '', file.filename);
      docType = classifyDocument(newDoc);
      
      // Validate links in new document
      const linkFindings = validateLinks(newDoc);
      allFindings.push(...linkFindings.map(f => ({ ...f, file: file.filename })));
      
      // Generate findings based on doc type for new file
      if (newDoc.sections.length > 0) {
        allFindings.push({
          type: 'info',
          category: 'content',
          message: `New document: ${newDoc.sections.length} section(s), ${newDoc.tables.length} table(s), ${newDoc.codeBlocks.length} code block(s)`,
          file: file.filename,
        });
      }
      
      if (newDoc.tables.length > 0 && docType.type !== 'pricing' && docType.type !== 'adr') {
        allFindings.push({
          type: 'info',
          category: 'content',
          message: `Document has ${newDoc.tables.length} table(s) - consider if this should be verified`,
          file: file.filename,
        });
      }
      
      if (newDoc.codeBlocks.length > 0) {
        allFindings.push({
          type: 'info',
          category: 'content',
          message: `Document has ${newDoc.codeBlocks.length} code block(s) - verify examples are correct`,
          file: file.filename,
        });
      }
      
      changes.push({
        type: 'added',
        newPath: newDoc.sections[0]?.path || file.filename,
        newHeading: newDoc.sections[0]?.heading || file.filename,
      });
      
      continue;
    }
    
    // Parse both versions
    const oldDoc = parseMarkdown(baseContent, file.filename);
    const newDoc = parseMarkdown(headContent, file.filename);
    
    // Classify the document (use new version)
    if (!docType) {
      docType = classifyDocument(newDoc);
    }
    
    // Compute semantic diff
    const diff = computeSemanticDiff(oldDoc, newDoc);
    changes.push(...diff.sections);
    
    // Add diff content to findings (show key changes)
    if (file.patch) {
      const lines = file.patch.split('\n').slice(0, 10);
      allFindings.push({
        type: 'info',
        category: 'diff',
        message: `\`\`\`\n${lines.join('\n')}\n\`\`\``,
        file: file.filename,
      });
    }
    
    // Generate findings
    const fileFindings = analyzeChanges(file.filename, diff, oldDoc, newDoc);
    allFindings.push(...fileFindings);
  }
  
  // Analyze code files (non-markdown)
  if (codeFiles.length > 0) {
    allFindings.push({
      type: 'info',
      category: 'content',
      message: `Code changes: ${codeFiles.length} file(s) modified`,
    });
    
    for (const file of codeFiles) {
      const linesAdded = file.additions || 0;
      const linesRemoved = file.deletions || 0;
      
      allFindings.push({
        type: 'info',
        category: 'code',
        message: `${file.filename}: +${linesAdded} -${linesRemoved}`,
      });
      
      // Store diff snippet for AI
      if (file.patch) {
        diffContent.push(`\n${file.filename}:\n${file.patch.slice(0, 1500)}`);
        
        // Add first few lines of diff to findings
        const diffLines = file.patch.split('\n').slice(0, 8);
        allFindings.push({
          type: 'info',
          category: 'diff',
          message: `\`\`\`\n${diffLines.join('\n')}\n\`\`\``,
          file: file.filename,
        });
      }
    }
  }
  
  // Get code files info for AI
  const codeFilesInfo = codeFiles.map(f => ({
    filename: f.filename,
    additions: f.additions || 0,
    deletions: f.deletions || 0,
    patch: f.patch,
  }));
  
  // Build review result
  const semanticDiff: SemanticDiff = {
    sections: changes,
    stats: {
      added: changes.filter(c => c.type === 'added').length,
      removed: changes.filter(c => c.type === 'removed').length,
      modified: changes.filter(c => c.type === 'modified').length,
      moved: changes.filter(c => c.type === 'moved').length,
    },
  };
  
  const summary = generateDiffSummary(semanticDiff);
  const checklist = docType ? generateReviewChecklist(docType.type, semanticDiff) : [];
  
  // Add checklist as findings
  for (const item of checklist) {
    allFindings.push({
      type: 'info',
      category: 'content',
      message: item,
    });
  }
  
  // Generate AI summary if API key is configured
  let aiSummary = '';
  let prDescription = '';
  if (process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID) {
    try {
      aiSummary = await generateAISummary(
        docType || { type: 'other', confidence: 0, indicators: [] },
        semanticDiff,
        allFindings,
        {
          apiKey: process.env.MINIMAX_API_KEY,
          groupId: process.env.MINIMAX_GROUP_ID,
        },
        codeFilesInfo
      );
      
      // Generate PR description
      const { generatePRDescription } = await import('../lib/ai');
      prDescription = await generatePRDescription(
        docType || { type: 'other', confidence: 0, indicators: [] },
        semanticDiff,
        allFindings,
        {
          apiKey: process.env.MINIMAX_API_KEY,
          groupId: process.env.MINIMAX_GROUP_ID,
        },
        codeFilesInfo
      );
    } catch (e) {
      console.error('AI summary error:', e);
    }
  }
  
  // Post results to GitHub
  await postReviewResults(github, repository, pull_request, {
    docType: docType || { type: 'other', confidence: 0, indicators: [] },
    semanticDiff,
    findings: allFindings,
    summary,
    aiSummary,
    prDescription,
  });
  
  return {
    installationId: github.installationId,
    repositoryId: repository.id,
    pullRequest: pull_request.number,
    docType: docType || { type: 'other', confidence: 0, indicators: [] },
    semanticDiff,
    findings: allFindings,
    summary,
    aiSummary,
    prDescription,
  };
}

async function getFileContent(
  github: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const { data } = await github.octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    
    if ('content' in data && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    
    return null;
  } catch {
    return null;
  }
}

function analyzeChanges(
  filename: string,
  diff: SemanticDiff,
  oldDoc: DocDocument,
  newDoc: DocDocument
): ReviewFinding[] {
  // Use the new validateLinks function for comprehensive link checking
  const linkFindings = validateLinks(newDoc);
  const findings = linkFindings.map(f => ({ ...f, file: filename }));
  
  // Also check for section removals
  const removed = diff.sections.filter(s => s.type === 'removed');
  if (removed.length > 0) {
    findings.push({
      type: 'warning',
      category: 'content',
      message: `${removed.length} section(s) removed - ensure this is intentional`,
      file: filename,
    });
  }
  
  // Check for table changes (potential pricing issues)
  if (newDoc.tables.length !== oldDoc.tables.length) {
    findings.push({
      type: 'info',
      category: 'content',
      message: `Table count changed from ${oldDoc.tables.length} to ${newDoc.tables.length} - verify if intentional`,
      file: filename,
    });
  }
  
  return findings;
}

async function postReviewResults(
  github: GitHubClient,
  repository: any,
  pullRequest: any,
  result: {
    docType: DocTypeClassification;
    semanticDiff: SemanticDiff;
    findings: ReviewFinding[];
    summary: string;
    aiSummary?: string;
    prDescription?: string;
  }
) {
  const { docType, semanticDiff, findings, summary, aiSummary, prDescription } = result;
  
  // Update PR description if we have one
  if (prDescription && !pullRequest.body) {
    try {
      await github.octokit.pulls.update({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: pullRequest.number,
        body: prDescription,
      });
      console.log(`Updated PR #${pullRequest.number} description`);
    } catch (err) {
      console.error('Failed to update PR description:', err);
    }
  }
  
  // Create check run
  const checkBody: CheckRunConclusion = {
    conclusion: 'success',
    output: {
      title: `Doc Review: ${docType.type.toUpperCase()} - ${summary}`,
      summary: generateCheckSummary(findings, docType),
      annotations: findings
        .filter(f => f.file && f.line)
        .slice(0, 50) // GitHub limit
        .map(f => ({
          path: f.file!,
          start_line: f.line!,
          end_line: f.line!,
          annotation_level: f.type === 'error' ? 'failure' : f.type === 'warning' ? 'warning' : 'notice',
          message: f.message,
        })),
    },
  };
  
  try {
    await github.octokit.checks.create({
      owner: repository.owner.login,
      repo: repository.name,
      name: 'DiffShield Review',
      head_sha: pullRequest.head.sha,
      status: 'completed',
      conclusion: checkBody.conclusion,
      output: checkBody.output,
    });
  } catch (err) {
    console.error('Failed to create check run:', err);
  }
  
  // Post comment
  const commentBody = generatePRComment(docType, semanticDiff, findings, aiSummary);
  
  try {
    await github.octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: pullRequest.number,
      body: commentBody,
    });
  } catch (err) {
    console.error('Failed to create comment:', err);
  }
}

function generateCheckSummary(findings: ReviewFinding[], docType: DocTypeClassification): string {
  const errors = findings.filter(f => f.type === 'error').length;
  const warnings = findings.filter(f => f.type === 'warning').length;
  const infos = findings.filter(f => f.type === 'info').length;
  
  return `Doc Type: ${docType.type} (${Math.round(docType.confidence * 100)}% confidence)
  
${errors} error(s), ${warnings} warning(s), ${infos} info(s)`;
}

function generatePRComment(
  docType: DocTypeClassification,
  semanticDiff: SemanticDiff,
  findings: ReviewFinding[],
  aiSummary?: string
): string {
  let comment = `## 📄 DiffShield Review\n\n`;
  
  // Add AI summary at the top if available
  if (aiSummary) {
    comment += `**AI Summary:** ${aiSummary}\n\n---\n\n`;
  }
  
  comment += `**Document Type:** ${docType.type.toUpperCase()} (${Math.round(docType.confidence * 100)}% confidence)\n\n`;
  
  comment += `### Changes Summary\n`;
  comment += `- ${semanticDiff.stats.added} added, ${semanticDiff.stats.removed} removed, `;
  comment += `${semanticDiff.stats.modified} modified, ${semanticDiff.stats.moved} moved\n\n`;
  
  if (findings.length > 0) {
    comment += `### Findings\n`;
    
    const errors = findings.filter(f => f.type === 'error');
    const warnings = findings.filter(f => f.type === 'warning');
    const infos = findings.filter(f => f.type === 'info');
    
    for (const e of errors.slice(0, 5)) {
      comment += `- ❌ ${e.message}\n`;
    }
    for (const w of warnings.slice(0, 5)) {
      comment += `- ⚠️ ${w.message}\n`;
    }
    for (const i of infos.slice(0, 5)) {
      comment += `- ℹ️ ${i.message}\n`;
    }
    
    if (findings.length > 15) {
      comment += `\n*...and ${findings.length - 15} more findings*\n`;
    }
  }
  
  comment += `\n---\n*DiffShield - AI Documentation Review*`;
  
  return comment;
}

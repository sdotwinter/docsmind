import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { ReviewResult, CheckRunConclusion, WebhookPayload, DocDocument, SemanticDiff, DocTypeClassification, ReviewFinding, DocSection, PRContext, V2ReviewOutput } from '../types';
import { parseMarkdown } from '../lib/markdown';
import { computeSemanticDiff, generateDiffSummary, isLikelyMoveOrReorder } from '../lib/diff';
import { classifyDocument, generateReviewChecklist, validateLinks } from '../lib/classifier';
import { generateAISummary, generateV2Review, generateV2PRDescription, generateDeterministicFallback } from '../lib/ai';

interface GitHubClient {
  octokit: Octokit;
  installationId: number;
}

/**
 * Filter out low-value findings to reduce noise
 */
function filterHighSignalFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const lowValuePatterns = [
    /^Code changes:/,
    /^New document:/,
    /^Document has \d+ table/,
    /^Document has \d+ code block/,
    /^Table count changed/,
    /^\+[0-9]+ added/,
    /^Process has been tested/,
    /^SOP includes clear step-by-step/,
    /^README includes/,
  ];
  
  return findings.filter(f => {
    // Keep all errors and warnings
    if (f.type === 'error' || f.type === 'warning') return true;
    
    // Filter out low-value info items
    for (const pattern of lowValuePatterns) {
      if (pattern.test(f.message)) return false;
    }
    
    // Keep info items with actual content-related issues
    return f.category !== 'content' || f.message.length > 50;
  }).slice(0, 20); // Max 20 findings to avoid spam
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
      
      // Store diff snippet for AI (not as finding - curated separately)
      if (file.patch) {
        diffContent.push(`\n${file.filename}:\n${file.patch.slice(0, 1500)}`);
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
  
  // Build PR context for v2 AI review
  const prContext: PRContext = {
    title: pull_request.title,
    body: pull_request.body,
    author: pull_request.user?.login || 'unknown',
    baseRef: pull_request.base.ref,
    headRef: pull_request.head.ref,
    baseSha: pull_request.base.sha,
    headSha: pull_request.head.sha,
  };
  
  // Generate v2 AI review if API key is configured
  let v2Review: V2ReviewOutput | null = null;
  let aiSummary = '';
  let prDescription = '';
  
  if (process.env.MINIMAX_API_KEY && process.env.MINIMAX_GROUP_ID) {
    try {
      // Use v2 review with rich context
      v2Review = await generateV2Review(
        prContext,
        docType || { type: 'other', confidence: 0, indicators: [] },
        semanticDiff,
        allFindings,
        {
          apiKey: process.env.MINIMAX_API_KEY,
          groupId: process.env.MINIMAX_GROUP_ID,
        },
        codeFilesInfo
      );
      
      if (v2Review) {
        aiSummary = v2Review.changeOverview;
        prDescription = await generateV2PRDescription(v2Review);
      } else {
        // Use deterministic fallback when AI parsing fails
        v2Review = generateDeterministicFallback(
          prContext,
          docType || { type: 'other', confidence: 0, indicators: [] },
          semanticDiff,
          allFindings,
          codeFilesInfo
        );
        aiSummary = v2Review.changeOverview;
        prDescription = '';
      }
    } catch (e) {
      console.error('AI summary error:', e);
      // Use deterministic fallback on error
      v2Review = generateDeterministicFallback(
        prContext,
        docType || { type: 'other', confidence: 0, indicators: [] },
        semanticDiff,
        allFindings,
        codeFilesInfo
      );
      aiSummary = v2Review.changeOverview;
      prDescription = '';
    }
  }
  
  // Post results to GitHub (filter low-value findings first)
  const filteredFindings = filterHighSignalFindings(allFindings);
  
  await postReviewResults(github, repository, pull_request, {
    docType: docType || { type: 'other', confidence: 0, indicators: [] },
    semanticDiff,
    findings: filteredFindings,
    summary,
    aiSummary,
    prDescription,
    v2Review,
  });
  
  return {
    installationId: github.installationId,
    repositoryId: repository.id,
    pullRequest: pull_request.number,
    docType: docType || { type: 'other', confidence: 0, indicators: [] },
    semanticDiff,
    findings: filteredFindings,
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
  
  // V3: Check if section removals are likely due to move/reorder
  const removedSections = diff.sections.filter(s => s.type === 'removed');
  const addedSections = diff.sections.filter(s => s.type === 'added');
  const movedSections = diff.sections.filter(s => s.type === 'moved');
  const likelyMoveReorder = isLikelyMoveOrReorder(removedSections, addedSections, movedSections);
  
  // Check for section removals - downgrade to info if likely move/reorder
  if (removedSections.length > 0) {
    findings.push({
      // V3: Downgrade from warning to info if likely move/reorder
      type: likelyMoveReorder ? 'info' : 'warning',
      category: 'content',
      message: likelyMoveReorder
        ? `${removedSections.length} section(s) appear to be reorganized (moved/renamed)`
        : `${removedSections.length} section(s) removed - ensure this is intentional`,
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
    v2Review?: V2ReviewOutput | null;
  }
) {
  const { docType, semanticDiff, findings, summary, aiSummary, prDescription, v2Review } = result;
  
  // Determine verdict and conclusion based on v2Review or findings
  let verdict = 'commented';
  let conclusion: CheckRunConclusion['conclusion'] = 'neutral';
  
  if (v2Review?.verdict) {
    // Use v2 verdict
    const v = v2Review.verdict;
    verdict = v.verdict;
    if (v.verdict === 'approved') {
      conclusion = 'success';
    } else if (v.verdict === 'changes_requested') {
      conclusion = 'failure';
    } else {
      conclusion = 'neutral';
    }
  } else {
    // Fallback: determine from findings
    const errors = findings.filter(f => f.type === 'error');
    const warnings = findings.filter(f => f.type === 'warning');
    
    if (errors.length > 0) {
      verdict = 'changes_requested';
      conclusion = 'failure';
    } else if (warnings.length > 2) {
      verdict = 'commented';
      conclusion = 'neutral';
    } else {
      verdict = 'approved';
      conclusion = 'success';
    }
  }

  // Guardrail: avoid failing checks for low-risk/doc-only feedback.
  const hasErrorFindings = findings.some(f => f.type === 'error');
  const hasHighRisk = (v2Review?.keyRisks || []).some(r => r.severity === 'high');
  if (verdict === 'changes_requested' && !hasErrorFindings && !hasHighRisk) {
    verdict = 'commented';
    conclusion = 'neutral';

    if (v2Review?.verdict) {
      v2Review.verdict = {
        ...v2Review.verdict,
        verdict: 'commented',
        summary: 'Non-blocking review feedback only; no high-severity issues detected.',
      };
    }
  }
  
  // Update PR description if we have one (but don't post as comment)
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
  
  // Build check title based on verdict
  const verdictEmoji = verdict === 'approved' ? '✅' : verdict === 'changes_requested' ? '❌' : '💬';
  const checkTitle = `${verdictEmoji} Doc Review: ${docType.type.toUpperCase()} - ${verdict}`;
  
  // Create check run with verdict-based conclusion
  const checkBody: CheckRunConclusion = {
    conclusion,
    output: {
      title: checkTitle,
      summary: generateCheckSummary(findings, docType, v2Review),
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
  
  // Post comment using v2 format or fallback
  const commentBody = v2Review 
    ? generateV2PRComment(docType, semanticDiff, findings, v2Review)
    : generatePRComment(docType, semanticDiff, findings, aiSummary);
  
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

function generateCheckSummary(findings: ReviewFinding[], docType: DocTypeClassification, v2Review?: V2ReviewOutput | null): string {
  const errors = findings.filter(f => f.type === 'error').length;
  const warnings = findings.filter(f => f.type === 'warning').length;
  const infos = findings.filter(f => f.type === 'info').length;
  
  let summary = `Doc Type: ${docType.type} (${Math.round(docType.confidence * 100)}% doc-type confidence)`;
  
  if (v2Review?.verdict) {
    const v = v2Review.verdict;
    summary += `\nVerdict: ${v.verdict} (${Math.round(v.confidence * 100)}% verdict confidence)\n${v.summary}`;
  }
  
  summary += `\n\n${errors} error(s), ${warnings} warning(s), ${infos} info(s)`;
  
  return summary;
}

function normalizeTextForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMoveReorderRisk(risk: { description?: string; evidence?: string }, semanticDiff: SemanticDiff): boolean {
  const text = `${risk.description || ''} ${risk.evidence || ''}`.toLowerCase();
  const hints = [
    'section(s) removed',
    'removed then re-added',
    'reorganized',
    'moved',
    'renamed',
    'semantic diff shows',
  ];
  const hasHint = hints.some(h => text.includes(h));
  const diffSuggestsReorder = semanticDiff.stats.moved > 0 && semanticDiff.stats.added > 0 && semanticDiff.stats.removed > 0;
  return hasHint && diffSuggestsReorder;
}

function isGenericSpeculativeRisk(risk: { category?: string; description?: string; evidence?: string }, findings: ReviewFinding[]): boolean {
  const desc = (risk.description || '').toLowerCase();
  const evidence = (risk.evidence || '').toLowerCase();

  // Generic categories without concrete file/path evidence should be filtered.
  const genericCategory = ['security', 'performance', 'testing', 'breaking'].includes((risk.category || '').toLowerCase());
  const hasConcreteEvidence = /\b[a-z0-9_\-/]+\.(md|ts|js|tsx|jsx|json|yml|yaml)\b/i.test(evidence)
    || /\bline\b/i.test(evidence)
    || /\bsrc\//.test(evidence);

  if (genericCategory && !hasConcreteEvidence) {
    return true;
  }

  // If description does not map to any detected finding text, treat as speculative.
  const normalizedDesc = normalizeTextForCompare(desc);
  if (!normalizedDesc) return true;

  const matchesFinding = findings.some(f => {
    const msg = normalizeTextForCompare(f.message);
    return msg.includes(normalizedDesc.slice(0, Math.min(40, normalizedDesc.length)))
      || normalizedDesc.includes(msg.slice(0, Math.min(40, msg.length)));
  });

  return !matchesFinding && genericCategory;
}

/**
 * Generate v2 PR comment with structured sections
 * V3.1: stricter contradiction prevention + move/reorder suppression + dedupe
 */
function generateV2PRComment(
  docType: DocTypeClassification,
  semanticDiff: SemanticDiff,
  findings: ReviewFinding[],
  v2Review: V2ReviewOutput
): string {
  const { prIntent, changeOverview, checklist, verdict, prBodySuggestion } = v2Review;

  // Normalize risks before rendering.
  const keyRisks = (v2Review.keyRisks || [])
    .map(risk => {
      if (isMoveReorderRisk(risk, semanticDiff)) {
        return {
          ...risk,
          severity: 'low' as const,
          category: 'docs',
          description: 'Section changes look like a move/reorder rather than destructive removal.',
          suggestion: 'Double-check headings and anchors, but treat as non-blocking documentation reorganization.',
        };
      }
      return risk;
    })
    .filter(risk => !isGenericSpeculativeRisk(risk, findings));
  
  // V3: Verdict emoji and label
  const verdictEmoji = verdict.verdict === 'approved' ? '✅' : verdict.verdict === 'changes_requested' ? '❌' : '💬';
  const verdictLabel = verdict.verdict === 'approved' ? 'APPROVED' : verdict.verdict === 'changes_requested' ? 'CHANGES REQUESTED' : 'COMMENTED';
  
  let comment = `## 🛡️ DiffShield Review\n\n`;
  
  // Verdict header
  comment += `### ${verdictEmoji} **${verdictLabel}** (${Math.round(verdict.confidence * 100)}% verdict confidence)\n`;
  comment += `${verdict.summary}\n\n---\n\n`;
  
  // PR Intent
  comment += `### 🎯 PR Intent\n${prIntent}\n\n`;
  
  // Change Overview
  comment += `### 📝 Change Overview\n`;
  comment += `${changeOverview}\n\n`;
  comment += `**Diff Stats:** +${semanticDiff.stats.added} added, -${semanticDiff.stats.removed} removed, ~${semanticDiff.stats.modified} modified, »${semanticDiff.stats.moved} moved\n\n`;
  
  // Deduplicate risks by normalized description.
  const seenRiskDescriptions = new Set<string>();
  const renderedRisks = keyRisks.filter(risk => {
    const normalized = normalizeTextForCompare(risk.description || '');
    if (!normalized || seenRiskDescriptions.has(normalized)) return false;
    seenRiskDescriptions.add(normalized);
    return true;
  });

  if (renderedRisks.length > 0) {
    comment += `### ⚠️ Key Risks\n`;
    for (const risk of renderedRisks.slice(0, 5)) {
      const severityIcon = risk.severity === 'high' ? '🔴' : risk.severity === 'medium' ? '🟡' : '🟢';
      comment += `${severityIcon} **${risk.severity.toUpperCase()}** [${risk.category}]\n`;
      comment += `> ${risk.description}\n`;
      if (risk.evidence) {
        comment += `*Evidence:* ${risk.evidence}\n`;
      }
      if (risk.suggestion) {
        comment += `*Suggestion:* ${risk.suggestion}\n`;
      }
      comment += `\n`;
    }
    comment += `\n`;
  }
  
  // Reviewer Checklist (top 8 items, prioritized)
  if (checklist.length > 0) {
    comment += `### ✅ Reviewer Checklist\n`;
    for (const item of checklist.slice(0, 8)) {
      const priorityIcon = item.priority === 'required' ? '🔴' : item.priority === 'recommended' ? '🟡' : '⚪';
      comment += `${priorityIcon} [${item.priority.toUpperCase()}] ${item.category}: ${item.item}\n`;
    }
    comment += `\n`;
  }
  
  // Critical findings are only shown for blocking verdicts to avoid mixed signals.
  const criticalFindings = findings
    .filter(f => f.type === 'error')
    .filter(f => {
      const normalizedFinding = normalizeTextForCompare(f.message);
      if (!normalizedFinding) return false;
      for (const risk of renderedRisks) {
        const normalizedRisk = normalizeTextForCompare(risk.description || '');
        if (normalizedRisk && (normalizedRisk.includes(normalizedFinding) || normalizedFinding.includes(normalizedRisk))) {
          return false;
        }
      }
      return true;
    })
    .slice(0, 3);

  if (criticalFindings.length > 0 && verdict.verdict === 'changes_requested') {
    comment += `### 🔍 Critical Findings\n`;
    for (const f of criticalFindings) {
      comment += `❌ ${f.file ? `[${f.file}] ` : ''}${f.message}\n`;
    }
    comment += `\n`;
  }
  
  // PR Body Suggestions (if AI provided updates)
  const prUpdates = prBodySuggestion?.updates || [];
  const prSections = prBodySuggestion?.sections || [];
  if (prUpdates.length > 0 || prSections.length > 0) {
    comment += `### 📋 Suggested PR Body Updates\n`;
    if (prSections.length > 0) {
      comment += `**New Sections:**\n`;
      for (const section of prSections.slice(0, 3)) {
        comment += `- **${section.heading}**: ${section.content.slice(0, 100)}${section.content.length > 100 ? '...' : ''}\n`;
      }
    }
    if (prUpdates.length > 0) {
      comment += `\n**Updates:**\n`;
      for (const update of prUpdates.slice(0, 3)) {
        comment += `- **${update.section}**: ${update.content.slice(0, 100)}${update.content.length > 100 ? '...' : ''}\n`;
      }
    }
    comment += `\n`;
  }
  
  // Doc type footer
  comment += `---\n*Document Type: ${docType.type.toUpperCase()} (${Math.round(docType.confidence * 100)}% doc-type confidence) • DiffShield v2*`;
  
  return comment;
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

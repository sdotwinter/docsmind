import { 
  DocTypeClassification, 
  SemanticDiff, 
  ReviewFinding, 
  PRContext, 
  FileChangeSummary, 
  V2ReviewOutput,
  RiskItem,
  ReviewerChecklistItem,
  V2Verdict,
  PRBodySuggestion,
  SectionChange
} from '../types';

// MiniMax API for AI summaries
const MINIMAX_API_URL = 'https://api.minimax.io/v1/text/chatcompletion_v2';

interface MiniMaxConfig {
  apiKey: string;
  groupId: string;
}

interface CodeFileInfo {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Extract high-signal hunks from code patches (first 3-5 most relevant)
 */
function extractHighSignalHunks(codeFiles: CodeFileInfo[]): string {
  if (!codeFiles || codeFiles.length === 0) {
    return 'No code changes';
  }

  // Prioritize files with more changes and files that look important
  const sortedFiles = [...codeFiles]
    .filter(f => f.patch)
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, 4);

  const hunks: string[] = [];
  for (const file of sortedFiles) {
    const lines = file.patch!.split('\n').slice(0, 30); // First 30 lines of patch
    hunks.push(`\`${file.filename}\` (+${file.additions}/-${file.deletions}):\n\`\`\`diff\n${lines.join('\n')}\n\`\`\``);
  }

  return hunks.join('\n\n') || 'No significant code hunks';
}

/**
 * Generate a rich context prompt for v2 PR review
 */
function buildRichPrompt(
  prContext: PRContext,
  docType: DocTypeClassification,
  semanticDiff: SemanticDiff,
  findings: ReviewFinding[],
  codeFiles: CodeFileInfo[]
): string {
  const { title, body, author, baseRef, headRef, baseSha, headSha } = prContext;
  
  // Build files summary (focused on docs + code split)
  const docFiles = codeFiles.filter(f => f.filename.endsWith('.md') || f.filename.endsWith('.mdx'));
  const codeFileCount = codeFiles.length - docFiles.length;
  const filesSummary = codeFiles.length > 0
    ? codeFiles.map(f => `${f.filename}: +${f.additions}/-${f.deletions}`).join('\n')
    : 'No code files changed';
  
  // Build semantic diff summary
  const diffStats = semanticDiff.stats;
  const sectionChanges = semanticDiff.sections.slice(0, 8).map((s: SectionChange) => {
    if (s.type === 'added') return `+ ${s.newHeading} (added)`;
    if (s.type === 'removed') return `- ${s.oldHeading} (removed)`;
    if (s.type === 'modified') return `~ ${s.newHeading} (modified)`;
    return `» ${s.newHeading} (moved)`;
  }).join('\n');
  
  // Build high-signal findings (errors and warnings only, max 8)
  const highSignalFindings = findings
    .filter(f => f.type === 'error' || f.type === 'warning')
    .slice(0, 8)
    .map(f => `[${f.type.toUpperCase()}] ${f.file || 'general'}: ${f.message}`)
    .join('\n');

  // Extract curated code hunks
  const codeHunks = extractHighSignalHunks(codeFiles);
  
  // Build PR refs summary
  const prRefs = `base: \`${baseRef}\` (${baseSha.slice(0, 7)}) → head: \`${headRef}\` (${headSha.slice(0, 7)})`;
  
  // Build the rich prompt
  const prompt = `You are an expert code reviewer analyzing a GitHub Pull Request.

## PR Metadata
- **Title:** ${title}
- **Author:** ${author}
- **Refs:** ${prRefs}

## PR Description
${body || '(no description provided)'}

## Document Classification
- **Type:** ${docType.type} (${Math.round(docType.confidence * 100)}% confidence)
- **Indicators:** ${docType.indicators?.slice(0, 3).join(', ') || 'none'}

## Changed Files (${codeFiles.length} total, ${codeFileCount} code files)
${filesSummary}

## Semantic Diff Stats
- Sections: +${diffStats.added} added, -${diffStats.removed} removed, ~${diffStats.modified} modified, »${diffStats.moved} moved

## Key Section Changes (documentation)
${sectionChanges || 'No section-level changes detected'}

## High-Signal Findings (Errors & Warnings only)
${highSignalFindings || 'No critical issues found'}

## Code Changes (curated hunks)
${codeHunks}

Based on this context, generate a structured PR review with the following JSON format:

{
  "prIntent": "2-3 sentence description of what this PR is trying to accomplish from the author's perspective",
  "changeOverview": "Brief summary of what changed and why it matters",
  "keyRisks": [
    {
      "severity": "high|medium|low",
      "category": "security|breaking|docs|performance|testing",
      "description": "What the risk is",
      "evidence": "Specific line/file that demonstrates the risk",
      "suggestion": "How to address or mitigate this risk"
    }
  ],
  "checklist": [
    {
      "category": "security|docs|testing|performance",
      "item": "Specific checklist item",
      "priority": "required|recommended|optional"
    }
  ],
  "prBodySuggestion": {
    "sections": [
      {
        "heading": "Section heading",
        "content": "Section content"
      }
    ],
    "updates": [
      {
        "section": "Section name to add/update",
        "content": "What content should be added or modified"
      }
    ]
  },
  "verdict": {
    "verdict": "approved|changes_requested|commented",
    "confidence": 0.0-1.0,
    "summary": "One sentence verdict summary"
  }
}

Respond ONLY with valid JSON, no additional text.`;

  return prompt;
}

/**
 * Parse AI response into structured V2ReviewOutput
 */
function parseV2Response(aiResponse: string): V2ReviewOutput | null {
  try {
    // Try to extract JSON from response
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON found in AI response');
      return null;
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    // Validate required fields
    if (!parsed.prIntent || !parsed.changeOverview || !parsed.verdict) {
      console.error('Missing required fields in parsed response');
      return null;
    }
    
    // Validate verdict type
    const validVerdicts = ['approved', 'changes_requested', 'commented'];
    const verdict = parsed.verdict.verdict || 'commented';
    if (!validVerdicts.includes(verdict)) {
      console.error('Invalid verdict:', verdict);
      return null;
    }
    
    // V3: Validate confidence is a number between 0 and 1
    const rawConfidence = parsed.verdict.confidence ?? 0.5;
    if (typeof rawConfidence !== 'number' || rawConfidence < 0 || rawConfidence > 1) {
      console.error('Invalid confidence:', rawConfidence);
      return null;
    }

    // V3: Calibrate confidence - cap at 0.85 unless evidence is strong
    const errors = parsed.keyRisks?.filter((r: RiskItem) => r.severity === 'high') || [];
    const hasConsistentFindings = errors.length > 0;
    const calibratedConfidence = hasConsistentFindings && rawConfidence > 0.85
      ? Math.min(rawConfidence, 0.92)  // Cap at 0.92 for strong evidence
      : Math.min(rawConfidence, 0.82); // Cap at 0.82 for docs-only/mild cases
    
    const normalizedConfidence = Math.max(0, Math.min(1, calibratedConfidence));
    const finalConfidence = verdict === 'approved'
      ? Math.min(normalizedConfidence, 0.82)
      : normalizedConfidence;

    return {
      prIntent: parsed.prIntent,
      changeOverview: parsed.changeOverview,
      keyRisks: parsed.keyRisks || [],
      checklist: parsed.checklist || [],
      prBodySuggestion: {
        sections: parsed.prBodySuggestion?.sections || [],
        updates: parsed.prBodySuggestion?.updates || [],
      },
      verdict: {
        verdict,
        confidence: finalConfidence,
        summary: parsed.verdict.summary || '',
      },
    };
  } catch (error) {
    console.error('Failed to parse V2 response:', error);
    return null;
  }
}

/**
 * Generate v2 AI summary with rich context
 */
export async function generateV2Review(
  prContext: PRContext,
  docType: DocTypeClassification,
  semanticDiff: SemanticDiff,
  findings: ReviewFinding[],
  config: MiniMaxConfig,
  codeFiles?: CodeFileInfo[]
): Promise<V2ReviewOutput | null> {
  const { apiKey, groupId } = config;
  
  if (!apiKey || !groupId) {
    return null;
  }
  
  const prompt = buildRichPrompt(prContext, docType, semanticDiff, findings, codeFiles || []);
  
  try {
    const response = await fetch(MINIMAX_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.5',
        messages: [{ role: 'user', content: prompt }],
        group_id: groupId,
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });
    
    if (!response.ok) {
      console.error('MiniMax API error:', response.status);
      return null;
    }
    
    const data = await response.json() as any;
    const aiResponse = data.choices?.[0]?.message?.content || '';
    
    return parseV2Response(aiResponse);
  } catch (error) {
    console.error('MiniMax error:', error);
    return null;
  }
}

/**
 * Generate v2 PR description suggestion
 */
export async function generateV2PRDescription(
  v2Output: V2ReviewOutput
): Promise<string> {
  const { prBodySuggestion } = v2Output;
  
  if (!prBodySuggestion.sections.length) {
    return '';
  }
  
  const sections = prBodySuggestion.sections
    .map(s => `## ${s.heading}\n\n${s.content}`)
    .join('\n\n');
  
  return sections;
}

/**
 * Generate deterministic fallback v2 review when AI fails
 */
export function generateDeterministicFallback(
  prContext: PRContext,
  docType: DocTypeClassification,
  semanticDiff: SemanticDiff,
  findings: ReviewFinding[],
  codeFiles?: CodeFileInfo[]
): V2ReviewOutput {
  const errors = findings.filter(f => f.type === 'error');
  const warnings = findings.filter(f => f.type === 'warning');
  
  // Determine verdict based on findings
  let verdict: V2Verdict['verdict'] = 'approved';
  let rawConfidence = 0.9;
  let verdictSummary = 'No critical issues detected in documentation changes.';
  
  if (errors.length > 0) {
    verdict = 'changes_requested';
    rawConfidence = 0.95;
    verdictSummary = `${errors.length} error(s) must be addressed before merging.`;
  } else if (warnings.length > 3) {
    verdict = 'commented';
    rawConfidence = 0.7;
    verdictSummary = `${warnings.length} warnings should be reviewed.`;
  } else if (warnings.length > 0) {
    verdict = 'approved';
    rawConfidence = 0.8;
    verdictSummary = `${warnings.length} warning(s) noted but not blocking.`;
  }
  
  // V3: Calibrate confidence based on evidence quality
  // For docs-only + mild warnings, keep confidence moderate (0.65-0.82)
  const isDocsOnly = codeFiles && codeFiles.length === 0;
  const hasMildWarnings = warnings.length > 0 && errors.length === 0;
  let calibratedConfidence = rawConfidence;
  
  if (isDocsOnly && hasMildWarnings) {
    // Docs-only with mild warnings: cap at 0.75
    calibratedConfidence = Math.min(rawConfidence, 0.75);
  } else if (hasMildWarnings) {
    // Mild warnings without errors: cap at 0.82
    calibratedConfidence = Math.min(rawConfidence, 0.82);
  } else if (errors.length > 0) {
    // Has errors - still cap at 0.92, not 1.0
    calibratedConfidence = Math.min(rawConfidence, 0.92);
  }
  
  // Update verdict with calibrated confidence
  const finalVerdict = {
    verdict,
    confidence: verdict === 'approved' ? Math.min(calibratedConfidence, 0.82) : calibratedConfidence,
    summary: verdictSummary,
  };
  
  // Generate key risks from errors and warnings
  const keyRisks: RiskItem[] = [];
  
  for (const error of errors.slice(0, 3)) {
    keyRisks.push({
      severity: 'high',
      category: error.category,
      description: error.message.slice(0, 200),
      evidence: error.file ? `File: ${error.file}${error.line ? `:${error.line}` : ''}` : 'General',
      suggestion: error.suggestion || 'Fix the error before merging.',
    });
  }
  
  for (const warning of warnings.slice(0, 2)) {
    keyRisks.push({
      severity: 'medium',
      category: warning.category,
      description: warning.message.slice(0, 200),
      evidence: warning.file ? `File: ${warning.file}${warning.line ? `:${warning.line}` : ''}` : 'General',
      suggestion: warning.suggestion || 'Consider addressing this warning.',
    });
  }
  
  // Generate checklist based on doc type
  const checklist: ReviewerChecklistItem[] = [];
  
  // Add doc-type specific items
  if (docType.type === 'sop') {
    checklist.push(
      { category: 'docs', item: 'SOP includes clear step-by-step instructions', priority: 'required' },
      { category: 'docs', item: 'Prerequisites are documented', priority: 'required' },
      { category: 'testing', item: 'Process has been tested successfully', priority: 'recommended' },
    );
  } else if (docType.type === 'readme') {
    checklist.push(
      { category: 'docs', item: 'README includes installation instructions', priority: 'required' },
      { category: 'docs', item: 'README includes usage examples', priority: 'required' },
    );
  } else if (docType.type === 'api') {
    checklist.push(
      { category: 'docs', item: 'API endpoints have clear descriptions', priority: 'required' },
      { category: 'docs', item: 'Request/response formats are documented', priority: 'required' },
    );
  }
  
  // Add general items based on changes
  if (semanticDiff.stats.added > 0) {
    checklist.push({ category: 'docs', item: 'New sections have clear headings', priority: 'recommended' });
  }
  if (semanticDiff.stats.removed > 0) {
    checklist.push({ category: 'docs', item: 'Removed content is reflected in navigation/index', priority: 'recommended' });
  }
  if (semanticDiff.stats.modified > 0) {
    checklist.push({ category: 'docs', item: 'Modified sections are consistent with rest of doc', priority: 'recommended' });
  }
  
  // Build PR intent from title and diff stats
  const prIntent = prContext.body 
    ? prContext.body.slice(0, 200) 
    : `Update ${docType.type} documentation with ${semanticDiff.stats.added + semanticDiff.stats.modified} section change(s).`;
  
  // Build change overview
  const stats = semanticDiff.stats;
  const changeOverview = `${stats.added} section(s) added, ${stats.removed} removed, ${stats.modified} modified. ${errors.length} error(s), ${warnings.length} warning(s) found.`;
  
  return {
    prIntent: prIntent.slice(0, 300),
    changeOverview,
    keyRisks,
    checklist: checklist.slice(0, 8),
    prBodySuggestion: { sections: [] },
    verdict: finalVerdict,
  };
}

/**
 * Legacy function - kept for backward compatibility
 */
export async function generateAISummary(
  docType: DocTypeClassification,
  diff: SemanticDiff,
  findings: { type: string; category: string; message: string }[],
  config: MiniMaxConfig,
  codeFiles?: CodeFileInfo[]
): Promise<string> {
  // Fallback to simple prompt if v2 fails
  try {
    const simplePrompt = `Provide a brief 1-2 sentence summary of this PR change. 
Doc type: ${docType.type}. 
Changes: +${diff.stats.added} added, -${diff.stats.removed} removed, ~${diff.stats.modified} modified.`;
    
    const response = await fetch(MINIMAX_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'MiniMax-M2.5',
        messages: [{ role: 'user', content: simplePrompt }],
        group_id: config.groupId,
        temperature: 0.3,
        max_tokens: 50,
      }),
    });
    
    if (!response.ok) {
      return '';
    }
    
    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('MiniMax error:', error);
    return '';
  }
}

/**
 * Legacy function - kept for backward compatibility
 */
export async function generatePRDescription(
  docType: DocTypeClassification,
  diff: SemanticDiff,
  findings: { type: string; category: string; message: string }[],
  config: MiniMaxConfig,
  codeFiles?: CodeFileInfo[]
): Promise<string> {
  return generateAISummary(docType, diff, findings, config, codeFiles);
}

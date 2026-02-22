import { DocTypeClassification, SemanticDiff } from '../types';

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

export async function generateAISummary(
  docType: DocTypeClassification,
  diff: SemanticDiff,
  findings: { type: string; category: string; message: string }[],
  config: MiniMaxConfig,
  codeFiles?: CodeFileInfo[]
): Promise<string> {
  const { apiKey, groupId } = config;
  
  if (!apiKey || !groupId) {
    return '';
  }
  
  const stats = diff.stats;
  const hasCode = codeFiles && codeFiles.length > 0;
  
  // Build the prompt based on what's changed
  let prompt = '';
  
  if (hasCode) {
    // Code + docs PR
    const codeSummary = codeFiles
      .map(f => `${f.filename}: +${f.additions} -${f.deletions}`)
      .slice(0, 5)
      .join(', ');
    
    prompt = `Summarize these changes in ONE short sentence (max 20 words):
- Code: ${codeSummary}
${stats.added + stats.removed > 0 ? `- Docs: +${stats.added} -${stats.removed} sections` : ''}

Focus on what this PR does overall.`;
  } else if (docType.type !== 'other') {
    // Docs only PR
    prompt = `Summarize these documentation changes in ONE short sentence (max 15 words):
- Doc type: ${docType.type}
- Changes: +${stats.added} added, -${stats.removed} removed, ~${stats.modified} modified

Example: "Updated README with new installation steps" or "Added API documentation for auth endpoints"`;
  } else {
    // Other/unknown
    prompt = `Summarize these changes in ONE short sentence (max 15 words):
- Files changed: ${stats.added + stats.removed + stats.modified}
- Changes: +${stats.added} added, -${stats.removed} removed, ~${stats.modified} modified

Keep it brief and helpful.`;
  }

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
        groupId: groupId,
        temperature: 0.3,
        max_tokens: 60,
      }),
    });
    
    if (!response.ok) {
      console.error('MiniMax API error:', response.status);
      return '';
    }
    
    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('MiniMax error:', error);
    return '';
  }
}

// Generate PR description body
export async function generatePRDescription(
  docType: DocTypeClassification,
  diff: SemanticDiff,
  findings: { type: string; category: string; message: string }[],
  config: MiniMaxConfig,
  codeFiles?: CodeFileInfo[]
): Promise<string> {
  const { apiKey, groupId } = config;
  
  if (!apiKey || !groupId) {
    return '';
  }
  
  const stats = diff.stats;
  const hasCode = codeFiles && codeFiles.length > 0;
  
  let prompt = '';
  
  if (hasCode) {
    const codeSummary = codeFiles
      .map(f => `${f.filename}: +${f.additions} -${f.deletions}`)
      .slice(0, 8)
      .join('\n');
    
    prompt = `Write a helpful PR description (2-3 short sentences):

## Changes
${codeSummary}
${stats.added + stats.removed > 0 ? `\n## Documentation\n+${stats.added} -${stats.removed} sections modified` : ''}

## Summary
Write what this PR does and why. Be concise.`;
  } else if (docType.type !== 'other') {
    prompt = `Write a helpful PR description for these documentation changes (2-3 short sentences):
- Type: ${docType.type}
- Changes: +${stats.added} added, -${stats.removed} removed, ~${stats.modified} modified

Focus on what changed and why it matters.`;
  } else {
    prompt = `Write a helpful PR description (2-3 short sentences) for this PR:
- Changes: +${stats.added} added, -${stats.removed} removed, ~${stats.modified} modified

Keep it brief and informative.`;
  }

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
        groupId: groupId,
        temperature: 0.5,
        max_tokens: 150,
      }),
    });
    
    if (!response.ok) {
      return '';
    }
    
    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('MiniMax PR desc error:', error);
    return '';
  }
}

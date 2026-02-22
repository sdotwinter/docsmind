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
  
  // Simple prompt
  let prompt = '';
  
  if (hasCode) {
    const codeSummary = codeFiles
      .slice(0, 3)
      .map(f => f.filename)
      .join(', ');
    prompt = `${codeSummary} changed.`;
  } else if (docType.type !== 'other') {
    prompt = `Updated ${docType.type} docs.`;
  } else {
    prompt = `Updated ${stats.added + stats.modified} lines.`;
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
        max_tokens: 30,
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
  
  // Simple prompt
  let prompt = '';
  
  if (hasCode) {
    prompt = `This PR updates ${codeFiles?.length || 0} files.`;
  } else if (docType.type !== 'other') {
    prompt = `This PR updates the ${docType.type} documentation.`;
  } else {
    prompt = `This PR makes changes to ${stats.added + stats.modified} lines.`;
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
        max_tokens: 60,
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

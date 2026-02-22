import { DocDocument, DocTypeClassification } from '../types';

const DOC_TYPE_PATTERNS = {
  sop: [
    { pattern: /procedure|step\s+\d+|instructions|how\s+to/i, weight: 2 },
    { pattern: /prerequisite|requirement|before\s+you\s+begin/i, weight: 1.5 },
    { pattern: /^#?\s*(Standard\s+Operating|Step-by-Step)/i, weight: 3 },
  ],
  adr: [
    { pattern: /^#?\s*ADR/i, weight: 3 },
    { pattern: /decision|context|consequences|status/i, weight: 1.5 },
    { pattern: /proposed|accepted|deprecated|superseded/i, weight: 2 },
  ],
  readme: [
    { pattern: /^#?\s*README/i, weight: 3 },
    { pattern: /installation|setup|getting\s+started|quick\s+start/i, weight: 1.5 },
    { pattern: /usage|example|api|license|contributing/i, weight: 1 },
  ],
  runbook: [
    { pattern: /runbook|playbook|run\s+book/i, weight: 3 },
    { pattern: /incident|alert|monitoring|debug|troubleshoot/i, weight: 2 },
    { pattern: /symptom|root\s+cause|resolution|recovery/i, weight: 2 },
  ],
  pricing: [
    { pattern: /pricing|price|plan|tier|cost|fee|subscription/i, weight: 3 },
    { pattern: /per\s+user|per\s+month|enterprise|free\s+trial/i, weight: 2 },
    { pattern: /\$\d+|USD|EUR|GBP/i, weight: 1.5 },
  ],
  changelog: [
    { pattern: /changelog|change\s+log|release\s+notes|versions?/i, weight: 3 },
    { pattern: /^\d+\.\d+\.\d+|^v\d+/m, weight: 2 },
    { pattern: /added|fixed|changed|deprecated|removed/i, weight: 1.5 },
  ],
  guide: [
    { pattern: /guide|tutorial|walkthrough|best\s+practices/i, weight: 2 },
    { pattern: /chapter|part\s+\d+|section\s+\d+/i, weight: 1 },
  ],
};

export function classifyDocument(doc: DocDocument): DocTypeClassification {
  const scores: Record<string, number> = {};
  const indicators: string[] = [];
  
  // Check title/headings
  const title = doc.sections[0]?.heading || '';
  const allHeadings = doc.sections.map(s => s.heading).join(' ');
  const allContent = doc.sections.map(s => s.content).join(' ');
  
  for (const [docType, patterns] of Object.entries(DOC_TYPE_PATTERNS)) {
    let score = 0;
    
    for (const { pattern, weight } of patterns) {
      if (pattern.test(title)) {
        score += weight * 2;
        indicators.push(`Title: ${pattern.source}`);
      }
      if (pattern.test(allHeadings)) {
        score += weight;
        indicators.push(`Heading: ${pattern.source}`);
      }
      if (pattern.test(allContent)) {
        score += weight * 0.5;
      }
    }
    
    scores[docType] = score;
  }
  
  // Check for tables (common in pricing, ADRs)
  if (doc.tables.length > 0) {
    scores['pricing'] = (scores['pricing'] || 0) + doc.tables.length * 0.5;
    scores['adr'] = (scores['adr'] || 0) + doc.tables.length * 0.3;
  }
  
  // Check for code blocks (common in runbooks, guides)
  if (doc.codeBlocks.length > 0) {
    scores['runbook'] = (scores['runbook'] || 0) + doc.codeBlocks.length * 0.3;
    scores['guide'] = (scores['guide'] || 0) + doc.codeBlocks.length * 0.3;
    scores['sop'] = (scores['sop'] || 0) + doc.codeBlocks.length * 0.2;
  }
  
  // Find highest score
  let maxType: string = 'other';
  let maxScore = 0;
  
  for (const [docType, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxType = docType;
    }
  }
  
  // Normalize confidence
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? Math.min(maxScore / totalScore + 0.3, 1) : 0;
  
  return {
    type: maxType as DocTypeClassification['type'],
    confidence,
    indicators: indicators.slice(0, 5),
  };
}

export function generateReviewChecklist(
  docType: DocTypeClassification['type'],
  diff: { stats: SemanticDiff['stats'] }
): string[] {
  const checklist: string[] = [];
  
  switch (docType) {
    case 'sop':
      checklist.push(
        '✅ Verify all prerequisites are listed',
        '✅ Check step order is logical',
        '✅ Ensure each step has clear success criteria',
        '✅ Add troubleshooting tips for common failures'
      );
      break;
      
    case 'adr':
      checklist.push(
        '✅ Confirm context is up to date',
        '✅ Verify decision rationale is complete',
        '✅ Check status (proposed/accepted/deprecated) is correct',
        '✅ Note any superseded ADRs'
      );
      break;
      
    case 'runbook':
      checklist.push(
        '✅ Verify alert thresholds are current',
        '✅ Check escalation contacts are valid',
        '✅ Ensure rollback steps are documented',
        '✅ Add estimated time to complete each step'
      );
      break;
      
    case 'pricing':
      checklist.push(
        '✅ Verify all prices match current plans',
        '✅ Check feature lists are accurate',
        '✅ Confirm promo/discount terms are valid',
        '✅ Update API rate limits if changed'
      );
      break;
      
    case 'readme':
      checklist.push(
        '✅ Verify installation steps work',
        '✅ Check API examples are correct',
        '✅ Update dependencies versions',
        '✅ Confirm license is current'
      );
      break;
      
    default:
      checklist.push(
        '✅ Review for typos and formatting',
        '✅ Check all links are valid',
        '✅ Verify code examples work',
        '✅ Ensure consistent style'
      );
  }
  
  // Add diff-specific items
  if (diff.stats.added > 0) {
    checklist.push(`📝 Review ${diff.stats.added} new section(s)`);
  }
  if (diff.stats.modified > 0) {
    checklist.push(`✏️ Verify ${diff.stats.modified} modified section(s)`);
  }
  
  return checklist;
}

import { SemanticDiff } from '../types';

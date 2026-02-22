import { DocDocument, DocTypeClassification, ReviewFinding } from '../types';

const DOC_TYPE_PATTERNS = {
  sop: [
    { pattern: /^#?\s*(Standard\s+Operating|Procedure|SOP)/i, weight: 3 },
    { pattern: /procedure|step\s+\d+|instructions|how\s+to/i, weight: 2 },
    { pattern: /prerequisite|requirement|before\s+you\s+begin/i, weight: 1.5 },
    { pattern: /expected\s+result|verification|success\s+criteria/i, weight: 2 },
    { pattern: /troubleshooting|common\s+issues|error\s+handling/i, weight: 1.5 },
  ],
  adr: [
    { pattern: /^#?\s*(ADR|Architecture\s+Decision)/i, weight: 3 },
    { pattern: /decision|context|consequences|status/i, weight: 1.5 },
    { pattern: /proposed|accepted|deprecated|superseded|supersedes/i, weight: 2 },
    { pattern: /date|author|revised/i, weight: 1 },
    { pattern: /alternatives|considered|options/i, weight: 1.5 },
  ],
  readme: [
    { pattern: /^#?\s*README/i, weight: 4 },
    { pattern: /installation|setup|getting\s+started|quick\s+start/i, weight: 2 },
    { pattern: /usage|example|api\s+reference|license|contributing/i, weight: 1.5 },
    { pattern: /badge|version|build|test|features?/i, weight: 1 },
  ],
  runbook: [
    { pattern: /runbook|playbook|run\s+book|operations?\s+manual/i, weight: 3 },
    { pattern: /incident|alert|on-call|escalation|severity/i, weight: 2 },
    { pattern: /symptom|root\s+cause|resolution|recovery|mitigation/i, weight: 2 },
    { pattern: /monitoring|metrics|dashboard|runbook/i, weight: 2 },
    { pattern: /debug|troubleshoot|investigation/i, weight: 1.5 },
  ],
  pricing: [
    { pattern: /^#?\s*(pricing|plans?|cost|tier)/i, weight: 3 },
    { pattern: /\$\d+|USD|EUR|GBP|per\s+(month|user|seat|year)|annual|billing|invoice/i, weight: 2 },
    { pattern: /feature\s+matrix|comparison\s+table/i, weight: 2 },
    { pattern: /subscription|fee|charge/i, weight: 1.5 },
  ],
  changelog: [
    { pattern: /changelog|change\s+log|release\s+notes|history/i, weight: 3 },
    { pattern: /^\d+\.\d+\.\d+|^v\d+/m, weight: 2 },
    { pattern: /added|fixed|changed|deprecated|removed|security/i, weight: 1.5 },
  ],
  guide: [
    { pattern: /guide|tutorial|walkthrough|howto|learn/i, weight: 2 },
    { pattern: /chapter|part\s+\d+|section\s+\d+/i, weight: 1 },
    { pattern: /prerequisite|before\s+you\s+start|getting\s+started/i, weight: 1.5 },
    { pattern: /tip|note|warning|caution|important/i, weight: 1 },
  ],
  api: [
    { pattern: /API|REST|endpoint|route|request|response/i, weight: 2 },
    { pattern: /GET|POST|PUT|DELETE|PATCH/i, weight: 2 },
    { pattern: /authentication|authorization|token|API\s*key| Bearer/i, weight: 2 },
    { pattern: /parameter|header|body|query|schema/i, weight: 1.5 },
    { pattern: /example|curl|javascript|python|response/i, weight: 1.5 },
  ],
  contrib: [
    { pattern: /contributing|CONTRIBUTING|contribution/i, weight: 3 },
    { pattern: /pull\s+request|PR|branch|commit/i, weight: 2 },
    { pattern: /code\s+of\s+conduct|license|develop|test/i, weight: 1.5 },
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
        score += weight * 0.3;
      }
    }
    
    scores[docType] = score;
  }
  
  // Check for tables (common in pricing, ADRs)
  if (doc.tables.length > 0) {
    scores['pricing'] = (scores['pricing'] || 0) + doc.tables.length * 0.5;
    scores['adr'] = (scores['adr'] || 0) + doc.tables.length * 0.3;
  }
  
  // Check for code blocks (common in runbooks, guides, API)
  if (doc.codeBlocks.length > 0) {
    scores['runbook'] = (scores['runbook'] || 0) + doc.codeBlocks.length * 0.3;
    scores['guide'] = (scores['guide'] || 0) + doc.codeBlocks.length * 0.3;
    scores['sop'] = (scores['sop'] || 0) + doc.codeBlocks.length * 0.2;
    scores['api'] = (scores['api'] || 0) + doc.codeBlocks.length * 0.4;
  }
  
  // Find highest score
  let maxType = 'other';
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
  diff: { stats: { added: number; removed: number; modified: number; moved: number } },
  doc?: DocDocument
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
        '✅ Note any superseded ADRs',
        '✅ Review alternatives considered'
      );
      break;
      
    case 'runbook':
      checklist.push(
        '✅ Verify alert thresholds are current',
        '✅ Check escalation contacts are valid',
        '✅ Ensure rollback steps are documented',
        '✅ Add estimated time to complete each step',
        '✅ Verify monitoring/alert links work'
      );
      break;
      
    case 'pricing':
      checklist.push(
        '✅ Verify all prices match current plans',
        '✅ Check feature lists are accurate',
        '✅ Confirm promo/discount terms are valid',
        '✅ Update API rate limits if changed',
        '✅ Review limits/quotas are current'
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

    case 'api':
      checklist.push(
        '✅ Verify all endpoints documented',
        '✅ Check authentication requirements',
        '✅ Review example requests/responses',
        '✅ Ensure parameter types match',
        '✅ Verify response codes are complete'
      );
      break;

    case 'contrib':
      checklist.push(
        '✅ Check PR guidelines are clear',
        '✅ Verify development setup steps work',
        '✅ Review testing requirements',
        '✅ Check code of conduct is linked'
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
  if (diff.stats.removed > 0) {
    checklist.push(`⚠️ Verify ${diff.stats.removed} removed section(s) are intentional`);
  }
  if (diff.stats.modified > 0) {
    checklist.push(`✏️ Check ${diff.stats.modified} modified section(s)`);
  }
  
  return checklist;
}

// Validate links in document
export function validateLinks(doc: DocDocument): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const sectionPaths = new Set(doc.sections.map(s => s.path));
  
  for (const link of doc.links) {
    if (!link.isInternal) {
      // External link - could add HTTP check later
      continue;
    }
    
    // Internal link - verify it points to existing section
    if (link.targetPath && !sectionPaths.has(link.targetPath)) {
      findings.push({
        type: 'warning',
        category: 'link',
        message: `Broken internal link: ${link.url}`,
      });
    }
  }
  
  // Check for potentially outdated links
  const deprecatedPatterns = [/http:\/\//, /www\./];
  for (const link of doc.links) {
    if (!link.isInternal) {
      for (const pattern of deprecatedPatterns) {
        if (pattern.test(link.url)) {
          findings.push({
            type: 'info',
            category: 'link',
            message: `Consider using HTTPS for: ${link.url}`,
          });
          break;
        }
      }
    }
  }
  
  return findings;
}

import { SemanticDiff } from '../types';

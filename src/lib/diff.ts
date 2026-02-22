import * as Diff from 'diff';
import { DocDocument, DocSection, SemanticDiff, SectionChange } from '../types';

export function computeSemanticDiff(oldDoc: DocDocument, newDoc: DocDocument): SemanticDiff {
  const changes: SectionChange[] = [];
  
  const oldSections = new Map(oldDoc.sections.map(s => [s.path, s]));
  const newSections = new Map(newDoc.sections.map(s => [s.path, s]));
  
  // Find added sections
  for (const [path, section] of newSections) {
    if (!oldSections.has(path)) {
      changes.push({
        type: 'added',
        newPath: path,
        newHeading: section.heading,
      });
    }
  }
  
  // Find removed sections
  for (const [path, section] of oldSections) {
    if (!newSections.has(path)) {
      changes.push({
        type: 'removed',
        oldPath: path,
        oldHeading: section.heading,
      });
    }
  }
  
  // Find modified and moved sections
  for (const [path, oldSection] of oldSections) {
    const newSection = newSections.get(path);
    if (newSection) {
      // Check if content changed
      if (oldSection.content !== newSection.content) {
        changes.push({
          type: 'modified',
          oldPath: path,
          newPath: path,
          oldHeading: oldSection.heading,
          newHeading: newSection.heading,
          similarity: computeSimilarity(oldSection.content, newSection.content),
        });
      }
    } else {
      // Section was removed - check if it appeared elsewhere (moved)
      const movedTo = findMovedSection(oldSection, newSections);
      if (movedTo) {
        changes.push({
          type: 'moved',
          oldPath: path,
          newPath: movedTo.path,
          oldHeading: oldSection.heading,
          newHeading: movedTo.heading,
        });
      }
    }
  }
  
  // Find moved sections that weren't removed
  for (const [newPath, newSection] of newSections) {
    const oldSection = oldSections.get(newPath);
    if (!oldSection) {
      // Could be moved from somewhere
      const movedFrom = findMovedSection(newSection, oldSections);
      if (!movedFrom) {
        // It's genuinely new (already caught above)
      }
    }
  }
  
  const stats = {
    added: changes.filter(c => c.type === 'added').length,
    removed: changes.filter(c => c.type === 'removed').length,
    modified: changes.filter(c => c.type === 'modified').length,
    moved: changes.filter(c => c.type === 'moved').length,
  };
  
  return { sections: changes, stats };
}

function findMovedSection(
  section: DocSection,
  otherSections: Map<string, DocSection>
): DocSection | null {
  // Find section with similar content that moved to a different path
  for (const [, other] of otherSections) {
    if (other.path !== section.path) {
      const similarity = computeSimilarity(section.content, other.content);
      if (similarity > 0.8) {
        return other;
      }
    }
  }
  return null;
}

function computeSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  
  // Simple word-based similarity
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  
  return intersection.size / union.size;
}

export function generateDiffSummary(diff: SemanticDiff): string {
  const { stats } = diff;
  const parts: string[] = [];
  
  if (stats.added > 0) {
    parts.push(`+${stats.added} section${stats.added === 1 ? '' : 's'}`);
  }
  if (stats.removed > 0) {
    parts.push(`-${stats.removed} section${stats.removed === 1 ? '' : 's'}`);
  }
  if (stats.modified > 0) {
    parts.push(`~${stats.modified} modified`);
  }
  if (stats.moved > 0) {
    parts.push(`»${stats.moved} moved`);
  }
  
  return parts.length > 0 ? parts.join(', ') : 'No changes';
}

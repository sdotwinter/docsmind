// Types for DocSMind

export interface GitHubConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
}

export interface Repository {
  id: number;
  name: string;
  fullName: string;
  owner: {
    login: string;
  };
}

export interface WebhookPayload {
  action: string;
  repository: Repository;
  pull_request?: PullRequest;
  installation?: {
    id: number;
  };
}

// Semantic document representation
export interface DocSection {
  id: string;
  path: string; // e.g., "intro/getting-started"
  heading: string;
  level: number;
  content: string;
  lineStart: number;
  lineEnd: number;
  hash: string;
}

export interface DocDocument {
  path: string;
  sections: DocSection[];
  frontmatter: Record<string, unknown> | null;
  tables: TableInfo[];
  codeBlocks: CodeBlockInfo[];
  links: LinkInfo[];
}

export interface TableInfo {
  id: string;
  caption: string | null;
  headers: string[];
  rowCount: number;
  lineStart: number;
}

export {
  id: string;
  language interface CodeBlockInfo: string | null;
  lineStart: number;
  lineEnd: number;
}

export interface LinkInfo {
  id: string;
  url: string;
  text: string;
  isInternal: boolean;
  targetPath: string | null;
}

// Semantic diff results
export interface SectionChange {
  type: 'added' | 'removed' | 'modified' | 'moved';
  oldPath?: string;
  newPath?: string;
  oldHeading?: string;
  newHeading?: string;
  similarity?: number;
}

export interface SemanticDiff {
  sections: SectionChange[];
  stats: {
    added: number;
    removed: number;
    modified: number;
    moved: number;
  };
}

export interface DocTypeClassification {
  type: 'sop' | 'adr' | 'readme' | 'runbook' | 'pricing' | 'changelog' | 'guide' | 'other';
  confidence: number;
  indicators: string[];
}

export interface ReviewFinding {
  type: 'info' | 'warning' | 'error';
  category: 'structure' | 'style' | 'link' | 'content' | 'security';
  message: string;
  file?: string;
  line?: number;
  section?: string;
  suggestion?: string;
}

export interface ReviewResult {
  installationId: number;
  repositoryId: number;
  pullRequest: number;
  docType: DocTypeClassification;
  semanticDiff: SemanticDiff;
  findings: ReviewFinding[];
  summary: string;
}

// Check run payload
export interface CheckRunConclusion {
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out';
  output: {
    title: string;
    summary: string;
    annotations: Array<{
      path: string;
      start_line: number;
      end_line: number;
      annotation_level: 'notice' | 'warning' | 'failure';
      message: string;
    }>;
  };
}

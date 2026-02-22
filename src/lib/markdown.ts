import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { visit } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';
import * as crypto from 'crypto';
import { DocDocument, DocSection, TableInfo, CodeBlockInfo, LinkInfo } from '../types';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify);

export function parseMarkdown(content: string, filePath: string): DocDocument {
  const tree = processor.parse(content);
  
  const sections: DocSection[] = [];
  const tables: TableInfo[] = [];
  const codeBlocks: CodeBlockInfo[] = [];
  const links: LinkInfo[] = [];
  
  let currentPath = '';
  let sectionCounter = 0;
  let tableCounter = 0;
  let codeCounter = 0;
  
  // Extract frontmatter if present
  let frontmatter: Record<string, unknown> | null = null;
  if (content.startsWith('---')) {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      frontmatter = parseFrontmatter(fmMatch[1]);
    }
  }
  
  // Process AST
  visit(tree, (node, index, parent) => {
    // Headings (sections)
    if (node.type === 'heading') {
      const headingText = toString(node);
      const level = node.depth;
      
      // Build path from parent headings
      if (level === 1) {
        currentPath = slugify(headingText);
      } else {
        currentPath += '/' + slugify(headingText);
      }
      
      // Get content between this heading and next
      const sectionContent = extractSectionContent(tree, index);
      
      sections.push({
        id: `section-${sectionCounter++}`,
        path: currentPath,
        heading: headingText,
        level,
        content: sectionContent,
        lineStart: node.position?.start?.line || 0,
        lineEnd: node.position?.end?.line || 0,
        hash: hashContent(headingText + sectionContent),
      });
      
      return;
    }
    
    // Tables
    if (node.type === 'table') {
      const headers = node.children?.[0]?.children?.map((c: any) => toString(c)) || [];
      const rowCount = (node.children?.length || 1) - 1;
      
      tables.push({
        id: `table-${tableCounter++}`,
        caption: (node as any).caption ? toString((node as any).caption) : null,
        headers,
        rowCount,
        lineStart: node.position?.start?.line || 0,
      });
      
      return;
    }
    
    // Code blocks
    if (node.type === 'code') {
      codeBlocks.push({
        id: `code-${codeCounter++}`,
        language: (node as any).lang || null,
        lineStart: node.position?.start?.line || 0,
        lineEnd: node.position?.end?.line || 0,
      });
      
      return;
    }
    
    // Links
    if (node.type === 'link') {
      const url = (node as any).url || '';
      const text = toString(node);
      const isInternal = url.startsWith('#') || (!url.startsWith('http') && !url.startsWith('//'));
      
      links.push({
        id: `link-${links.length}`,
        url,
        text,
        isInternal,
        targetPath: isInternal ? extractLinkPath(url) : null,
      });
      
      return;
    }
  });
  
  return {
    path: filePath,
    sections,
    frontmatter,
    tables,
    codeBlocks,
    links,
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function hashContent(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
}

function extractSectionContent(tree: any, headingIndex: number): string {
  // Get all siblings after this heading until next heading at same/lower level
  const siblings = tree.children;
  const parts: string[] = [];
  
  for (let i = headingIndex + 1; i < siblings.length; i++) {
    const node = siblings[i];
    if (node.type === 'heading') {
      break;
    }
    if (node.type === 'paragraph' || node.type === 'list' || node.type === 'code') {
      parts.push(toString(node));
    }
  }
  
  return parts.join(' ');
}

function parseFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  
  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      result[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  
  return result;
}

function extractLinkPath(url: string): string | null {
  if (url.startsWith('#')) {
    return url.slice(1).replace(/-/g, '/');
  }
  if (url.endsWith('.md') || url.endsWith('.mdx')) {
    return url.replace(/\.mdx?$/, '').replace(/^\//, '');
  }
  return null;
}

export function stringifyMarkdown(tree: any): string {
  return processor.stringify(tree);
}

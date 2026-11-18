/**
 * Project Aegis - Prompt & Template Library
 * Implements: Issue #207 [WKS-02] Saved prompts, variable interpolation,
 * categorized template folders, versions, and import/export.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAppPaths } from '../infrastructure/paths.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('template-library');

export interface PromptTemplate {
  id: string;
  title: string;
  category: 'E-Commerce' | 'Research' | 'News' | 'Automation' | 'General';
  description: string;
  templateText: string;
  variables: string[]; // e.g. ['product', 'store_a', 'store_b']
  version: string;
  isBuiltIn: boolean;
}

export class TemplateLibrary {
  private static instance: TemplateLibrary | null = null;
  private templates: Map<string, PromptTemplate> = new Map();
  private storePath: string | null = null;

  private constructor() {
    try {
      const paths = getAppPaths();
      this.storePath = path.join(paths.userData, 'templates.json');
      this.load();
    } catch {
      this.storePath = null;
      this.seedStarterPack();
    }
  }

  public static getInstance(): TemplateLibrary {
    if (!TemplateLibrary.instance) {
      TemplateLibrary.instance = new TemplateLibrary();
    }
    return TemplateLibrary.instance;
  }

  private seedStarterPack(): void {
    const starterPack: PromptTemplate[] = [
      {
        id: 'tpl_price_comp',
        title: 'Price Comparison',
        category: 'E-Commerce',
        description: 'Compare product price and availability across two e-commerce retailers',
        templateText: 'Navigate to {{store_a}} and {{store_b}}, search for {{product}}, and produce a table comparing item name, price, rating, and stock status.',
        variables: ['store_a', 'store_b', 'product'],
        version: '1.0.0',
        isBuiltIn: true
      },
      {
        id: 'tpl_news_extractor',
        title: 'News & Article Digest',
        category: 'News',
        description: 'Extract top stories and key takeaways from a publication',
        templateText: 'Open {{news_site}}, locate the top {{story_count}} trending articles, and extract headlines, points/scores, and 2-sentence summaries.',
        variables: ['news_site', 'story_count'],
        version: '1.0.0',
        isBuiltIn: true
      },
      {
        id: 'tpl_research_sota',
        title: 'SOTA Academic Research',
        category: 'Research',
        description: 'Extract recent benchmark results and methodology for a given topic',
        templateText: 'Search for recent papers on {{topic}}, identify the benchmark leaderboard scores, and list state-of-the-art results with citations.',
        variables: ['topic'],
        version: '1.0.0',
        isBuiltIn: true
      }
    ];

    for (const tpl of starterPack) {
      this.templates.set(tpl.id, tpl);
    }
  }

  public static extractVariables(text: string): string[] {
    const matches = text.match(/\{\{([a-zA-Z0-9_-]+)\}\}/g);
    if (!matches) return [];
    const unique = new Set(matches.map(m => m.replace(/^\{\{|\}\}$/g, '').trim()));
    return Array.from(unique);
  }

  public static interpolate(templateText: string, values: Record<string, string>): string {
    return templateText.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_, key) => {
      return values[key] !== undefined ? values[key] : `{{${key}}}`;
    });
  }

  public getTemplates(category?: string): PromptTemplate[] {
    const all = Array.from(this.templates.values());
    if (category) {
      return all.filter(t => t.category.toLowerCase() === category.toLowerCase());
    }
    return all;
  }

  public getTemplate(id: string): PromptTemplate | undefined {
    return this.templates.get(id);
  }

  public saveTemplate(tpl: Omit<PromptTemplate, 'isBuiltIn' | 'variables'>): PromptTemplate {
    const variables = TemplateLibrary.extractVariables(tpl.templateText);
    const complete: PromptTemplate = {
      ...tpl,
      variables,
      isBuiltIn: false
    };
    this.templates.set(complete.id, complete);
    this.save();
    logger.info('Saved custom template', { id: complete.id, title: complete.title });
    return complete;
  }

  public deleteTemplate(id: string): boolean {
    const tpl = this.templates.get(id);
    if (!tpl || tpl.isBuiltIn) return false;
    const deleted = this.templates.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  public exportBundle(): string {
    return JSON.stringify(Array.from(this.templates.values()), null, 2);
  }

  public importBundle(jsonContent: string): { importedCount: number; errors: string[] } {
    const errors: string[] = [];
    let count = 0;
    try {
      const list = JSON.parse(jsonContent);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item.id && item.templateText && item.title) {
            this.templates.set(item.id, {
              ...item,
              variables: TemplateLibrary.extractVariables(item.templateText),
              isBuiltIn: false
            });
            count++;
          } else {
            errors.push(`Invalid template format for item: ${JSON.stringify(item).slice(0, 50)}`);
          }
        }
        this.save();
      }
    } catch (err: any) {
      errors.push(`JSON parse error: ${err.message}`);
    }
    return { importedCount: count, errors };
  }

  private save(): void {
    if (!this.storePath) return;
    try {
      const customOnly = Array.from(this.templates.values()).filter(t => !t.isBuiltIn);
      fs.writeFileSync(this.storePath, JSON.stringify(customOnly, null, 2), 'utf-8');
    } catch {}
  }

  private load(): void {
    this.seedStarterPack();
    if (!this.storePath || !fs.existsSync(this.storePath)) return;
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8');
      const list = JSON.parse(raw) as PromptTemplate[];
      for (const t of list) {
        this.templates.set(t.id, t);
      }
    } catch {}
  }
}

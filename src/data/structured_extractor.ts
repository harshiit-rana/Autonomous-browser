/**
 * Project Aegis - Structured JSON Schema Extraction Engine via LLM Guardrails
 * 
 * Implements:
 * - Issue #79: DATA-03 Structured JSON Schema Extraction Engine via LLM Guardrails
 */

import { IModelProvider } from '../models/types.js';

export interface ExtractionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ExtractionSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  required?: boolean;
}

export interface ExtractionSchema {
  name: string;
  description: string;
  properties: Record<string, ExtractionSchemaProperty>;
}

export class StructuredSchemaExtractor {
  private modelProvider?: IModelProvider;

  constructor(modelProvider?: IModelProvider) {
    this.modelProvider = modelProvider;
  }

  /**
   * Generates a strict schema extraction prompt.
   */
  public static buildExtractionPrompt(schema: ExtractionSchema, rawText: string): ExtractionMessage[] {
    const propertiesSpec = Object.entries(schema.properties)
      .map(([k, v]) => `  "${k}": (${v.type}${v.required ? ', required' : ''}) - ${v.description || ''}`)
      .join('\n');

    const systemPrompt = `You are a precision web data extraction engine.
Extract data matching the schema exactly. Output ONLY a valid JSON object. No explanation, no markdown backticks.

Target Schema: "${schema.name}"
Description: ${schema.description}
Properties:
{\n${propertiesSpec}\n}`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Raw Web Page Content:\n${rawText.slice(0, 10000)}` }
    ];
  }

  /**
   * Validates parsed JSON against the target schema.
   */
  public static validateOutput(data: Record<string, any>, schema: ExtractionSchema): { valid: boolean; missingFields: string[] } {
    const missing: string[] = [];
    for (const [k, v] of Object.entries(schema.properties)) {
      if (v.required && (data[k] === undefined || data[k] === null || data[k] === '')) {
        missing.push(k);
      }
    }
    return {
      valid: missing.length === 0,
      missingFields: missing
    };
  }
}

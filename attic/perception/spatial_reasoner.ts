/**
 * Project Aegis - Spatial Relationship & Visual Hierarchy Reasoning Engine
 * 
 * Implements:
 * - Issue #29: PERC-04 Spatial Relationship & Visual Hierarchy Reasoning Engine
 */

import { IndexedElement } from '../../src/core/dom_indexer.js';

export type SpatialDirection = 'above' | 'below' | 'left' | 'right';

export interface SpatialRelation {
  sourceId: string;
  targetId: string;
  direction: SpatialDirection;
  distance: number;
}

export interface FormAssociation {
  labelId: string;
  labelText: string;
  inputElement: IndexedElement;
  confidence: number;
}

export class SpatialReasoner {
  /**
   * Computes Euclidean distance between two element centers.
   */
  public static centerDistance(a: IndexedElement, b: IndexedElement): number {
    const ax = a.bounds.x + a.bounds.w / 2;
    const ay = a.bounds.y + a.bounds.h / 2;
    const bx = b.bounds.x + b.bounds.w / 2;
    const by = b.bounds.y + b.bounds.h / 2;
    return Math.hypot(bx - ax, by - ay);
  }

  /**
   * Checks if element A contains element B.
   */
  public static contains(parent: IndexedElement, child: IndexedElement): boolean {
    return (
      child.bounds.x >= parent.bounds.x &&
      child.bounds.y >= parent.bounds.y &&
      child.bounds.x + child.bounds.w <= parent.bounds.x + parent.bounds.w &&
      child.bounds.y + child.bounds.h <= parent.bounds.y + parent.bounds.h
    );
  }

  /**
   * Finds the nearest element to origin in the specified cardinal direction.
   */
  public static findNearestInDirection(
    origin: IndexedElement,
    candidates: IndexedElement[],
    direction: SpatialDirection,
    maxDistance = 500
  ): IndexedElement | null {
    const ox = origin.bounds.x + origin.bounds.w / 2;
    const oy = origin.bounds.y + origin.bounds.h / 2;

    let nearest: IndexedElement | null = null;
    let minScore = Infinity;

    for (const c of candidates) {
      if (c.id === origin.id) continue;
      const cx = c.bounds.x + c.bounds.w / 2;
      const cy = c.bounds.y + c.bounds.h / 2;

      const dx = cx - ox;
      const dy = cy - oy;
      const dist = Math.hypot(dx, dy);

      if (dist > maxDistance) continue;

      let inDirection = false;
      let anglePenalty = 1.0;

      switch (direction) {
        case 'below':
          if (dy > 0 && Math.abs(dx) <= Math.abs(dy) * 1.5) {
            inDirection = true;
            anglePenalty = 1 + Math.abs(dx) / (Math.abs(dy) + 1);
          }
          break;
        case 'above':
          if (dy < 0 && Math.abs(dx) <= Math.abs(dy) * 1.5) {
            inDirection = true;
            anglePenalty = 1 + Math.abs(dx) / (Math.abs(dy) + 1);
          }
          break;
        case 'right':
          if (dx > 0 && Math.abs(dy) <= Math.abs(dx) * 1.5) {
            inDirection = true;
            anglePenalty = 1 + Math.abs(dy) / (Math.abs(dx) + 1);
          }
          break;
        case 'left':
          if (dx < 0 && Math.abs(dy) <= Math.abs(dx) * 1.5) {
            inDirection = true;
            anglePenalty = 1 + Math.abs(dy) / (Math.abs(dx) + 1);
          }
          break;
      }

      if (inDirection) {
        const score = dist * anglePenalty;
        if (score < minScore) {
          minScore = score;
          nearest = c;
        }
      }
    }

    return nearest;
  }

  /**
   * Associates interactive input elements with nearby descriptive label text
   * based on proximity and common form layout patterns (label above input or label to the left).
   */
  public static associateFormFields(
    elements: IndexedElement[],
    textLabels: Array<{ id: string; text: string; bounds: { x: number; y: number; w: number; h: number } }>
  ): FormAssociation[] {
    const inputs = elements.filter(el => ['input', 'textarea', 'select'].includes(el.tag));
    const associations: FormAssociation[] = [];

    for (const input of inputs) {
      let bestLabel: { id: string; text: string; bounds: any } | null = null;
      let bestScore = Infinity;

      for (const lbl of textLabels) {
        const lx = lbl.bounds.x + lbl.bounds.w / 2;
        const ly = lbl.bounds.y + lbl.bounds.h / 2;
        const ix = input.bounds.x + input.bounds.w / 2;
        const iy = input.bounds.y + input.bounds.h / 2;

        const dx = ix - lx;
        const dy = iy - ly;
        const dist = Math.hypot(dx, dy);

        // Pattern 1: Label directly above input (dy > 0 and lx ~= ix)
        if (dy > 0 && dy < 80 && Math.abs(dx) < 150) {
          const score = dist * 0.7; // Prioritize above
          if (score < bestScore) {
            bestScore = score;
            bestLabel = lbl;
          }
        }
        // Pattern 2: Label to the left of input (dx > 0 and ly ~= iy)
        else if (dx > 0 && dx < 250 && Math.abs(dy) < 30) {
          const score = dist * 0.8;
          if (score < bestScore) {
            bestScore = score;
            bestLabel = lbl;
          }
        }
      }

      if (bestLabel) {
        associations.push({
          labelId: bestLabel.id,
          labelText: bestLabel.text,
          inputElement: input,
          confidence: Math.max(0.5, 1 - bestScore / 200)
        });
      }
    }

    return associations;
  }
}

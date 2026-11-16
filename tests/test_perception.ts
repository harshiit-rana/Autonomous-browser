import { AXTreeExtractor, AXNode } from '../src/perception/axtree_extractor.js';
import { SoMOverlayGenerator } from '../src/perception/som_overlay.js';
import { SpatialReasoner } from '../src/perception/spatial_reasoner.js';
import { IndexedElement } from '../src/core/dom_indexer.js';
import * as assert from 'node:assert';

function testAXTreePruning() {
  console.log('--- Testing AXTree Pruning ---');
  const mockRawTree: AXNode = {
    nodeId: 'ax_1',
    role: 'banner',
    name: 'Top Navigation',
    children: [
      {
        nodeId: 'ax_2',
        role: 'generic', // uninformative wrapper that should be pruned/hoisted
        children: [
          {
            nodeId: 'ax_3',
            role: 'link',
            name: 'Home Page',
            bounds: { x: 10, y: 15, w: 60, h: 20 }
          },
          {
            nodeId: 'ax_4',
            role: 'button',
            name: 'Login',
            bounds: { x: 80, y: 15, w: 50, h: 20 }
          }
        ]
      },
      {
        nodeId: 'ax_5',
        role: 'generic', // empty generic wrapper with no name or children -> should be discarded
        children: []
      }
    ]
  };

  const pruned = AXTreeExtractor.pruneTree(mockRawTree);
  console.log('Pruned AXTree output:\n' + pruned.semanticText);

  assert.strictEqual(pruned.interactiveCount, 2, 'Should detect 2 interactive nodes');
  assert.strictEqual(pruned.semanticText.includes('[button] "Login"'), true);
  assert.strictEqual(pruned.semanticText.includes('[link] "Home Page"'), true);
  console.log('✓ AXTree Pruning verified!\n');
}

function testSoMOverlay() {
  console.log('--- Testing Set-of-Marks Overlay Script ---');
  const elements: IndexedElement[] = [
    {
      id: 'agent_btn_search',
      tag: 'button',
      role: 'button',
      text: 'Search',
      bounds: { x: 100, y: 50, w: 80, h: 32 },
      isClickable: true,
      isVisible: true
    },
    {
      id: 'agent_input_query',
      tag: 'input',
      role: 'textbox',
      bounds: { x: 200, y: 50, w: 300, h: 32 },
      isClickable: true,
      isVisible: true
    }
  ];

  const script = SoMOverlayGenerator.getInjectOverlayScript(elements);
  assert.strictEqual(script.includes('aegis-som-overlay-container'), true);
  assert.strictEqual(script.includes('agent_btn_search'), true);
  assert.strictEqual(SoMOverlayGenerator.REMOVE_OVERLAY_SCRIPT.includes('container.remove()'), true);
  console.log('✓ SoM Overlay Script generation verified!\n');
}

function testSpatialReasoner() {
  console.log('--- Testing Spatial Reasoner ---');
  const inputEl: IndexedElement = {
    id: 'input_email',
    tag: 'input',
    bounds: { x: 100, y: 150, w: 200, h: 35 },
    isClickable: true,
    isVisible: true
  };

  const submitBtn: IndexedElement = {
    id: 'btn_submit',
    tag: 'button',
    bounds: { x: 100, y: 220, w: 100, h: 40 },
    isClickable: true,
    isVisible: true
  };

  const cancelBtn: IndexedElement = {
    id: 'btn_cancel',
    tag: 'button',
    bounds: { x: 220, y: 220, w: 80, h: 40 },
    isClickable: true,
    isVisible: true
  };

  // 1. Distance test
  const dist = SpatialReasoner.centerDistance(submitBtn, cancelBtn);
  assert.strictEqual(Math.round(dist), 110);

  // 2. Cardinal direction search: below inputEl should be submitBtn
  const belowInput = SpatialReasoner.findNearestInDirection(inputEl, [submitBtn, cancelBtn], 'below');
  assert.strictEqual(belowInput?.id, 'btn_submit');

  // 3. Form label association
  const labels = [
    { id: 'lbl_email', text: 'Email Address:', bounds: { x: 100, y: 120, w: 120, h: 20 } }
  ];
  const associations = SpatialReasoner.associateFormFields([inputEl], labels);
  assert.strictEqual(associations.length, 1);
  assert.strictEqual(associations[0].labelText, 'Email Address:');
  assert.strictEqual(associations[0].inputElement.id, 'input_email');

  console.log('✓ Spatial Reasoner verified!\n');
}

testAXTreePruning();
testSoMOverlay();
testSpatialReasoner();

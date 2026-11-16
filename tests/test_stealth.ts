import { MouseTrajectoryGenerator } from '../src/stealth/mouse_trajectory.js';
import { KeyboardTyper } from '../src/stealth/keyboard_typer.js';
import { FingerprintShield } from '../src/stealth/fingerprint_shield.js';
import * as assert from 'node:assert';

function testMouseTrajectory() {
  console.log('--- Testing MouseTrajectoryGenerator ---');
  const start = { x: 50, y: 50 };
  const target = { x: 800, y: 600 };

  const traj = MouseTrajectoryGenerator.generateTrajectory(start, target, {
    targetWidth: 32,
    targetHeight: 32,
    overshootProbability: 0.0 // Deterministic test without overshoot
  });

  console.log(`Generated trajectory with ${traj.length} waypoints.`);
  assert.strictEqual(traj.length > 10, true, 'Trajectory should have > 10 waypoints');
  assert.strictEqual(traj[0].x, start.x);
  assert.strictEqual(traj[0].y, start.y);
  assert.strictEqual(traj[traj.length - 1].x, target.x);
  assert.strictEqual(traj[traj.length - 1].y, target.y);

  // Check timestamp progression
  for (let i = 1; i < traj.length; i++) {
    assert.strictEqual(traj[i].timestamp >= traj[i - 1].timestamp, true, 'Timestamps must be monotonically non-decreasing');
  }

  // Test overshoot behavior
  const trajOvershoot = MouseTrajectoryGenerator.generateTrajectory(start, target, {
    overshootProbability: 1.0 // Force overshoot
  });
  console.log(`Generated overshoot trajectory with ${trajOvershoot.length} waypoints.`);
  assert.strictEqual(trajOvershoot[trajOvershoot.length - 1].x, target.x);
  assert.strictEqual(trajOvershoot[trajOvershoot.length - 1].y, target.y);

  console.log('✓ MouseTrajectoryGenerator tests passed!\n');
}

function testKeyboardTyper() {
  console.log('--- Testing KeyboardTyper ---');
  const text = 'Project Aegis';
  const steps = KeyboardTyper.planKeystrokes(text, {
    wordsPerMinute: 60,
    typoRate: 0.0 // No typos for deterministic baseline
  });

  console.log(`Planned ${steps.length} key steps for "${text}".`);
  assert.strictEqual(steps.length > 0, true);

  // Check uppercase Shift generation
  const shiftSteps = steps.filter(s => s.key === 'Shift');
  assert.strictEqual(shiftSteps.length >= 2, true, 'Both "P" and "A" require Shift keys');

  // Test typo generation
  const typoSteps = KeyboardTyper.planKeystrokes('Hello World', {
    wordsPerMinute: 60,
    typoRate: 1.0 // Force typos
  });
  const backspaces = typoSteps.filter(s => s.key === 'Backspace');
  console.log(`Generated ${backspaces.length} backspace events under high typo rate.`);
  assert.strictEqual(backspaces.length > 0, true, 'Should simulate typo corrections with Backspace');

  console.log('✓ KeyboardTyper tests passed!\n');
}

function testFingerprintShield() {
  console.log('--- Testing FingerprintShield ---');
  const script = FingerprintShield.getStealthScript({
    spoofVendor: 'Google Inc. (NVIDIA)',
    spoofRenderer: 'ANGLE (NVIDIA RTX 3070)',
    hardwareConcurrency: 16,
    deviceMemory: 16
  });

  assert.strictEqual(script.includes('navigator.webdriver'), true);
  assert.strictEqual(script.includes('WebGLRenderingContext'), true);
  assert.strictEqual(script.includes('CanvasRenderingContext2D.prototype.getImageData'), true);
  assert.strictEqual(script.includes('AudioBuffer.prototype.getChannelData'), true);
  assert.strictEqual(script.includes('ANGLE (NVIDIA RTX 3070)'), true);

  console.log('✓ FingerprintShield tests passed!\n');
}

testMouseTrajectory();
testKeyboardTyper();
testFingerprintShield();

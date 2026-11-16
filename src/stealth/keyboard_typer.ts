/**
 * Project Aegis - Human Cadence Keyboard Typer with Latency & Typo Simulation
 * 
 * Implements:
 * - Issue #22: CORE-07 Human Cadence Keyboard Typer with Latency & Typo Simulation
 */

export interface KeyEventStep {
  type: 'keyDown' | 'keyUp' | 'char';
  key: string;
  code: string;
  text?: string;
  delayBeforeMs: number;
}

export interface TyperOptions {
  wordsPerMinute?: number; // Target average WPM (default: 65)
  typoRate?: number; // Typo probability per keystroke (default: 0.02 = 2%)
  burstiness?: number; // Cadence variation factor (default: 0.3)
}

export class KeyboardTyper {
  // QWERTY adjacent key map for realistic human finger slips
  private static readonly ADJACENT_KEYS: Record<string, string[]> = {
    'q': ['w', 'a', '1', '2'],
    'w': ['q', 'e', 's', 'a', '2', '3'],
    'e': ['w', 'r', 'd', 's', '3', '4'],
    'r': ['e', 't', 'f', 'd', '4', '5'],
    't': ['r', 'y', 'g', 'f', '5', '6'],
    'y': ['t', 'u', 'h', 'g', '6', '7'],
    'u': ['y', 'i', 'j', 'h', '7', '8'],
    'i': ['u', 'o', 'k', 'j', '8', '9'],
    'o': ['i', 'p', 'l', 'k', '9', '0'],
    'p': ['o', '[', ';', 'l', '0', '-'],
    'a': ['q', 'w', 's', 'z'],
    's': ['a', 'w', 'e', 'd', 'x', 'z'],
    'd': ['s', 'e', 'r', 'f', 'c', 'x'],
    'f': ['d', 'r', 't', 'g', 'v', 'c'],
    'g': ['f', 't', 'y', 'h', 'b', 'v'],
    'h': ['g', 'y', 'u', 'j', 'n', 'b'],
    'j': ['h', 'u', 'i', 'k', 'm', 'n'],
    'k': ['j', 'i', 'o', 'l', ',', 'm'],
    'l': ['k', 'o', 'p', ';', '.', ','],
    'z': ['a', 's', 'x'],
    'x': ['z', 's', 'd', 'c'],
    'c': ['x', 'd', 'f', 'v', ' '],
    'v': ['c', 'f', 'g', 'b', ' '],
    'b': ['v', 'g', 'h', 'n', ' '],
    'n': ['b', 'h', 'j', 'm', ' '],
    'm': ['n', 'j', 'k', ',', ' ']
  };

  /**
   * Generates a realistic sequence of CDP key events including natural jitter,
   * hold times, and simulated typo/correction sequences.
   */
  public static planKeystrokes(text: string, options: TyperOptions = {}): KeyEventStep[] {
    const wpm = options.wordsPerMinute ?? 65;
    const typoRate = options.typoRate ?? 0.02;
    // Average 5 chars per word: chars/sec = (wpm * 5) / 60 => avg ms per char = 60000 / (wpm * 5)
    const baseDelay = 60000 / (wpm * 5);

    const steps: KeyEventStep[] = [];

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const lower = char.toLowerCase();
      const isUpper = char !== lower;

      // Sample inter-key delay using log-normal approximation
      const jitter = Math.exp((Math.random() - 0.5) * 0.4);
      let interKeyDelay = baseDelay * jitter;

      // Spaces and punctuation have slightly longer pauses
      if (char === ' ') {
        interKeyDelay *= 1.4;
      } else if (['.', ',', '!', '?', ';'].includes(char)) {
        interKeyDelay *= 1.8;
      }

      // Check for typo occurrence (only on alphabetic characters and not on first character)
      const shouldTypo = i > 0 && Math.random() < typoRate && KeyboardTyper.ADJACENT_KEYS[lower];

      if (shouldTypo) {
        const adjacentList = KeyboardTyper.ADJACENT_KEYS[lower];
        const mistypedChar = adjacentList[Math.floor(Math.random() * adjacentList.length)];
        const typoHold = Math.round(45 + Math.random() * 30);

        // Strike wrong key
        steps.push({
          type: 'keyDown',
          key: mistypedChar,
          code: `Key${mistypedChar.toUpperCase()}`,
          text: mistypedChar,
          delayBeforeMs: Math.round(interKeyDelay)
        });
        steps.push({
          type: 'keyUp',
          key: mistypedChar,
          code: `Key${mistypedChar.toUpperCase()}`,
          delayBeforeMs: typoHold
        });

        // Human reaction time pause before noticing mistake (~120ms - 260ms)
        const reactionDelay = Math.round(120 + Math.random() * 140);
        const backspaceHold = Math.round(50 + Math.random() * 25);

        // Hit backspace
        steps.push({
          type: 'keyDown',
          key: 'Backspace',
          code: 'Backspace',
          delayBeforeMs: reactionDelay
        });
        steps.push({
          type: 'keyUp',
          key: 'Backspace',
          code: 'Backspace',
          delayBeforeMs: backspaceHold
        });

        // Small pause before typing corrected character
        interKeyDelay = 80 + Math.random() * 60;
      }

      // Handle Shift modifier for uppercase
      if (isUpper && /[A-Z]/.test(char)) {
        steps.push({
          type: 'keyDown',
          key: 'Shift',
          code: 'ShiftLeft',
          delayBeforeMs: Math.round(Math.max(10, interKeyDelay * 0.3))
        });
      }

      const holdTime = Math.round(40 + Math.random() * 35);
      const code = KeyboardTyper.getKeyCode(char);

      // Intended key down
      steps.push({
        type: 'keyDown',
        key: char,
        code,
        text: char,
        delayBeforeMs: Math.round(interKeyDelay)
      });

      // Intended key up
      steps.push({
        type: 'keyUp',
        key: char,
        code,
        delayBeforeMs: holdTime
      });

      // Release Shift modifier if active
      if (isUpper && /[A-Z]/.test(char)) {
        steps.push({
          type: 'keyUp',
          key: 'Shift',
          code: 'ShiftLeft',
          delayBeforeMs: 15
        });
      }
    }

    return steps;
  }

  private static getKeyCode(char: string): string {
    if (/[a-zA-Z]/.test(char)) {
      return `Key${char.toUpperCase()}`;
    }
    if (/[0-9]/.test(char)) {
      return `Digit${char}`;
    }
    switch (char) {
      case ' ': return 'Space';
      case '\n': case '\r': return 'Enter';
      case '\t': return 'Tab';
      case '.': return 'Period';
      case ',': return 'Comma';
      case '-': case '_': return 'Minus';
      case '=': case '+': return 'Equal';
      case '/': case '?': return 'Slash';
      default: return 'Unidentified';
    }
  }
}

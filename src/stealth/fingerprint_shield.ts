/**
 * Project Aegis - Cross-Platform Anti-Bot Evasion & Fingerprint Shield
 * 
 * Implements:
 * - Issue #23: CORE-08 Cross-Platform Anti-Bot Evasion & Navigator Fingerprint Masking
 * - Issue #70: STEALTH-03 WebRTC & AudioContext Fingerprint Normalization
 * - Issue #71: STEALTH-04 Canvas & WebGL Pixel Noise Randomizer
 */

export interface FingerprintShieldOptions {
  spoofVendor?: string;
  spoofRenderer?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  languages?: string[];
}

export class FingerprintShield {
  /**
   * Generates the stealth injection script for CDP Page.addScriptToEvaluateOnNewDocument.
   */
  public static getStealthScript(options: FingerprintShieldOptions = {}): string {
    const vendor = options.spoofVendor || 'Google Inc. (NVIDIA)';
    const renderer = options.spoofRenderer || 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const concurrency = options.hardwareConcurrency || 8;
    const memory = options.deviceMemory || 8;
    const languages = JSON.stringify(options.languages || ['en-US', 'en']);

    return `
(() => {
  'use strict';

  // 1. Mask navigator.webdriver
  try {
    delete Object.getPrototypeOf(navigator).webdriver;
  } catch (e) {}

  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
    enumerable: true
  });

  // 2. Hardware specs normalization
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => ${concurrency},
    configurable: true,
    enumerable: true
  });

  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => ${memory},
    configurable: true,
    enumerable: true
  });

  Object.defineProperty(navigator, 'languages', {
    get: () => ${languages},
    configurable: true,
    enumerable: true
  });

  // 3. Realistic window.chrome object
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
      PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
      RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
      OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
      OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
      connect: function() {},
      sendMessage: function() {}
    };
  }

  // 4. Permissions Query Mock (prevents notification state detection)
  if (navigator.permissions && navigator.permissions.query) {
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(param) {
      if (param && param.name === 'notifications') {
        return Promise.resolve({
          state: 'default',
          name: 'notifications',
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false
        });
      }
      return originalQuery(param);
    };
  }

  // 5. WebGL Vendor & Renderer Masking
  const getParameterHandler = {
    apply: function(target, ctx, args) {
      const param = args[0];
      // UNMASKED_VENDOR_WEBGL = 0x9245
      if (param === 37445) {
        return '${vendor}';
      }
      // UNMASKED_RENDERER_WEBGL = 0x9246
      if (param === 37446) {
        return '${renderer}';
      }
      return Reflect.apply(target, ctx, args);
    }
  };

  if (typeof WebGLRenderingContext !== 'undefined') {
    WebGLRenderingContext.prototype.getParameter = new Proxy(WebGLRenderingContext.prototype.getParameter, getParameterHandler);
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    WebGL2RenderingContext.prototype.getParameter = new Proxy(WebGL2RenderingContext.prototype.getParameter, getParameterHandler);
  }

  // 6. Canvas Deterministic Sub-pixel Noise (Issue #71)
  const getDomainHash = () => {
    const host = window.location.hostname || 'localhost';
    let hash = 0;
    for (let i = 0; i < host.length; i++) {
      hash = ((hash << 5) - hash + host.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 3 + 1; // 1, 2, or 3
  };

  if (typeof CanvasRenderingContext2D !== 'undefined') {
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(sx, sy, sw, sh, settings) {
      const imgData = originalGetImageData.call(this, sx, sy, sw, sh, settings);
      const shift = getDomainHash();
      // Add imperceptible perturbation to least significant bits
      for (let i = 0; i < imgData.data.length; i += 40) {
        imgData.data[i] = (imgData.data[i] + shift) % 256;
      }
      return imgData;
    };
  }

  // 7. AudioContext Perturbation Normalization (Issue #70)
  if (typeof AudioBuffer !== 'undefined') {
    const originalGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = originalGetChannelData.call(this, channel);
      const shift = (getDomainHash() * 0.0000001);
      for (let i = 0; i < data.length; i += 100) {
        data[i] += shift;
      }
      return data;
    };
  }

  // 8. Plugins array emulation
  try {
    const fakePlugins = [
      { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
    ];

    Object.defineProperty(navigator, 'plugins', {
      get: () => fakePlugins,
      enumerable: true,
      configurable: true
    });
  } catch (e) {}

})();
    `;
  }
}

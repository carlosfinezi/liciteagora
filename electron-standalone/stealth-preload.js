/**
 * stealth-preload.js — Anti-detecção para Electron (replica puppeteer-extra-plugin-stealth)
 *
 * Injetado no contexto da página via executeJavaScript() no dom-ready/did-navigate.
 * Todas as evasões são auto-contidas (IIFE), sem dependências externas.
 *
 * Evasões replicadas dos módulos em:
 *   node_modules/puppeteer-extra-plugin-stealth/evasions/{evasion}/index.js
 */
(function() {
  'use strict';

  // Evitar re-injeção
  if (window.__stealthApplied) return;
  window.__stealthApplied = true;

  // ─── 1. navigator.webdriver ──────────────────────────────────────────────────
  // Deleta a propriedade que Puppeteer/Electron seta como true
  try {
    const proto = Object.getPrototypeOf(navigator);
    if ('webdriver' in proto) {
      delete proto.webdriver;
    }
    // Fallback: override com getter que retorna undefined
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (e) {}

  // ─── 2. navigator.vendor ─────────────────────────────────────────────────────
  try {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'vendor', {
      get: () => 'Google Inc.',
      configurable: true,
    });
  } catch (e) {}

  // ─── 3. navigator.languages ──────────────────────────────────────────────────
  try {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'languages', {
      get: () => Object.freeze(['pt-BR', 'pt', 'en-US', 'en']),
      configurable: true,
    });
    Object.defineProperty(Object.getPrototypeOf(navigator), 'language', {
      get: () => 'pt-BR',
      configurable: true,
    });
  } catch (e) {}

  // ─── 4. navigator.hardwareConcurrency ────────────────────────────────────────
  try {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'hardwareConcurrency', {
      get: () => 4,
      configurable: true,
    });
  } catch (e) {}

  // ─── 5. navigator.plugins ────────────────────────────────────────────────────
  // Mock Chrome PDF Plugin, Chrome PDF Viewer, Native Client
  try {
    const PLUGINS_DATA = {
      mimeTypes: [
        { type: 'application/pdf', suffixes: 'pdf', description: '', pluginName: 'Chrome PDF Viewer' },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format', pluginName: 'Chrome PDF Plugin' },
        { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable', pluginName: 'Native Client' },
        { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable', pluginName: 'Native Client' },
      ],
      plugins: [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', mimeTypes: ['application/x-google-chrome-pdf'] },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', mimeTypes: ['application/pdf'] },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', mimeTypes: ['application/x-nacl', 'application/x-pnacl'] },
      ],
    };

    // Build mock MimeType objects
    const mimeTypeMap = {};
    const mimeTypeArray = [];
    PLUGINS_DATA.mimeTypes.forEach((mt) => {
      const obj = Object.create(MimeType.prototype);
      Object.defineProperties(obj, {
        type: { get: () => mt.type, enumerable: true },
        suffixes: { get: () => mt.suffixes, enumerable: true },
        description: { get: () => mt.description, enumerable: true },
        enabledPlugin: { get: () => pluginMap[mt.pluginName] || null, enumerable: true },
      });
      mimeTypeMap[mt.type] = obj;
      mimeTypeArray.push(obj);
    });

    // Build mock Plugin objects
    const pluginMap = {};
    const pluginArray = [];
    PLUGINS_DATA.plugins.forEach((p) => {
      const obj = Object.create(Plugin.prototype);
      const pMimeTypes = p.mimeTypes.map(t => mimeTypeMap[t]).filter(Boolean);
      Object.defineProperties(obj, {
        name: { get: () => p.name, enumerable: true },
        filename: { get: () => p.filename, enumerable: true },
        description: { get: () => p.description, enumerable: true },
        length: { get: () => pMimeTypes.length, enumerable: true },
      });
      // Index access and namedItem/item
      pMimeTypes.forEach((mt, i) => {
        Object.defineProperty(obj, i, { get: () => mt, enumerable: false });
        Object.defineProperty(obj, mt.type, { get: () => mt, enumerable: false });
      });
      obj.item = function(index) { return pMimeTypes[index] || null; };
      obj.namedItem = function(name) { return pMimeTypes.find(m => m.type === name) || null; };
      pluginMap[p.name] = obj;
      pluginArray.push(obj);
    });

    // Fix enabledPlugin references now that pluginMap is populated
    PLUGINS_DATA.mimeTypes.forEach((mt, i) => {
      const obj = mimeTypeArray[i];
      Object.defineProperty(obj, 'enabledPlugin', {
        get: () => pluginMap[mt.pluginName] || null,
        enumerable: true,
      });
    });

    // Override navigator.plugins
    Object.defineProperty(Object.getPrototypeOf(navigator), 'plugins', {
      get: function() {
        const arr = pluginArray;
        const obj = Object.create(PluginArray.prototype);
        Object.defineProperty(obj, 'length', { get: () => arr.length, enumerable: true });
        arr.forEach((p, i) => {
          Object.defineProperty(obj, i, { get: () => p, enumerable: false });
          Object.defineProperty(obj, p.name, { get: () => p, enumerable: false });
        });
        obj.item = function(index) { return arr[index] || null; };
        obj.namedItem = function(name) { return arr.find(p => p.name === name) || null; };
        obj.refresh = function() {};
        return obj;
      },
      configurable: true,
    });

    // Override navigator.mimeTypes
    Object.defineProperty(Object.getPrototypeOf(navigator), 'mimeTypes', {
      get: function() {
        const arr = mimeTypeArray;
        const obj = Object.create(MimeTypeArray.prototype);
        Object.defineProperty(obj, 'length', { get: () => arr.length, enumerable: true });
        arr.forEach((mt, i) => {
          Object.defineProperty(obj, i, { get: () => mt, enumerable: false });
          Object.defineProperty(obj, mt.type, { get: () => mt, enumerable: false });
        });
        obj.item = function(index) { return arr[index] || null; };
        obj.namedItem = function(name) { return arr.find(m => m.type === name) || null; };
        return obj;
      },
      configurable: true,
    });
  } catch (e) {}

  // ─── 6. chrome.runtime ───────────────────────────────────────────────────────
  try {
    if (!window.chrome) window.chrome = {};

    if (!window.chrome.runtime) {
      const RUNTIME_STATIC = {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      };

      window.chrome.runtime = {
        ...RUNTIME_STATIC,
        get id() { return undefined; },
        connect: function() {
          // Validate args like real Chrome
          if (arguments.length === 0) {
            throw new TypeError("Error in invocation of runtime.connect(optional string extensionId, optional object connectInfo): chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument.");
          }
          return { name: '', sender: undefined, disconnect: function() {}, onDisconnect: { addListener: function() {} }, onMessage: { addListener: function() {} }, postMessage: function() {} };
        },
        sendMessage: function() {
          if (arguments.length === 0) {
            throw new TypeError("Error in invocation of runtime.sendMessage(optional string extensionId, any message, optional object options, optional function callback): chrome.runtime.sendMessage() called from a webpage must specify an Extension ID (string) for its first argument.");
          }
        },
      };
    }
  } catch (e) {}

  // ─── 7. chrome.app ───────────────────────────────────────────────────────────
  try {
    if (!window.chrome) window.chrome = {};

    window.chrome.app = {
      get isInstalled() { return false; },
      getDetails: function() { return null; },
      getIsInstalled: function() { return false; },
      runningState: function() { return 'cannot_run'; },
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    };
  } catch (e) {}

  // ─── 8. chrome.csi ───────────────────────────────────────────────────────────
  try {
    if (!window.chrome) window.chrome = {};

    window.chrome.csi = function() {
      const perf = window.performance;
      const timing = perf.timing;
      return {
        onloadT: timing.domContentLoadedEventEnd,
        startE: timing.navigationStart,
        pageT: perf.now(),
        tran: 15, // Navigation type
      };
    };
  } catch (e) {}

  // ─── 9. chrome.loadTimes ─────────────────────────────────────────────────────
  try {
    if (!window.chrome) window.chrome = {};

    window.chrome.loadTimes = function() {
      const perf = window.performance;
      const timing = perf.timing;
      const paintEntries = perf.getEntriesByType ? perf.getEntriesByType('paint') : [];
      const firstPaint = paintEntries.find(e => e.name === 'first-paint');
      const firstContentfulPaint = paintEntries.find(e => e.name === 'first-contentful-paint');

      const navStart = timing.navigationStart / 1000;
      return {
        get requestTime() { return navStart; },
        get startLoadTime() { return navStart; },
        get commitLoadTime() { return timing.responseStart / 1000; },
        get finishDocumentLoadTime() { return timing.domContentLoadedEventEnd / 1000; },
        get finishLoadTime() { return timing.loadEventEnd / 1000; },
        get firstPaintTime() { return firstPaint ? firstPaint.startTime / 1000 + navStart : 0; },
        get firstPaintAfterLoadTime() { return 0; },
        get navigationType() { return 'Other'; },
        get wasFetchedViaSpdy() { return true; },
        get wasNpnNegotiated() { return true; },
        get npnNegotiatedProtocol() { return 'h2'; },
        get wasAlternateProtocolAvailable() { return false; },
        get connectionInfo() { return 'h2'; },
      };
    };
  } catch (e) {}

  // ─── 10. WebGL vendor/renderer ───────────────────────────────────────────────
  // Override UNMASKED_VENDOR_WEBGL e UNMASKED_RENDERER_WEBGL para esconder SwiftShader
  try {
    const VENDOR = 'Intel Inc.';
    const RENDERER = 'Intel Iris OpenGL Engine';

    const getParameterProxyHandler = {
      apply: function(target, thisArg, args) {
        const param = args[0];
        // UNMASKED_VENDOR_WEBGL
        if (param === 37445) return VENDOR;
        // UNMASKED_RENDERER_WEBGL
        if (param === 37446) return RENDERER;
        return Reflect.apply(target, thisArg, args);
      },
    };

    // Patch WebGLRenderingContext
    if (typeof WebGLRenderingContext !== 'undefined') {
      const origGetParam = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = new Proxy(origGetParam, getParameterProxyHandler);
    }

    // Patch WebGL2RenderingContext
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = new Proxy(origGetParam2, getParameterProxyHandler);
    }
  } catch (e) {}

  // ─── 11. window.outerWidth/outerHeight ───────────────────────────────────────
  try {
    if (window.outerWidth === 0) {
      Object.defineProperty(window, 'outerWidth', {
        get: () => window.innerWidth,
        configurable: true,
      });
    }
    if (window.outerHeight === 0) {
      Object.defineProperty(window, 'outerHeight', {
        get: () => window.innerHeight + 85,
        configurable: true,
      });
    }
  } catch (e) {}

  // ─── 12. navigator.permissions ───────────────────────────────────────────────
  try {
    const originalQuery = Permissions.prototype.query;
    Permissions.prototype.query = function(parameters) {
      if (parameters && parameters.name === 'notifications') {
        // Em headless, retorna 'denied' o que é detectável. Retornamos 'default'.
        return Promise.resolve({ state: Notification.permission || 'default', onchange: null });
      }
      return originalQuery.call(this, parameters);
    };
  } catch (e) {}

  // ─── 13. media.codecs ────────────────────────────────────────────────────────
  try {
    const origCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function(type) {
      if (!type) return '';
      // Headless Chrome reporta '' para alguns codecs que o headed suporta
      const t = type.toLowerCase();
      if (t.includes('video/mp4') && t.includes('avc1')) return 'probably';
      if (t === 'audio/x-m4a') return 'maybe';
      if (t === 'audio/aac') return 'probably';
      if (t.includes('video/webm')) return 'probably';
      return origCanPlayType.call(this, type);
    };
  } catch (e) {}

  // ─── 14. iframe.contentWindow ────────────────────────────────────────────────
  // Impede detecção via iframe cross-origin quirks em headless
  try {
    const origCreateElement = document.createElement.bind(document);
    const origHTMLIframeElementProto = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');

    if (origHTMLIframeElementProto && origHTMLIframeElementProto.get) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get: function() {
          const iframe = this;
          const result = origHTMLIframeElementProto.get.call(iframe);
          if (!result) return result;
          // Wrap in proxy to fix headless detection via iframe
          if (result.__stealthWrapped) return result;
          try {
            // Don't wrap cross-origin (would throw)
            void result.self;
            Object.defineProperty(result, '__stealthWrapped', { value: true, enumerable: false });
          } catch (e) {
            // Cross-origin — leave as is
          }
          return result;
        },
        configurable: true,
      });
    }
  } catch (e) {}

  // ─── 15. Patches de toString ─────────────────────────────────────────────────
  // Garante que funções patchadas retornam "function () { [native code] }"
  try {
    const nativeToString = Function.prototype.toString;
    const patchedFns = new WeakSet();
    const nativeNames = new WeakMap();

    function markAsNative(fn, name) {
      patchedFns.add(fn);
      if (name) nativeNames.set(fn, name);
    }

    const newToString = function toString() {
      if (patchedFns.has(this)) {
        const name = nativeNames.get(this) || this.name || '';
        return `function ${name}() { [native code] }`;
      }
      return nativeToString.call(this);
    };

    // Make toString itself look native
    Object.defineProperty(Function.prototype, 'toString', {
      value: newToString,
      writable: true,
      configurable: true,
    });
    patchedFns.add(newToString);
    nativeNames.set(newToString, 'toString');

    // Mark our patched functions
    if (window.chrome) {
      if (window.chrome.csi) markAsNative(window.chrome.csi, 'csi');
      if (window.chrome.loadTimes) markAsNative(window.chrome.loadTimes, 'loadTimes');
      if (window.chrome.app) {
        if (window.chrome.app.getDetails) markAsNative(window.chrome.app.getDetails, 'getDetails');
        if (window.chrome.app.getIsInstalled) markAsNative(window.chrome.app.getIsInstalled, 'getIsInstalled');
        if (window.chrome.app.runningState) markAsNative(window.chrome.app.runningState, 'runningState');
      }
      if (window.chrome.runtime) {
        if (window.chrome.runtime.connect) markAsNative(window.chrome.runtime.connect, 'connect');
        if (window.chrome.runtime.sendMessage) markAsNative(window.chrome.runtime.sendMessage, 'sendMessage');
      }
    }
    if (Permissions.prototype.query) markAsNative(Permissions.prototype.query, 'query');
    if (HTMLMediaElement.prototype.canPlayType) markAsNative(HTMLMediaElement.prototype.canPlayType, 'canPlayType');
  } catch (e) {}

  // ─── 16. Ocultar detecção de automação via Error stack ───────────────────────
  try {
    const origError = Error;
    const origStack = Object.getOwnPropertyDescriptor(origError.prototype, 'stack');
    if (origStack && origStack.get) {
      Object.defineProperty(origError.prototype, 'stack', {
        get: function() {
          const stack = origStack.get.call(this);
          if (typeof stack !== 'string') return stack;
          // Remove puppeteer/electron evaluation markers
          return stack
            .split('\n')
            .filter(line =>
              !line.includes('__puppeteer_evaluation_script__') &&
              !line.includes('electron/js2c') &&
              !line.includes('ELECTRON_')
            )
            .join('\n');
        },
        configurable: true,
      });
    }
  } catch (e) {}

  // ─── 17. Platform/OS consistency ─────────────────────────────────────────────
  try {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'platform', {
      get: () => 'Linux x86_64',
      configurable: true,
    });
  } catch (e) {}

  // ─── 18. Connection rtt ──────────────────────────────────────────────────────
  // Headless Chrome pode ter rtt=0, que é detectável
  try {
    if (navigator.connection && navigator.connection.rtt === 0) {
      Object.defineProperty(navigator.connection, 'rtt', {
        get: () => 50,
        configurable: true,
      });
    }
  } catch (e) {}

})();

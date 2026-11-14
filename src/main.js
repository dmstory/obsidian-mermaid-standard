import { Notice, Plugin } from 'obsidian';
import mermaid from 'mermaid';

/**
 * Obsidian 1.15+ renders ```mermaid blocks with its own engine (lib/pele.min.js,
 * "Pele") instead of upstream mermaid. Pele keeps the syntax but ignores the
 * decoration layer, so `theme`, `look` and `themeVariables` have no effect.
 *
 * Both reading view and live preview end up in `pele.mount(el, source, opts)`.
 * This plugin swaps that single method for real mermaid rendering.
 */

const HOOK_FLAG = '__mermaidStandardPele';
const ORIGINAL_FLAG = '__mermaidStandardOriginalPele';

const baseConfig = () => {
  let font = 'sans-serif';
  try {
    font = getComputedStyle(document.body).getPropertyValue('--font-mermaid').trim() || font;
  } catch (e) {
    /* not in a DOM context, keep default */
  }
  const dark = document.body.classList.contains('theme-dark');
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    theme: dark ? 'dark' : 'default',
    fontFamily: font,
    themeVariables: { fontFamily: font },
    flowchart: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
    er: { useMaxWidth: false },
  };
};

export default class MermaidStandardPlugin extends Plugin {
  controllers = new Set();

  async onload() {
    this.hookPele();
    this.registerEvent(this.app.workspace.on('css-change', () => this.refreshAll()));
    this.addCommand({
      id: 'rerender-current-note',
      name: 'Re-render diagrams in current note',
      callback: () => this.rerenderActiveNote(),
    });
  }

  onunload() {
    if (globalThis[HOOK_FLAG] && globalThis.pele === globalThis[HOOK_FLAG]) {
      globalThis.pele = globalThis[ORIGINAL_FLAG];
    }
    delete globalThis[HOOK_FLAG];
    delete globalThis[ORIGINAL_FLAG];
    this.controllers.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Hook pele.mount                                                     */
  /* ------------------------------------------------------------------ */

  hookPele() {
    const tryHook = () => {
      const pele = globalThis.pele;
      if (!pele || typeof pele.mount !== 'function') return false;
      if (globalThis[HOOK_FLAG]) return true;

      // pele's exports are getter-only, so the object is wrapped instead of mutated.
      const wrapper = Object.create(pele);
      Object.defineProperty(wrapper, 'mount', {
        value: (el, source, opts) => this.mount(el, source, opts),
        writable: true,
        configurable: true,
        enumerable: true,
      });
      globalThis[ORIGINAL_FLAG] = pele;
      globalThis[HOOK_FLAG] = wrapper;
      globalThis.pele = wrapper;
      return true;
    };

    if (tryHook()) return;
    // pele is loaded lazily by the app, so poll until it shows up.
    const timer = window.setInterval(() => {
      if (tryHook()) window.clearInterval(timer);
    }, 200);
    this.register(() => window.clearInterval(timer));
  }

  /* ------------------------------------------------------------------ */
  /* pele.mount-compatible controller                                    */
  /* ------------------------------------------------------------------ */

  mount(el, source, opts) {
    const ctrl = {
      result: null,
      source,
      error: null,
      zoom: opts && opts.zoom,
      _token: 0,
      _destroyed: false,
      update: (next) => {
        ctrl.source = next;
        return ctrl.refresh();
      },
      refresh: () => {
        const token = ++ctrl._token;
        return this.paint(el, ctrl, opts, token);
      },
      destroy: () => {
        ctrl._destroyed = true;
        this.controllers.delete(ctrl);
      },
    };
    this.controllers.add(ctrl);
    ctrl.refresh();
    return ctrl;
  }

  async paint(el, ctrl, opts, token) {
    try {
      mermaid.initialize(baseConfig());
      const id = 'mermaid-standard-' + Math.random().toString(36).slice(2, 10);
      const rendered = await mermaid.render(id, ctrl.source);
      if (ctrl._destroyed || token !== ctrl._token) return;

      const holder = document.createElement('div');
      holder.innerHTML = rendered.svg;
      const root = holder.firstElementChild;
      el.replaceChildren();
      if (root) el.appendChild(root);

      if (typeof rendered.bindFunctions === 'function') {
        try {
          rendered.bindFunctions(el);
        } catch (e) {
          /* interactive bindings are optional */
        }
      }

      const box = root && root.viewBox && root.viewBox.baseVal;
      ctrl.error = null;
      ctrl.result = {
        type: null,
        mermaidType: null,
        svg: rendered.svg,
        width: box ? box.width : 0,
        height: box ? box.height : 0,
        links: [],
      };
      if (opts && typeof opts.onRender === 'function') opts.onRender(ctrl.result);
    } catch (err) {
      if (ctrl._destroyed || token !== ctrl._token) return;
      ctrl.error = err;
      ctrl.result = null;
      el.replaceChildren();
      const box = document.createElement('div');
      box.className = 'mermaid-standard-error';
      box.textContent = 'Mermaid: ' + (err && err.message ? err.message : String(err));
      el.appendChild(box);
      if (opts && typeof opts.onRender === 'function') opts.onRender(ctrl.result);
    }
  }

  /* ------------------------------------------------------------------ */

  refreshAll() {
    for (const ctrl of Array.from(this.controllers)) ctrl.refresh();
  }

  rerenderActiveNote() {
    const view = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.view;
    if (view && view.previewMode && typeof view.previewMode.rerender === 'function') {
      view.previewMode.rerender(true);
      return;
    }
    this.refreshAll();
  }
}

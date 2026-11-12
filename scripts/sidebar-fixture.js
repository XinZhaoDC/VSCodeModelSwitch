'use strict';
// A dependency-free DOM harness executing the complete shipped webview script.
// It checks structure/events/state, not browser layout or VS Code rendering.
const assert = require('node:assert/strict');
const vm = require('node:vm');
function sidebarFixture(html, initialViewState = {}) {
  const messages = [], windowListeners = {}, documentListeners = {};
  let viewState = initialViewState, scrollCalls = 0, now = Date.now(), nextTimer = 0;
  const timers = new Map();
  const schedule = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; };
  const cancel = id => timers.delete(id);
  class FixtureDate extends Date { static now() { return now; } }
  const datasetKey = name => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.style = {};
      this.disabled = false; this.hidden = false; this.checked = false; this.open = false; this.type = ''; this.className = ''; this.id = ''; this._value = ''; this._text = '';
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(n => !names.includes(n)).join(' '); },
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name, force) => { const on = force === undefined ? !this.classList.contains(name) : force; on ? this.classList.add(name) : this.classList.remove(name); return on; }
      };
    }
    get childNodes() { const owner = this; return [{ nodeType: 3, get nodeValue() { return owner._text; }, set nodeValue(value) { owner._text = value; } }, ...this.children]; }
    get options() { return this.children.filter(c => c.tagName === 'OPTION'); }
    get value() {
      if (this.tagName === 'SELECT') return this.options.some(o => o.value === this._value) ? this._value : this.options[0]?.value || '';
      return this._value;
    }
    set value(value) { this._value = String(value); }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(text) { this._text = String(text); for (const c of this.children) c.parentElement = null; this.children = []; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; return child; }
    append(...children) { for (const child of children) this.appendChild(child); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; }
    insertBefore(child, before) { child.remove(); const index = this.children.indexOf(before); assert.ok(index >= 0); this.children.splice(index, 0, child); child.parentElement = this; }
    before(child) { assert.ok(this.parentElement); this.parentElement.insertBefore(child, this); }
    after(child) { const p = this.parentElement; assert.ok(p); child.remove(); const index = p.children.indexOf(this); p.children.splice(index + 1, 0, child); child.parentElement = p; }
    setAttribute(name, value) { if (name.startsWith('data-')) this.dataset[datasetKey(name)] = String(value); else this[name] = String(value); }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    querySelectorAll(selector) { return descend(this).filter(e => selector.split(',').some(s => match(e, s.trim()))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    scrollIntoView() { scrollCalls++; } focus() {}
  }
  const descend = parent => parent.children.flatMap(e => [e, ...descend(e)]);
  const match = (e, selector) => selector.startsWith('.') ? e.classList.contains(selector.slice(1)) : selector.startsWith('#') ? e.id === selector.slice(1)
    : selector.startsWith('[data-') ? Object.hasOwn(e.dataset, datasetKey(selector.slice(1, -1))) : e.tagName === selector.toUpperCase();
  const root = new Element('document'), stack = [root];
  const withoutScript = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '');
  for (const token of withoutScript.matchAll(/<\/?[a-zA-Z][^>]*>|[^<]+/g)) {
    const text = token[0];
    if (!text.startsWith('<')) { stack.at(-1)._text += text.replace(/&amp;/g, '&'); continue; }
    if (text.startsWith('</')) { const tag = text.match(/^<\/([^\s>]+)/)[1].toUpperCase(); while (stack.length > 1) if (stack.pop().tagName === tag) break; continue; }
    const tag = text.match(/^<([^\s>]+)/)[1], element = new Element(tag);
    for (const attribute of text.slice(tag.length + 1, -1).matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) {
      const [, name, value = ''] = attribute;
      if (['hidden', 'checked', 'disabled', 'open'].includes(name)) element[name] = true;
      else if (name === 'class') element.className = value;
      else if (name.startsWith('data-')) element.dataset[datasetKey(name)] = value;
      else element[name] = value;
    }
    stack.at(-1).appendChild(element);
    if (!['INPUT', 'META', 'LINK', 'BR', 'HR', 'IMG'].includes(element.tagName)) stack.push(element);
  }
  for (const select of root.querySelectorAll('select')) select.value = select.options[0]?.value || '';
  const document = {
    getElementById: id => root.querySelector('#' + id), createElement: tag => new Element(tag),
    querySelectorAll: selector => root.querySelectorAll(selector), querySelector: selector => root.querySelector(selector),
    addEventListener: (name, fn) => { documentListeners[name] = fn; }
  };
  const context = { document, window: { addEventListener: (name, fn) => { windowListeners[name] = fn; }, setTimeout: schedule, clearTimeout: cancel }, Date: FixtureDate,
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message), getState: () => viewState, setState: state => { viewState = state; } }), console };
  const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1];
  vm.runInNewContext(script, context);
  const elements = new Map(descend(root).filter(e => e.id).map(e => [e.id, e]));
  const fire = message => windowListeners.message({ data: message });
  return { elements, messages, document, fire, context,
    advance(ms) { const end = now + ms; for (;;) { const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].fn(); } now = end; },
    toggle(details, open) { details.open = open; documentListeners.toggle({ target: details }); },
    get viewState() { return viewState; }, get scrollCalls() { return scrollCalls; } };
}
module.exports = { sidebarFixture };

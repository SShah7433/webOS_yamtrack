const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function script(name) {
  return readFileSync(join(__dirname, '..', 'helper', 'static', name), 'utf8');
}

test('legacy Alpine gets flatMap and starts popovers closed', () => {
  let init;
  let intercept;
  const context = vm.createContext({
    window: { Alpine: { interceptInit(callback) { intercept = callback; } } },
    document: { addEventListener(name, callback) { if (name === 'alpine:init') init = callback; } }
  });
  vm.runInContext('delete Array.prototype.flatMap; delete Array.prototype.flat; delete Object.fromEntries', context);
  vm.runInContext(script('compat.js'), context);
  assert.equal(vm.runInContext(
    'JSON.stringify([{open: false}, , {rating: 3}].flatMap(Object.keys))', context
  ), '["open","rating"]');
  assert.equal(vm.runInContext('JSON.stringify([[", [hx-post]"], [", [hx-get]"]].flat())', context),
    '[", [hx-post]",", [hx-get]"]');
  assert.equal(vm.runInContext(`JSON.stringify(Object.fromEntries(
    new Map([['operation', 'increase'], ['home_status', 'in_progress']]).entries()
  ))`, context), '{"operation":"increase","home_status":"in_progress"}');

  init();
  for (const [selector, attribute] of [
    ['.absolute[x-show]', 'data-ytv-popover'],
    ['.fixed.inset-0[x-show]', 'data-ytv-dialog']
  ]) {
    const element = {
      style: {},
      matches(candidate) { return candidate === selector; },
      setAttribute(name) { this.marker = name; }
    };
    intercept(element);
    assert.equal(element.style.display, 'none');
    assert.equal(element.marker, attribute);
  }
});

test('Down and the wheel scroll panels and the document', () => {
  const listeners = {};
  const body = { insertBefore() {}, addEventListener() {}, querySelectorAll() { return []; }, matches() { return false; } };
  const page = { scrollTop: 0 };
  const panel = {
    parentElement: body,
    clientHeight: 100,
    scrollHeight: 200,
    scrollTop: 0
  };
  const button = {
    tagName: 'BUTTON', parentElement: panel,
    classList: { add() {}, remove() {} },
    closest() { return null; },
    hasAttribute() { return false; },
    getAttribute() { return null; },
    getBoundingClientRect() { return { top: 110, bottom: 150, left: 32, right: 100, width: 68, height: 40 }; },
    focus() {}
  };
  const document = {
    body, activeElement: body, scrollingElement: page, onwheel: null,
    documentElement: { classList: { toggle() {} }, contains() { return true; } },
    contains() { return true; },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector.startsWith('[role=') ? [] : [button]; },
    createElement() { return { contains() { return false; }, setAttribute() {}, appendChild() {} }; },
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const window = {
    location: { pathname: '/' }, innerHeight: 600, innerWidth: 1024,
    getComputedStyle(element) { return { opacity: '1', overflowY: element === panel ? 'auto' : 'visible' }; }
  };
  vm.runInNewContext(script('client.js'), {
    document, window, CSS: { supports() { return true; } },
    MutationObserver: class { observe() {} }
  });
  function down() {
    listeners.keydown({ keyCode: 40, preventDefault() {}, stopImmediatePropagation() {} });
  }
  down();
  assert.equal(panel.scrollTop, 60);
  assert.equal(page.scrollTop, 0);
  panel.scrollHeight = 100;
  down();
  assert.equal(page.scrollTop, 360);
  let prevented = false;
  listeners.wheel({ target: body, deltaY: 80, preventDefault() { prevented = true; } });
  assert.equal(page.scrollTop, 440);
  assert(prevented);
});

test('a TV picker closes on toggle, outside click, selection, and Back', () => {
  const listeners = {};
  const attributes = new Map();
  const outside = { closest() { return null; } };
  const trigger = {
    tagName: 'BUTTON',
    getAttribute(name) { return name === '@click' ? 'open = !open' : attributes.get(name); },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    closest(selector) { return selector === '[data-ytv-picker-trigger]' ? this : null; }
  };
  const option = { closest(selector) { return selector.startsWith('a[href]') ? this : null; } };
  const picker = {
    previousElementSibling: trigger,
    contains(element) { return element === option; },
    getAttribute() { return 'open'; },
    getAttributeNames() { return ['x-show', 'x-transition:enter']; },
    removeAttribute(name) { this.removed.push(name); },
    setAttribute() {},
    removed: [],
    style: { removeProperty() {} }
  };
  const body = {
    insertBefore() {}, addEventListener() {},
    querySelectorAll(selector) { return selector === '[title]' ? [] : [picker]; }, matches() { return false; }
  };
  const document = {
    body, activeElement: body,
    documentElement: { classList: { toggle() {} } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { contains() { return false; }, setAttribute() {}, appendChild() {} }; },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
  };
  const window = { location: { pathname: '/' } };
  vm.runInNewContext(script('client.js'), {
    document, window, CSS: { supports() { return true; } },
    MutationObserver: class { observe() {} }
  });
  function click(target) { listeners.click.forEach(callback => callback({ target })); }
  assert(picker.hidden);
  assert.deepEqual(picker.removed, ['x-cloak', 'x-show', 'x-transition:enter']);
  click(trigger);
  assert(!picker.hidden);
  assert.equal(attributes.get('aria-expanded'), 'true');
  click(trigger);
  assert(picker.hidden);
  click(trigger);
  click(outside);
  assert(picker.hidden);
  click(trigger);
  // Pointer selection should leave the option's original click handlers intact.
  listeners.mousemove[0]({ isTrusted: true });
  click(option);
  assert(picker.hidden);
  click(trigger);
  // Back should consume the open picker rather than leaving the page.
  trigger.classList = { add() {}, remove() {} };
  trigger.hasAttribute = () => false;
  trigger.focus = () => {};
  trigger.getBoundingClientRect = () => ({ top:110, bottom:150, left:30, right:80 });
  window.innerHeight = 600;
  window.innerWidth = 1024;
  listeners.keydown[0]({ keyCode: 461, preventDefault() {}, stopImmediatePropagation() {} });
  assert(picker.hidden);
  assert.equal(attributes.get('aria-expanded'), 'false');
});

test('TV search hides the upstream type dropdown and keeps a valid default type', () => {
  const trigger = { tagName: 'BUTTON' };
  const menu = { previousElementSibling: trigger };
  const type = { value: '' };
  const input = {
    form: {
      querySelector(selector) { return selector.startsWith('input') ? type : menu; },
      getAttribute() {
        return `{ isOpen: false, selectedType: { display: 'Movies', value: 'movie' },
          mediaTypes: [{'display':'TV Shows','value':'tv'},{'display':'Movies','value':'movie'}],
          getPlaceholder() {} }`;
      }
    }
  };
  const body = {
    insertBefore() {}, appendChild() {}, addEventListener() {},
    querySelectorAll() { return []; }, matches() { return false; }
  };
  const created = [];
  const document = {
    body, activeElement: body,
    documentElement: { classList: { toggle() {} } },
    querySelector(selector) { return selector === '#global-search' ? input : null; },
    querySelectorAll() { return []; },
    createElement() {
      const node = {
        setAttribute() {}, appendChild() {}
      };
      created.push(node);
      return node;
    },
    addEventListener() {}
  };
  vm.runInNewContext(script('client.js'), {
    document, window: { location: { pathname: '/' } }, CSS: { supports() { return true; } },
    MutationObserver: class { observe() {} }
  });
  assert(trigger.hidden);
  assert(menu.hidden);
  assert.equal(type.value, 'movie');
  assert.equal(input.placeholder, 'Search Yamtrack');
  created.find(node => node.textContent === 'Search').onclick();
  assert(created.some(node => node.textContent === 'TV Shows'));
  assert(created.some(node => node.textContent === 'Movies'));
});

test('a movie tracker opens after HTMX populates its dialog and Back closes it', () => {
  const listeners = {};
  const attributes = new Map([['hx-get','/track_modal/tmdb/movie/42'], ['hx-target','#track-42']]);
  const dialog = {
    classList:{ add() {} },
    style:{ removeProperty() {} },
    removeAttribute() {},
    setAttribute() {}
  };
  const target = { closest() { return dialog; } };
  const trigger = {
    textContent:'In Progress',
    parentElement:{ contains(node) { return node === dialog; } },
    getAttribute(name) { return attributes.get(name); },
    setAttribute(name, value) { attributes.set(name,value); },
    removeAttribute(name) { attributes.delete(name); }
  };
  const body = { insertBefore() {}, addEventListener() {}, querySelectorAll() { return []; }, matches() { return false; } };
  const document = {
    body, activeElement:body,
    documentElement:{ classList:{ toggle() {} } },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector.includes('button[hx-get]') ? [trigger] : []; },
    getElementById(id) { return id === 'track-42' ? target : null; },
    createElement() { return { setAttribute() {}, appendChild() {} }; },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
  };
  const processed = [];
  const window = { location:{ pathname:'/details/tmdb/movie/42/movie' }, htmx:{ process(node) { processed.push(node); } } };
  vm.runInNewContext(script('client.js'), {
    document, window, CSS:{ supports() { return true; } }, MutationObserver:class { observe() {} }
  });
  assert(dialog.hidden);
  assert.equal(attributes.get('hx-trigger'),'click');
  assert.deepEqual(processed,[trigger]);
  listeners.mousemove[0]({ isTrusted:true });
  listeners['htmx:afterSwap'][0]({ detail:{ target } });
  assert(!dialog.hidden);
  listeners.keydown[0]({ keyCode:461, preventDefault() {}, stopImmediatePropagation() {} });
  assert(dialog.hidden);
});

test('library filter choices update HTMX form values and layout URLs', () => {
  const fields = Object.fromEntries(['sort', 'status', 'layout', 'search'].map(name => [name, {
    value:'', removeAttribute() {}
  }]));
  const label = { removeAttribute() {} };
  const button = {
    textContent: 'In Progress',
    getAttribute() { return "status = 'In progress'; open = false"; },
    removeAttribute() {},
    setAttribute(name, value) { this[name] = value; },
    closest() { return { querySelector() { return null; }, previousElementSibling:{ querySelector() { return label; } } }; },
    addEventListener(name, callback, capture) { assert(capture); this.click = callback; }
  };
  const grid = { getAttribute() { return "layout = 'grid'"; }, removeAttribute() {} };
  const search = { value:'',
    getAttribute() { return '/user/season'; },
    removeAttribute() {},
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { this.input = callback; }
  };
  const form = {
    elements:{ namedItem(name) { return fields[name]; } },
    parentElement:{ getAttribute() { return "{ status: 'In progress', sort: 'title', layout: 'table' }"; } },
    nextElementSibling:{
      querySelector() { return search; },
      querySelectorAll(selector) { return selector.startsWith('button') ? [button] : [grid]; }
    }
  };
  const body = {
    insertBefore() {}, addEventListener() {}, querySelectorAll() { return []; }, matches() { return false; }
  };
  const document = {
    body, activeElement:body,
    documentElement:{ classList:{ toggle() {} } },
    querySelector(selector) { return selector === 'main #filter-form' ? form : null; },
    querySelectorAll() { return []; },
    createElement() { return { setAttribute() {}, appendChild() {} }; },
    addEventListener() {}
  };
  const window = { location:new URL('http://tv.test/user/season?search=blue') };
  vm.runInNewContext(script('client.js'), {
    document, window, URL, CSS:{ supports() { return true; } },
    MutationObserver:class { observe() {} }
  });
  assert.equal(fields.layout.value, 'table');
  assert.equal(fields.sort.value, 'title');
  assert.equal(search.value, 'blue');
  assert.equal(label.textContent, 'In Progress');
  assert.equal(button['hx-sync'], '#filter-form:queue last');
  assert.equal(search['hx-sync'], button['hx-sync']);
  fields.status.value = 'All';
  button.click();
  assert.equal(fields.status.value, 'In progress');
  search.value = 'rock & roll';
  search.input();
  const url = new URL(grid.href);
  assert.equal(url.searchParams.get('search'), 'rock & roll');
  assert.equal(url.searchParams.get('status'), 'In progress');
  assert.equal(url.searchParams.get('sort'), 'title');
  assert.equal(url.searchParams.get('layout'), 'grid');
});

test('media detail tabs switch panels and stay in sync across both tab rows', () => {
  function element(attributes = {}) {
    return {
      attributes,
      getAttribute(name) { return this.attributes[name] || null; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, handler) { this[name] = handler; },
      appendChild() {},
      style: { removeProperty() {} },
      getBoundingClientRect() { return { top:900 }; }
    };
  }
  const names = ['overview', 'related-1', 'related-2', 'streaming', 'episodes', 'cast'];
  const rows = [element(), element()].map(nav => names.map(name => {
    const button = element({ '@click': `tab = '${name}'`, ':class': 'alpineClass' });
    button.parentElement = nav;
    return button;
  }));
  const panels = names.slice(1).map(name => element({ 'x-show': `tab === 'overview' || tab === '${name}'` }));
  const [cast] = panels.slice(-1);
  const links = ['https://www.themoviedb.org/person/7', 'https://www.themoviedb.org/movie/42/cast'];
  cast.querySelector = selector => {
    assert.equal(selector, 'a[href^="https://www.themoviedb.org/"][href$="/cast"]');
    const index = links.findIndex(href => href.endsWith('/cast'));
    return index === -1 ? null : { remove() { links.splice(index, 1); } };
  };
  const unrelated = element({ 'x-show': 'trackOpen' });
  const detail = {
    querySelectorAll(selector) { return selector === 'nav > button' ? rows.flat() : panels.concat(unrelated); }
  };
  const body = {
    insertBefore() {}, addEventListener() {}, querySelectorAll() { return []; }, matches() { return false; }
  };
  const document = {
    body, activeElement: body,
    documentElement: { classList: { toggle() {} } },
    querySelector(selector) { return selector.startsWith('.ytv-media-details') ? detail : null; },
    querySelectorAll() { return []; },
    createElement() { return element(); },
    addEventListener() {}
  };
  const window = {
    location: { pathname: '/details/tmdb/tv/42/show' }, innerHeight:720,
    scrollBy(x, y) { this.scroll = y; }
  };
  vm.runInNewContext(script('client.js'), {
    document, window, CSS: { supports() { return true; } },
    MutationObserver: class { observe() {} }
  });
  assert.deepEqual(links, ['https://www.themoviedb.org/person/7']);
  assert.deepEqual(panels.map(panel => panel.hidden), [false, false, false, false, false]);
  rows[0][1].click();
  assert.deepEqual(panels.map(panel => panel.hidden), [false, true, true, true, true]);
  assert.equal(rows[1][1].getAttribute('aria-pressed'), 'true');
  assert.equal(window.scroll, 300);
  rows[1][3].click();
  assert.deepEqual(panels.map(panel => panel.hidden), [true, true, false, true, true]);
  rows[0][4].click();
  assert.deepEqual(panels.map(panel => panel.hidden), [true, true, true, false, true]);
  rows[1][5].click();
  assert.deepEqual(panels.map(panel => panel.hidden), [true, true, true, true, false]);
  rows[1][0].click();
  assert.deepEqual(panels.map(panel => panel.hidden), [false, false, false, false, false]);
  assert.equal(unrelated.getAttribute('x-show'), 'trackOpen');
});

test('the TV disables outbound web links on initial pages and after swaps', () => {
  const origin = 'http://tv.test:8765';
  const listeners = {};
  const bodyListeners = {};
  function anchor(href) {
    const url = new URL(href, origin);
    return {
      href, protocol: url.protocol, origin: url.origin, tabindex: '0',
      matches(selector) { return selector === 'a[href]' && Boolean(this.href); },
      removeAttribute(name) { delete this[name]; },
      querySelectorAll() { return []; }
    };
  }
  const portrait = anchor('https://www.themoviedb.org/person/7');
  const home = anchor(origin + '/');
  const details = anchor('/details/tmdb/tv/42/show');
  const section = anchor('#cast');
  let links = [portrait, home, details, section];
  const body = {
    insertBefore() {}, matches() { return false; },
    querySelectorAll(selector) { return links.filter(link => link.matches(selector)); },
    addEventListener(name, handler) { (bodyListeners[name] ||= []).push(handler); }
  };
  const document = {
    body, activeElement: body,
    documentElement: { classList: { toggle() {} } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { setAttribute() {}, appendChild() {} }; },
    addEventListener(name, handler, capture) { (listeners[name] ||= []).push({ handler, capture }); }
  };
  const window = { location: { origin, pathname: '/details/tmdb/tv/42/show' } };
  vm.runInNewContext(script('client.js'), {
    document, window, CSS: { supports() { return true; } },
    MutationObserver: class { observe() {} }
  });
  assert.equal(portrait.href, undefined);
  assert.equal(portrait.tabindex, undefined);
  assert.equal(home.href, origin + '/');
  assert.equal(details.href, '/details/tmdb/tv/42/show');
  assert.equal(section.href, '#cast');

  const fragmentLink = anchor('//www.themoviedb.org/person/8');
  bodyListeners['htmx:load'].forEach(handler => handler({ detail: { elt: fragmentLink } }));
  assert.equal(fragmentLink.href, undefined);

  const swappedLink = anchor('https://www.themoviedb.org/person/9');
  links = [swappedLink];
  listeners['ytv:page'][0].handler({});
  assert.equal(swappedLink.href, undefined);

  const boundLink = anchor('https://www.themoviedb.org/person/10');
  for (const type of ['click', 'auxclick']) {
    for (const [link, blocked] of [[boundLink, true], [details, false]]) {
      const event = {
        target: { closest(selector) { return link.matches(selector) ? link : null; } },
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; }
      };
      assert.equal(listeners[type][0].capture, true);
      listeners[type][0].handler(event);
      assert.equal(Boolean(event.defaultPrevented), blocked);
      assert.equal(Boolean(event.stopped), blocked);
    }
  }
});

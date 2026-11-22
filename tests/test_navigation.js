const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function browser(path = '/') {
  const origin = 'http://tv.test:8765';
  const target = origin + '/details/tmdb/tv/42/show';
  const listeners = {};
  const browserEvents = {};
  const status = {};
  const styles = [{ tagName: 'LINK', outerHTML: '<link rel="stylesheet" href="/style.css">', getAttribute() { return '/style.css'; } }];
  const listAssets = [
    { tagName: 'LINK', getAttribute(name) { return name === 'href' ? '/static/css/libraries/select2-4.1.0.min.css' : null; } },
    { tagName: 'SCRIPT', getAttribute(name) { return name === 'src' ? '/static/js/libraries/jquery-3.7.1.min.js' : null; } }
  ];
  const tree = { markup: 'Home', parentNode: { replaceChild(newTree) { current = newTree; } } };
  let current = tree;
  let finish;
  let lastFetch;
  let processed = 0;
  const dependencies = [];
  const document = {
    getElementById(id) {
      if (id === 'ytv-page-status') return status;
      if (id === 'ytv-toolbar') return { offsetHeight:64 };
      if (id === 'today') return { getBoundingClientRect() { return { top:400 }; } };
    },
    querySelector(selector) { return selector.startsWith('body >') ? current : null; },
    querySelectorAll() {
      return styles.concat({ tagName: 'STYLE', textContent: '.htmx-indicator{opacity:0}' });
    },
    addEventListener(name, handler, capture) { listeners[capture ? name + ':capture' : name] = handler; },
    importNode(node) { return Object.assign({ parentNode: tree.parentNode }, node); },
    createElement(name) { return { tagName:name.toUpperCase() }; },
    head: { appendChild(element) { dependencies.push(element); } },
    dispatchEvent(event) { browserEvents[event.type] = true; }
  };
  const location = { origin, href: origin + path };
  const history = {
    replaceState(state) { this.previous = state; },
    pushState(state, _, url) { this.state = state; location.href = url; }
  };
  const window = {
    location, history, pageYOffset: 240,
    htmx: { process() { processed++; } }, Alpine: {}, AbortController,
    fetch(url, options) {
      lastFetch = { url, options };
      return new Promise(resolve => { finish = resolve; });
    },
    addEventListener(name, handler) { listeners[name] = handler; },
    scrollTo(x, y) { this.scroll = y; }
  };
  class DOMParser {
    parseFromString(html) {
      return {
        title: html === 'home' ? 'Home' : 'Series',
        querySelector(selector) {
          return selector.startsWith('body >') ? {
            markup: { home:'Home', series:'Series' }[html] || html,
            querySelector(name) { return name === 'main' ? {} : null; }
          } : null;
        },
        querySelectorAll() {
          if (html === 'different assets') return [];
          return html === 'Lists' ? styles.concat(listAssets) : styles;
        }
      };
    }
  }
  vm.runInNewContext(readFileSync(join(__dirname, '../helper/static/navigation.js'), 'utf8'), {
    document, window, DOMParser, URL, URLSearchParams, AbortController, CustomEvent, setTimeout, clearTimeout,
    FormData: class { constructor(form) { return form.data; } }
  });
  function click(url = target, homeShortcut = false) {
    let intercepted = false;
    listeners.click({
      button: 0,
      target: { closest() { return {
        href: url, hasAttribute() { return false; }, closest() { return null; },
        matches(selector) { return homeShortcut && selector === '#ytv-toolbar .ytv-key-red'; }
      }; } },
      preventDefault() { intercepted = true; }
    });
    return intercepted;
  }
  function resolve(html = 'series', redirect) {
    finish({ ok:true, redirected:!!redirect, url:redirect, headers:{ get() { return 'text/html; charset=utf-8'; } }, text:async () => html });
    return new Promise(resolve => setImmediate(resolve));
  }
  function back() {
    location.href = origin + '/';
    history.state = history.previous;
    listeners.popstate({ state: history.state });
  }
  return { target, status, window, browserEvents, click, resolve, back, listeners, dependencies,
    lastFetch: () => lastFetch, current: () => current, processed: () => processed };
}

test('the current page remains visible until a compatible page is ready', async () => {
  const app = browser();
  assert(app.click());
  assert.equal(app.current().markup, 'Home');
  assert.equal(app.status.textContent, 'Loading…');
  await app.resolve();
  assert.equal(app.current().markup, 'Series');
  assert.equal(app.window.location.href, app.target);
  assert.equal(app.window.history.previous.ytvScroll, 240);
  assert.equal(app.window.scroll, 0);
  assert.equal(app.processed(), 1);
  assert(app.browserEvents['ytv:page']);
  assert.equal(app.status.textContent, '');
  app.back();
  assert.equal(app.current().markup, 'Series');
  await app.resolve('home');
  assert.equal(app.current().markup, 'Home');
  assert.equal(app.window.scroll, 240);
});

test('only in-app pages use the page loader, with a full load for different assets', async () => {
  const app = browser();
  assert(!app.click('https://example.com/'));
  assert(app.click());
  await app.resolve('different assets');
  assert.equal(app.current().markup, 'Home');
  assert.equal(app.window.location.href, app.target);
  assert.equal(app.processed(), 0);
});

test('the TV Home shortcut goes home and refreshes the current page in place from Home', async () => {
  const app = browser('/calendar');
  const home = app.window.location.origin + '/';
  assert(app.click(home, true));
  await app.resolve('home');
  assert.equal(app.window.location.href, home);
  assert.equal(app.window.scroll, 0);

  const historyState = app.window.history.state;
  const previousFetch = app.lastFetch();
  assert(app.click(home));
  assert.equal(app.lastFetch(), previousFetch);

  assert(app.click(home, true));
  assert.notEqual(app.lastFetch(), previousFetch);
  assert.equal(app.lastFetch().url, home);
  assert.equal(app.lastFetch().options.method, 'GET');
  await app.resolve('Updated Home');
  assert.equal(app.current().markup, 'Updated Home');
  assert.equal(app.window.history.state, historyState);
  assert.equal(app.window.scroll, 240);
});

test('metadata sync refreshes the current detail page in place without another history entry', async () => {
  const app = browser();
  app.click();
  await app.resolve();
  const historyState = app.window.history.state;
  app.window.pageYOffset = 440;
  let prevented = false;
  app.listeners['htmx:beforeOnLoad']({
    detail: {
      requestConfig: { verb:'post', path:'/details/sync/tmdb/tv/42/0' },
      xhr: { getResponseHeader() { return '/details/tmdb/tv/42/show'; } }
    },
    preventDefault() { prevented = true; }
  });
  assert(prevented);
  await app.resolve();
  assert.equal(app.window.history.state, historyState);
  assert.equal(app.window.scroll, 440);
  assert.equal(app.processed(), 2);
});

test('saving a movie status handles Yamtrack’s HX-Location body swap as a page refresh', async () => {
  const app = browser();
  const path = '/details/tmdb/movie/42/movie';
  assert(app.click(app.window.location.origin + path));
  await app.resolve();
  const historyState = app.window.history.state;
  let prevented = false;
  app.listeners['htmx:beforeOnLoad']({
    detail: {
      requestConfig: { verb:'post', path:'/media_save?next=' + encodeURIComponent(path) },
      xhr: { getResponseHeader(name) {
        return name === 'HX-Location' ? JSON.stringify({ path, target:'body' }) : null;
      } }
    },
    preventDefault() { prevented = true; }
  });
  assert(prevented);
  await app.resolve();
  assert.equal(app.window.history.state, historyState);
  assert.equal(app.processed(), 2);
});

test('library, calendar, and date query changes keep the old page while loading', async () => {
  const app = browser('/viewer/season?layout=grid');
  const origin = app.window.location.origin;
  for (const [path, markup] of [
    ['/viewer/season?layout=table&status=In+progress', 'Seasons'],
    ['/calendar?month=4&year=2026&view=grid', 'April'],
    ['/calendar?month=5&year=2026&view=list#today', 'May']
  ]) {
    const previous = app.current();
    assert(app.click(origin + path));
    assert.equal(app.current(), previous);
    assert.equal(app.status.textContent, 'Loading…');
    await app.resolve(markup);
    assert.equal(app.current().markup, markup);
    assert.equal(app.window.location.href, origin + path);
  }
  assert.equal(app.window.scroll, 564);
  assert(!app.click(origin + '/calendar/download/token'));
  const journal = origin + '/journal?start-date=2026-05-01&end-date=2026-05-03';
  let prevented = false;
  app.listeners['ytv:navigate']({ detail:journal, preventDefault() { prevented = true; } });
  assert(prevented);
  await app.resolve('Journal');
  assert.equal(app.window.location.href, journal);
});

test('list dependencies load before swapping and are reused on later visits', async () => {
  const app = browser();
  const origin = app.window.location.origin;
  assert(app.click(origin + '/lists'));
  await app.resolve('Lists');
  assert.equal(app.current().markup, 'Home');
  assert.equal(app.status.textContent, 'Loading…');
  assert.deepEqual(app.dependencies.map(element => element.tagName), ['LINK']);
  app.dependencies[0].onload();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.dependencies.map(element => element.tagName), ['LINK', 'SCRIPT']);
  app.dependencies[1].onload();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.current().markup, 'Lists');
  assert(app.click(origin + '/list/42?sort=title'));
  await app.resolve('Lists');
  assert.equal(app.dependencies.length, 2);
  assert.equal(app.window.location.href, origin + '/list/42?sort=title');
});

test('Calendar release refresh posts once and stays in the app through its redirect', async () => {
  const app = browser('/calendar?view=list');
  const origin = app.window.location.origin;
  let prevented = false;
  app.listeners.submit({
    target: { action:origin + '/reload_calendar', method:'post', data:[['csrfmiddlewaretoken','token']],
      closest() { return null; }, matches() { return false; } },
    preventDefault() { prevented = true; }
  });
  assert(prevented);
  assert.equal(app.lastFetch().options.method, 'POST');
  assert.equal(app.lastFetch().options.body.toString(), 'csrfmiddlewaretoken=token');
  await app.resolve('Calendar', origin + '/calendar');
  assert.equal(app.current().markup, 'Calendar');
  assert.equal(app.window.location.href, origin + '/calendar');
});

test('a remote click preserves a list button’s formaction on Chromium 68', async () => {
  const app = browser('/lists');
  const origin = app.window.location.origin;
  const form = { action:origin + '/lists', method:'post', data:[['name','Favorites']],
    closest() { return null; }, matches() { return false; } };
  const button = { type:'submit', form, formAction:origin + '/list/create?next=%2Flists',
    hasAttribute(name) { return name === 'formaction'; } };
  let prevented = false;
  app.listeners['click:capture']({ target:{ closest() { return button; } } });
  app.listeners.submit({ target:form, preventDefault() { prevented = true; } });
  assert(prevented);
  assert.equal(app.lastFetch().url, button.formAction);
  assert.equal(app.lastFetch().options.body.toString(), 'name=Favorites');
  await app.resolve('New list saved', origin + '/lists');
  assert.equal(app.current().markup, 'New list saved');
});

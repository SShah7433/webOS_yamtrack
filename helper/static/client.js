(function () {
  'use strict';
  if (window.__yamtrackTV) return;
  window.__yamtrackTV = true;
  function setPageClasses() {
    var path = window.location.pathname;
    document.documentElement.classList.toggle('ytv-home', path === '/');
    document.documentElement.classList.toggle('ytv-calendar', path === '/calendar');
    document.documentElement.classList.toggle('ytv-search-results', path === '/search');
    document.documentElement.classList.toggle('ytv-media-details', /^\/details\/[^/]+\/(movie|tv|season)\//.test(path));
  }
  setPageClasses();
  var selector = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[tabindex],li.cursor-pointer,[hx-post],[data-hx-post]';
  var current = null;
  var previousRect = null;
  var overlay = null;
  var restoreTarget = null;
  var pointerMode = false;
  var toolbar;
  var pickerTriggers = new WeakMap();
  var openPicker = null;
  var searchSettings = null;
  var librarySearch = null;
  var activeSection = 'overview';
  var detailTargets = new WeakMap();
  var activeDetailDialog = null;

  function visible(element) {
    if (!element || !document.documentElement.contains(element) || element.disabled || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    var style = window.getComputedStyle(element);
    var rect = element.getBoundingClientRect();
    if (style.visibility === 'hidden' || style.display === 'none' || rect.width < 2 || rect.height < 2) return false;
    // Opacity on an ancestor hides Alpine transitions and invisible dialogs.
    for (var node = element; node && node !== document.body; node = node.parentElement) {
      if (window.getComputedStyle(node).opacity === '0') return false;
    }
    return true;
  }
  function textInput(element) {
    return element && (element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' &&
      !/^(checkbox|radio|button|submit|reset|range|file|color|hidden)$/i.test(element.type)));
  }
  function scope() {
    if (overlay) return overlay;
    if (activeDetailDialog) return activeDetailDialog.dialog;
    var dialogs = document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],[data-ytv-dialog]');
    for (var i = dialogs.length - 1; i >= 0; i--) {
      if (visible(dialogs[i]) && dialogs[i].querySelector(selector)) return dialogs[i];
    }
    return document;
  }
  function items() {
    var container = scope();
    var choices = container === document && openPicker ?
      [openPicker.trigger].concat(Array.prototype.slice.call(openPicker.panel.querySelectorAll(selector))) :
      container.querySelectorAll(selector);
    return Array.prototype.filter.call(choices, function (element) {
      return visible(element) && element.getAttribute('tabindex') !== '-1';
    });
  }
  function mark(element) {
    if (!element) return;
    if (current) current.classList.remove('ytv-focus');
    current = element;
    current.classList.add('ytv-focus');
    // Text fields use a visual cursor so merely moving onto search doesn't open
    // the TV's native keyboard. Pointer clicks retain the normal site behavior.
    if (!textInput(element) && element.tagName !== 'SELECT') {
      if (!element.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT)$/.test(element.tagName)) element.tabIndex = 0;
      element.focus({ preventScroll:true });
    } else if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    var rect = element.getBoundingClientRect();
    if (!toolbar.contains(element) &&
        (rect.top < 90 || rect.bottom > window.innerHeight - 28 || rect.left < 16 || rect.right > window.innerWidth - 16)) {
      element.scrollIntoView({ block:'center', inline:'nearest' });
    }
    previousRect = element.getBoundingClientRect();
  }
  function setPointerMode(enabled) {
    if (pointerMode === enabled) return;
    pointerMode = enabled;
    document.documentElement.classList.toggle('ytv-pointer', enabled);
  }
  function center(rect) { return { x:(rect.left + rect.right)/2, y:(rect.top + rect.bottom)/2 }; }
  function scrollFrom(start, delta, container, pageStep) {
    for (var node = start; node && node !== document.body && node !== document; node = node.parentElement) {
      var height = node.clientHeight;
      if (height && node.scrollHeight > height && /^(auto|scroll)$/.test(window.getComputedStyle(node).overflowY)) {
        var position = node.scrollTop;
        node.scrollTop += pageStep ? (delta < 0 ? -1 : 1) * Math.max(48, height * 0.6) : delta;
        if (node.scrollTop !== position) return true;
      }
      if (node === container) break;
    }
    if (container !== document) return false;
    var page = document.scrollingElement;
    if (!page) {
      window.scrollBy(0, delta);
      return true;
    }
    var pagePosition = page.scrollTop;
    page.scrollTop += delta;
    return page.scrollTop !== pagePosition;
  }
  function scrollPage(direction) {
    var container = scope();
    var start = container.contains(current) ? current : container;
    if (container === document && openPicker) {
      container = openPicker.panel;
      start = container.contains(current) ? current : container;
    }
    scrollFrom(start, direction * window.innerHeight * 0.6, container, true);
  }
  function move(key) {
    var choices = items();
    if (!choices.length) {
      if (key === 38 || key === 40) scrollPage(key === 38 ? -1 : 1);
      return;
    }
    if (!visible(current) || choices.indexOf(current) === -1) { mark(choices[0]); return; }
    var from = center(current.getBoundingClientRect());
    var horizontal = key === 37 || key === 39;
    var sign = key === 37 || key === 38 ? -1 : 1;
    var best = null;
    var score = Infinity;
    choices.forEach(function (element) {
      if (element === current) return;
      var to = center(element.getBoundingClientRect());
      var main = (horizontal ? to.x - from.x : to.y - from.y) * sign;
      var cross = Math.abs(horizontal ? to.y - from.y : to.x - from.x);
      if (main < 2) return;
      var candidate = main + cross * 3 + cross * cross / Math.max(main, 1);
      if (candidate < score) { best = element; score = candidate; }
    });
    if (best) mark(best);
    else if (key === 38 || key === 40) scrollPage(sign);
  }
  function closeOverlay() {
    if (!overlay) return;
    overlay.parentNode.removeChild(overlay);
    overlay = null;
    if (visible(restoreTarget)) mark(restoreTarget);
  }
  function panel(title) {
    restoreTarget = current;
    overlay = document.createElement('div');
    overlay.className = 'ytv-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var content = document.createElement('div');
    content.className = 'ytv-panel';
    var heading = document.createElement('h2');
    heading.textContent = title;
    content.appendChild(heading);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
    return content;
  }
  function button(parent, title, action) {
    var element = document.createElement('button');
    element.type = 'button';
    element.textContent = title;
    element.onclick = action;
    parent.appendChild(element);
    return element;
  }
  function submit(form) {
    if (!form || !form.reportValidity()) return;
    var submitter = form.querySelector('button[type="submit"],input[type="submit"],button:not([type])');
    if (submitter) submitter.click();
    else if (form.dispatchEvent(new Event('submit', { bubbles:true, cancelable:true }))) HTMLFormElement.prototype.submit.call(form);
  }
  function configureSearch() {
    var input = document.querySelector('#global-search');
    if (!input || !input.form) return;
    var form = input.form;
    var type = form.querySelector('input[name="media_type"]');
    if (!type) return;
    var expression = form.getAttribute('x-data') || '';
    var list = expression.match(/\bmediaTypes:\s*(\[[\s\S]*?\])\s*,\s*getPlaceholder\b/);
    var data = window.Alpine && window.Alpine.$data && window.Alpine.$data(form);
    var types = data && Array.isArray(data.mediaTypes) ? data.mediaTypes : [];
    if (!types.length && list) {
      // Django can render the list with single-quoted keys and values.
      var labels = { tv:'TV Shows', movie:'Movies', anime:'Anime', manga:'Manga', game:'Games',
        book:'Books', comic:'Comics', boardgame:'Board Games' };
      var values = /['"]value['"]\s*:\s*['"]([a-z_]+)['"]/g;
      for (var match; (match = values.exec(list[1]));) {
        if (labels[match[1]]) types.push({ value:match[1], display:labels[match[1]] });
      }
    }
    if (!types.length) types = [{ value:'tv', display:'TV Shows' }, { value:'movie', display:'Movies' }];
    var initial = expression.match(/\bselectedType:\s*\{[^}]*\bvalue:\s*(['"])([a-z_]+)\1/);
    type.value = type.value || (initial && initial[2]) || (types[0] && types[0].value) || 'tv';
    var menu = form.querySelector('ul.absolute[x-show="isOpen"]');
    if (menu && menu.previousElementSibling && menu.previousElementSibling.tagName === 'BUTTON') {
      menu.hidden = true;
      menu.previousElementSibling.hidden = true;
    }
    if (!input.placeholder) input.placeholder = 'Search Yamtrack';
    searchSettings = { input:input, field:type, types:types };
  }
  function keyboard(input) {
    var value = input.value;
    var caps = false;
    var symbols = false;
    var settings = searchSettings && searchSettings.input === input ? searchSettings : null;
    var content = panel(settings ? 'Search Yamtrack' : (input.getAttribute('aria-label') || input.placeholder || 'Enter text'));
    var mediaType = settings && settings.field.value;
    if (settings && settings.types.length > 1) {
      var types = document.createElement('div');
      types.className = 'ytv-search-types';
      types.setAttribute('role', 'group');
      types.setAttribute('aria-label', 'Media type');
      content.appendChild(types);
      settings.types.forEach(function (type) {
        var option = button(types, type.display, function () {
          mediaType = type.value;
          var previous = types.querySelector('[aria-pressed="true"]');
          if (previous) previous.setAttribute('aria-pressed', 'false');
          option.setAttribute('aria-pressed', 'true');
        });
        option.setAttribute('aria-pressed', String(type.value === mediaType));
      });
    }
    var preview = document.createElement('div');
    preview.className = 'ytv-value';
    content.appendChild(preview);
    var grid = document.createElement('div');
    grid.className = 'ytv-kbd-grid';
    content.appendChild(grid);
    var actions = document.createElement('div');
    actions.className = 'ytv-kbd-actions';
    content.appendChild(actions);
    function update() {
      preview.textContent = input.type === 'password' ? new Array(value.length + 1).join('•') : value || ' ';
    }
    function draw() {
      grid.textContent = '';
      var alphabet = symbols ? '!@#$%^&*()_+-=[]{};:\'",.<>/?\\|`~0123456789' : 'abcdefghijklmnopqrstuvwxyz0123456789';
      if (caps) alphabet = alphabet.toUpperCase();
      alphabet.split('').forEach(function (character) {
        button(grid, character, function () { value += character; update(); });
      });
      mark(grid.firstChild);
    }
    function apply(send) {
      var setter = Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles:true }));
      input.dispatchEvent(new Event('change', { bubbles:true }));
      if (settings) settings.field.value = mediaType;
      closeOverlay();
      if (send && input === librarySearch) input.dispatchEvent(new Event('search', { bubbles:true }));
      else if (send) submit(input.form);
    }
    button(actions, 'Shift', function () { caps = !caps; draw(); });
    button(actions, '#+=', function () { symbols = !symbols; draw(); });
    button(actions, 'Space', function () { value += ' '; update(); });
    button(actions, 'Delete', function () { value = value.slice(0, -1); update(); });
    button(actions, 'Clear', function () { value = ''; update(); });
    button(actions, 'Cancel', closeOverlay);
    button(actions, 'Done', function () { apply(false); });
    if (input.form || input === librarySearch) {
      button(actions, input.type === 'search' || input === librarySearch ? 'Search' : 'Submit', function () { apply(true); });
    }
    update();
    draw();
  }
  function choose(select) {
    var content = panel('Choose an option');
    Array.prototype.forEach.call(select.options, function (option, index) {
      if (option.disabled || option.hidden) return;
      button(content, (option.selected ? '✓ ' : '') + option.text, function () {
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles:true }));
        select.dispatchEvent(new Event('change', { bubbles:true }));
        closeOverlay();
      });
    });
    mark(content.querySelector('button'));
  }
  function help() {
    if (overlay) closeOverlay();
    var content = panel('Using Yamtrack on your TV');
    var text = document.createElement('p');
    text.textContent = 'Arrows move the blue focus outline. OK opens a list or activates the selected episode control. Select a search field and press OK to type. Back closes this panel or goes to the previous page; Back on Home exits.';
    content.appendChild(text);
    var note = document.createElement('p');
    note.className = 'ytv-note';
    note.textContent = 'Move the Magic Remote to show the pointer, click with OK, and scroll with the wheel. Red: Home · Green: Lists · Yellow: Search · Blue: Help.';
    content.appendChild(note);
    mark(button(content, 'Close', closeOverlay));
  }
  function search() {
    if (searchSettings) { keyboard(searchSettings.input); return; }
    var input = document.querySelector('#global-search,input[type="search"],input[name="q"]');
    if (input && visible(input)) { mark(input); keyboard(input); }
    else toolbar.querySelector('a[href="/"]').click();
  }
  function activate() {
    var choices = items();
    if (!visible(current) || choices.indexOf(current) === -1) { mark(choices[0]); return; }
    if (textInput(current)) keyboard(current);
    else if (current.tagName === 'SELECT') choose(current);
    else current.click();
  }
  function closePicker(restoreFocus) {
    if (!openPicker) return;
    var picker = openPicker;
    openPicker = null;
    picker.panel.hidden = true;
    picker.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) mark(picker.trigger);
  }
  function registerPickers(root) {
    if (openPicker && !document.documentElement.contains(openPicker.panel)) closePicker(false);
    var matching = 'main .absolute[x-show="open"],main .absolute[x-show="showRatingPopup"],main .absolute[x-show="menuOpen"]';
    var panels = Array.prototype.slice.call(root.querySelectorAll(matching));
    if (root.matches(matching)) panels.unshift(root);
    panels.forEach(function (panel) {
      var trigger = panel.previousElementSibling;
      if (!trigger || pickerTriggers.has(trigger)) return;
      var state = panel.getAttribute('x-show');
      var expression = trigger.getAttribute('@click') || '';
      if (expression.replace(/\s/g, '') !== state + '=!' + state) return;
      panel.hidden = true;
      panel.removeAttribute('x-cloak');
      panel.removeAttribute('x-show');
      panel.getAttributeNames().forEach(function (attribute) {
        if (attribute.indexOf('x-transition') === 0) panel.removeAttribute(attribute);
      });
      panel.style.removeProperty('display');
      trigger.removeAttribute('@click');
      panel.setAttribute('data-ytv-picker', '');
      trigger.setAttribute('data-ytv-picker-trigger', '');
      trigger.setAttribute('aria-expanded', 'false');
      if (trigger.tagName !== 'BUTTON') {
        trigger.setAttribute('role', 'button');
        trigger.tabIndex = 0;
      }
      pickerTriggers.set(trigger, panel);
    });
  }
  function configureLibraryFilters() {
    var form = document.querySelector('main #filter-form');
    var controls = form && form.nextElementSibling;
    if (!controls) return;
    var input = controls.querySelector('input[hx-include="#filter-form"]');
    if (!input) return;
    var endpoint = new URL(input.getAttribute('hx-get'), window.location.href);
    if (endpoint.origin !== window.location.origin) return;
    var htmx = window.htmx;
    librarySearch = input;
    var searchField = form.elements.namedItem('search');
    if (!searchField || !form.elements.namedItem('layout')) return;
    var fields = {};
    var params = new URL(window.location.href).searchParams;
    var state = form.parentElement.getAttribute('x-data') || '';
    var defaults = { status:'All', sort:'score', layout:'grid' };
    Object.keys(defaults).forEach(function (name) {
      var field = form.elements.namedItem(name);
      var initial = state.match(new RegExp('\\b' + name + '\\s*:\\s*([\'"])(.*?)\\1'));
      field.removeAttribute('x-model');
      field.value = (initial && initial[2]) || field.value || params.get(name) || defaults[name];
      fields[name] = field;
    });
    searchField.removeAttribute('x-model');
    input.removeAttribute('x-model');
    searchField.value = params.get('search') || '';
    input.value = searchField.value;
    // Search and both dropdowns target the same results. Keep the latest
    // change queued while an earlier request is still running.
    input.setAttribute('hx-sync', '#filter-form:queue last');
    if (htmx) htmx.process(input);
    var layouts = [];

    function updateLinks() {
      layouts.forEach(function (item) {
        var url = new URL(endpoint.href);
        if (searchField.value) url.searchParams.set('search', searchField.value);
        url.searchParams.set('status', fields.status.value);
        url.searchParams.set('sort', fields.sort.value);
        url.searchParams.set('layout', item.layout);
        item.link.href = url.href;
      });
    }
    Array.prototype.forEach.call(controls.querySelectorAll('button[hx-include="#filter-form"]'), function (option) {
      var choice = (option.getAttribute('@click') || '').match(/^\s*(status|sort)\s*=\s*(['"])(.*?)\2/);
      if (!choice) return;
      var field = fields[choice[1]];
      var picker = option.closest('[data-ytv-picker]');
      var trigger = picker && picker.previousElementSibling;
      var label = trigger && trigger.querySelector('span');
      option.removeAttribute('@click');
      option.removeAttribute(':class');
      option.setAttribute('hx-sync', '#filter-form:queue last');
      if (htmx) htmx.process(option);
      if (label) label.removeAttribute('x-text');
      function selectOption() {
        var previous = picker && picker.querySelector('[aria-pressed="true"]');
        if (previous) previous.setAttribute('aria-pressed', 'false');
        option.setAttribute('aria-pressed', 'true');
        if (label) label.textContent = option.textContent.trim();
      }
      if (field.value === choice[3]) selectOption();
      else option.setAttribute('aria-pressed', 'false');
      option.addEventListener('click', function () {
        field.value = choice[3];
        selectOption();
        updateLinks();
      }, true);
    });
    Array.prototype.forEach.call(controls.querySelectorAll('a'), function (link) {
      var choice = (link.getAttribute('@click') || '').match(/^\s*layout\s*=\s*(['"])(grid|table)\1/);
      if (!choice) return;
      link.removeAttribute('@click');
      link.removeAttribute(':href');
      layouts.push({ link:link, layout:choice[2] });
    });
    input.addEventListener('input', function () {
      searchField.value = input.value;
      updateLinks();
    });
    updateLinks();
  }
  function configureSections(initialSection) {
    var detail = document.querySelector('.ytv-media-details main .container > [x-data]');
    if (!detail) return;
    var buttons = [];
    var panels = [];
    Array.prototype.forEach.call(detail.querySelectorAll('nav > button'), function (button) {
      var match = (button.getAttribute('@click') || '').match(/^\s*tab\s*=\s*(['"])([\w-]+)\1\s*$/);
      if (match) buttons.push({ element:button, name:match[2] });
    });
    Array.prototype.forEach.call(detail.querySelectorAll('[x-show]'), function (panel) {
      var match = panel.getAttribute('x-show').match(/^\s*tab\s*===\s*(['"])overview\1\s*\|\|\s*tab\s*===\s*(['"])([\w-]+)\2\s*$/);
      if (match) {
        panel.setAttribute('data-ytv-section', match[3]);
        panels.push({ element:panel, name:match[3] });
        if (match[3] === 'cast') {
          var viewAll = panel.querySelector('a[href^="https://www.themoviedb.org/"][href$="/cast"]');
          if (viewAll) viewAll.remove();
        }
      }
    });
    if (!buttons.length || !panels.length || buttons.some(function (button) {
      return button.name !== 'overview' && !panels.some(function (panel) { return panel.name === button.name; });
    })) return;

    function selectSection(name, reveal) {
      activeSection = name;
      var selected = null;
      buttons.forEach(function (item) {
        item.element.setAttribute('aria-pressed', String(item.name === name));
      });
      panels.forEach(function (item) {
        item.element.hidden = name !== 'overview' && item.name !== name;
        if (item.name === name) selected = item.element;
      });
      if (selected && reveal) {
        var top = selected.getBoundingClientRect().top;
        var visibleBottom = window.innerHeight - 120;
        if (top > visibleBottom) window.scrollBy(0, top - visibleBottom);
      }
    }
    panels.forEach(function (item) {
      item.element.removeAttribute('x-show');
      item.element.style.removeProperty('display');
    });
    buttons.forEach(function (item) {
      var button = item.element;
      button.type = 'button';
      button.removeAttribute('@click');
      button.removeAttribute(':class');
      button.parentElement.setAttribute('data-ytv-sections', '');
      button.parentElement.setAttribute('aria-label', 'Media sections');
      button.addEventListener('click', function () { selectSection(item.name, true); });
    });
    selectSection(buttons.some(function (item) { return item.name === initialSection; }) ? initialSection : 'overview', false);
  }
  function configureDetailActions() {
    var htmx = window.htmx;
    if (!htmx) return;
    Array.prototype.forEach.call(document.querySelectorAll('.ytv-media-details main button[hx-get]'), function (button) {
      if (!/^\/(track_modal|lists_modal|history_modal)\//.test(button.getAttribute('hx-get'))) return;
      var id = button.getAttribute('hx-target') || '';
      var target = id.charAt(0) === '#' && document.getElementById(id.slice(1));
      var dialog = target && target.closest('.fixed.inset-0[x-show]');
      if (!dialog || !button.parentElement.contains(dialog)) return;
      dialog.hidden = true;
      dialog.removeAttribute('x-show');
      dialog.style.removeProperty('display');
      dialog.classList.add('ytv-action-dialog');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', button.textContent.trim());
      detailTargets.set(target, { dialog:dialog, button:button });
      button.removeAttribute('@click');
      button.setAttribute('hx-trigger', 'click');
      button.setAttribute('hx-disabled-elt', 'this');
      htmx.process(button);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.ytv-media-details main button[hx-post^="/details/sync/"]'), function (button) {
      button.removeAttribute('@click');
      button.removeAttribute(':disabled');
      button.setAttribute('hx-disabled-elt', 'this');
      htmx.process(button);
    });
  }
  function closeDetailDialog() {
    if (!activeDetailDialog) return;
    var dialog = activeDetailDialog;
    activeDetailDialog = null;
    dialog.dialog.hidden = true;
    if (!pointerMode && visible(dialog.button)) mark(dialog.button);
  }
  document.addEventListener('htmx:afterSwap', function (event) {
    var dialog = detailTargets.get(event.detail.target);
    if (!dialog) return;
    closeDetailDialog();
    activeDetailDialog = dialog;
    dialog.dialog.hidden = false;
    if (!pointerMode) mark(items()[0]);
  });
  function detailRequestFailed(event) {
    if (!detailTargets.has(event.detail.target)) return;
    document.getElementById('ytv-page-status').textContent = 'Couldn’t open this action. Try again.';
  }
  document.addEventListener('htmx:responseError', detailRequestFailed);
  document.addEventListener('htmx:sendError', detailRequestFailed);
  document.addEventListener('htmx:beforeRequest', function (event) {
    if (detailTargets.has(event.detail.target)) document.getElementById('ytv-page-status').textContent = '';
  });
  document.addEventListener('click', blockExternalLink, true);
  document.addEventListener('auxclick', blockExternalLink, true);
  document.addEventListener('click', function (event) {
    if (!activeDetailDialog) return;
    var dialog = activeDetailDialog.dialog;
    var button = event.target.closest('button');
    if (event.target === dialog || (button && dialog.contains(button) &&
        /^(trackOpen|createOpen|listsOpen|historyOpen)\s*=\s*false/.test(button.getAttribute('@click') || ''))) closeDetailDialog();
  }, true);
  function back() {
    if (overlay) { closeOverlay(); return; }
    if (activeDetailDialog) { closeDetailDialog(); return; }
    if (openPicker) { closePicker(true); return; }
    // Alpine popovers already listen for Escape. Give them that event first.
    var dialogScope = scope();
    window.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', keyCode:27, bubbles:true }));
    if (dialogScope !== document) return;
    if (window.location.pathname === '/') { window.close(); return; }
    if (window.history.length > 1) window.history.back();
    else toolbar.querySelector('a[href="/"]').click();
  }
  document.addEventListener('keydown', function (event) {
    var code = event.keyCode;
    if (code === 27 && event.key === 'Escape' && !event.isTrusted) return;
    if (!overlay && textInput(document.activeElement)) {
      if (code === 461 || code === 27) {
        document.activeElement.blur();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (pointerMode && document.activeElement && document.activeElement.tagName === 'SELECT' &&
        [13,27,37,38,39,40].indexOf(code) !== -1) return;
    if ([13,33,34,37,38,39,40,461,27,403,404,405,406].indexOf(code) === -1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (code >= 37 && code <= 40) {
      setPointerMode(false);
      if (event.repeat && !overlay && (code === 38 || code === 40)) scrollPage(code === 38 ? -1 : 1);
      else move(code);
    }
    else if (code === 33 || code === 34) scrollPage(code === 33 ? -1 : 1);
    else if (code === 13) { if (!pointerMode && !event.repeat) activate(); }
    else if (code === 461 || code === 27) back();
    else if (!overlay) {
      if (code === 403) toolbar.querySelector('a[href="/"]').click();
      if (code === 404) toolbar.querySelector('a[href="/lists"]').click();
      if (code === 405) search();
      if (code === 406) help();
    }
  }, true);
  document.addEventListener('cursorStateChange', function (event) {
    if (event.detail) setPointerMode(event.detail.visibility === true);
  });
  document.addEventListener('mousemove', function (event) {
    if (event.isTrusted) setPointerMode(true);
  });
  document.addEventListener('click', function (event) {
    if (!event.isTrusted || !event.detail) return;
    setPointerMode(true);
    var target = event.target.closest(selector);
    if (target) {
      if (current) current.classList.remove('ytv-focus');
      current = target;
      current.classList.add('ytv-focus');
      previousRect = current.getBoundingClientRect();
    }
  }, true);
  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-ytv-picker-trigger]');
    if (openPicker && openPicker.trigger === trigger) { closePicker(false); return; }
    if (openPicker && (!openPicker.panel.contains(event.target) || event.target.closest('a[href],button,[role="button"]'))) {
      closePicker(!pointerMode && openPicker.panel.contains(event.target));
    }
    var panel = trigger && pickerTriggers.get(trigger);
    if (panel) {
      openPicker = { trigger:trigger, panel:panel };
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    }
  }, true);
  document.addEventListener('onwheel' in document ? 'wheel' : 'mousewheel', function (event) {
    if (event.ctrlKey || Math.abs(event.deltaX || 0) > Math.abs(event.deltaY || 0)) return;
    var delta = event.deltaY;
    if (delta === undefined) delta = -event.wheelDelta;
    if (!delta) return;
    if (event.deltaMode === 1) delta *= 20;
    if (event.deltaMode === 2) delta *= window.innerHeight;
    var container = scope();
    if (container.contains(event.target) && scrollFrom(event.target, delta, container)) event.preventDefault();
  }, { passive:false });

  function removeHoverTitles(root) {
    var titles = Array.prototype.slice.call(root.querySelectorAll('[title]'));
    if (root.matches('[title]')) titles.unshift(root);
    titles.forEach(function (element) {
      var title = element.getAttribute('title');
      if (title && element.matches('button,a[href],[role="button"]') && !element.textContent.trim() &&
          !element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')) {
        element.setAttribute('aria-label', title);
      }
      element.removeAttribute('title');
    });
  }

  function isExternalWebLink(link) {
    return (link.protocol === 'http:' || link.protocol === 'https:') && link.origin !== window.location.origin;
  }

  function disableExternalLinks(root) {
    var links = Array.prototype.slice.call(root.querySelectorAll('a[href]'));
    if (root.matches('a[href]')) links.unshift(root);
    links.forEach(function (link) {
      if (!isExternalWebLink(link)) return;
      link.removeAttribute('href');
      link.removeAttribute('tabindex');
    });
  }

  // Catch hrefs added by Alpine or other scripts after the page was prepared.
  function blockExternalLink(event) {
    var link = event.target.closest('a[href]');
    if (!link || !isExternalWebLink(link)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  // Chromium 68 needs a sized wrapper to reserve space before a poster loads.
  function sizePosters(root) {
    var poster = 'a > img[class~="aspect-2/3"]';
    if (root.matches(poster)) root.parentElement.classList.add('ytv-poster');
    Array.prototype.forEach.call(root.querySelectorAll(poster), function (image) {
      image.parentElement.classList.add('ytv-poster');
    });
  }
  var needsPosterSizing = !CSS.supports('aspect-ratio', '2 / 3');
  if (needsPosterSizing) {
    sizePosters(document.body);
    document.body.addEventListener('htmx:load', function (event) {
      sizePosters(event.detail.elt);
    });
  }

  toolbar = document.createElement('nav');
  toolbar.id = 'ytv-toolbar';
  toolbar.setAttribute('aria-label', 'TV shortcuts');
  toolbar.innerHTML = '<strong>Yamtrack</strong><span id="ytv-page-status" role="status"></span>' +
    '<a href="/">Home</a><a href="/lists">Lists</a>';
  button(toolbar, 'Search', search);
  button(toolbar, 'Help', help);
  var menuButton = button(toolbar, 'Menu', function () {
    var toggle = document.querySelector('body > div > div > .sticky button.lg\\:hidden');
    if (toggle) toggle.click();
  });
  menuButton.className = 'ytv-mobile-menu';
  document.body.insertBefore(toolbar, document.body.firstChild);
  configureSearch();
  registerPickers(document.body);
  configureLibraryFilters();
  configureSections();
  configureDetailActions();
  disableExternalLinks(document.body);
  removeHoverTitles(document.body);
  document.body.addEventListener('htmx:load', function (event) {
    registerPickers(event.detail.elt);
    disableExternalLinks(event.detail.elt);
    removeHoverTitles(event.detail.elt);
  });
  document.addEventListener('ytv:page', function (event) {
    closePicker(false);
    if (overlay) closeOverlay();
    if (current) current.classList.remove('ytv-focus');
    current = null;
    previousRect = null;
    searchSettings = null;
    librarySearch = null;
    activeDetailDialog = null;
    if (!(event.detail && event.detail.refresh)) activeSection = 'overview';
    setPageClasses();
    configureSearch();
    if (needsPosterSizing) sizePosters(document.body);
    registerPickers(document.body);
    configureLibraryFilters();
    configureSections(activeSection);
    configureDetailActions();
    disableExternalLinks(document.body);
    removeHoverTitles(document.body);
    if (!pointerMode) mark(items()[0]);
  });

  // HTMX swaps may replace a watched button. Restore nearby focus without ever
  // clicking a replacement or issuing another update request.
  var pending = false;
  var observer = new MutationObserver(function () {
    if (pointerMode || pending || visible(current)) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      if (pointerMode || visible(current)) return;
      var choices = items();
      if (previousRect) {
        var from = center(previousRect);
        choices.sort(function (a,b) {
          var ca = center(a.getBoundingClientRect());
          var cb = center(b.getBoundingClientRect());
          return Math.abs(ca.x-from.x)+Math.abs(ca.y-from.y)-Math.abs(cb.x-from.x)-Math.abs(cb.y-from.y);
        });
      }
      mark(choices[0]);
    }, 100);
  });
  observer.observe(document.body, { childList:true, subtree:true });
  mark(items()[0]);
}());

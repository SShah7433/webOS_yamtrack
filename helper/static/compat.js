(function () {
  'use strict';

  // Alpine 3.14 uses queueMicrotask to start up and schedule reactive updates.
  if (typeof window.queueMicrotask !== 'function') {
    window.queueMicrotask = function (callback) {
      if (typeof callback !== 'function') throw new TypeError('Expected a callback');
      Promise.resolve().then(function () { callback(); }).catch(function (error) {
        setTimeout(function () { throw error; }, 0);
      });
    };
  }

  // Alpine combines the keys of nested component scopes with flatMap.
  if (typeof Array.prototype.flatMap !== 'function') {
    Object.defineProperty(Array.prototype, 'flatMap', {
      configurable: true,
      writable: true,
      value: function (callback, thisArg) {
        var mapped = Array.prototype.map.call(this, callback, thisArg);
        var result = [];
        mapped.forEach(function (value) {
          if (Array.isArray(value)) {
            Array.prototype.forEach.call(value, function (item) { result.push(item); });
          } else {
            result.push(value);
          }
        });
        return result;
      }
    });
  }

  // HTMX 2 uses flat during startup and fromEntries to serialize requests.
  if (typeof Array.prototype.flat !== 'function') {
    Object.defineProperty(Array.prototype, 'flat', {
      configurable: true,
      writable: true,
      value: function (depth) {
        var result = [];
        function append(array, remaining) {
          Array.prototype.forEach.call(array, function (value) {
            if (remaining > 0 && Array.isArray(value)) append(value, remaining - 1);
            else result.push(value);
          });
        }
        append(this, depth === undefined ? 1 : Math.floor(Number(depth)));
        return result;
      }
    });
  }
  if (typeof Object.fromEntries !== 'function') {
    Object.defineProperty(Object, 'fromEntries', {
      configurable: true,
      writable: true,
      value: function (entries) {
        var result = {};
        for (var entry of entries) {
          if (entry === null || (typeof entry !== 'object' && typeof entry !== 'function')) {
            throw new TypeError('Expected a key/value pair');
          }
          Object.defineProperty(result, entry[0], {
            value: entry[1], configurable: true, writable: true, enumerable: true
          });
        }
        return result;
      }
    });
  }

  // Page-specific Yamtrack scripts also initialize after a TV page swap.
  window.ytvOnPage = function (initialize) {
    document.addEventListener('DOMContentLoaded', initialize);
    document.addEventListener('ytv:page', initialize);
  };

  function supportsFlexGap() {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px';
    for (var i = 0; i < 2; i++) {
      var item = document.createElement('div');
      item.style.height = '1px';
      probe.appendChild(item);
    }
    document.body.appendChild(probe);
    var supported = probe.offsetHeight === 3;
    probe.remove();
    return supported;
  }

  function flexItems(container) {
    var items = [];
    Array.prototype.forEach.call(container.childNodes, function (node) {
      if (node.nodeType === 3 && node.nodeValue.trim()) items.push({ node:node, order:0 });
      if (node.nodeType !== 1) return;
      var style = window.getComputedStyle(node);
      if (style.display !== 'none' && style.position !== 'absolute' && style.position !== 'fixed') {
        items.push({ node:node, order:Number(style.order) });
      }
    });
    if (items.length < 2) return [];
    return items.map(function (item, index) {
      if (item.node.nodeType === 3) {
        var text = document.createElement('span');
        container.insertBefore(text, item.node);
        text.appendChild(item.node);
        item.node = text;
      }
      item.index = index;
      return item;
    }).sort(function (a, b) { return a.order - b.order || a.index - b.index; });
  }

  function updateFlexGaps(previous) {
    var offsets = new Map();
    function add(element, property, amount) {
      if (!amount) return;
      if (!offsets.has(element)) offsets.set(element, {});
      var rules = offsets.get(element);
      rules[property] = (rules[property] || 0) + amount;
    }

    var root = document.documentElement;
    root.removeAttribute('data-ytv-flex-gap');
    Array.prototype.forEach.call(document.querySelectorAll('body, body *'), function (container) {
      var style = window.getComputedStyle(container);
      if (style.display !== 'flex' && style.display !== 'inline-flex') return;
      var rowGap = parseFloat(style.getPropertyValue('grid-row-gap')) || 0;
      var columnGap = parseFloat(style.getPropertyValue('grid-column-gap')) || 0;
      if ((!rowGap && !columnGap) || !container.getClientRects().length) return;
      var items = flexItems(container);
      if (!items.length) return;

      var horizontal = style.flexDirection.indexOf('row') === 0;
      var reverse = /-reverse$/.test(style.flexDirection);
      var rtl = style.direction === 'rtl';
      var mainGap = horizontal ? columnGap : rowGap;
      var mainStartsAtEnd = horizontal ? reverse !== rtl : reverse;
      var mainSides = horizontal ? ['margin-left', 'margin-right'] : ['margin-top', 'margin-bottom'];
      if (style.flexWrap === 'nowrap') {
        items.slice(1).forEach(function (item) { add(item.node, mainSides[Number(mainStartsAtEnd)], mainGap); });
        return;
      }

      // Trailing margins create gutters on every flex line. Offset the outer margins on the container.
      var mainEnd = mainSides[Number(!mainStartsAtEnd)];
      var crossStartsAtEnd = (style.flexWrap === 'wrap-reverse') !== (!horizontal && rtl);
      var crossEnd = horizontal ? (crossStartsAtEnd ? 'margin-top' : 'margin-bottom') :
        (crossStartsAtEnd ? 'margin-left' : 'margin-right');
      var crossGap = horizontal ? rowGap : columnGap;
      items.forEach(function (item) {
        add(item.node, mainEnd, mainGap);
        add(item.node, crossEnd, crossGap);
      });
      add(container, mainEnd, -mainGap);
      add(container, crossEnd, -crossGap);
      // The last item on each line also has a trailing margin. Add the same space
      // to the available line length so it does not cause an early wrap.
      add(container, horizontal ? 'width' : 'height', mainGap);
    });

    offsets.forEach(function (rules, element) {
      var style = window.getComputedStyle(element);
      Object.keys(rules).forEach(function (property) {
        rules[property] += parseFloat(style.getPropertyValue(property)) || 0;
      });
    });
    previous.forEach(function (rules, element) {
      Object.keys(rules).forEach(function (property) {
        if (!offsets.has(element) || !(property in offsets.get(element))) {
          element.style.removeProperty('--ytv-gap-' + property);
        }
      });
    });
    offsets.forEach(function (rules, element) {
      Object.keys(rules).forEach(function (property) {
        var name = '--ytv-gap-' + property;
        var value = rules[property] + 'px';
        if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
      });
    });
    root.setAttribute('data-ytv-flex-gap', '');
    return offsets;
  }

  function changeDialogTree(change) {
    if (window.Alpine) window.Alpine.mutateDom(change);
    else change();
  }

  function updateDialogs(schedule, watched) {
    var open = false;
    Array.prototype.forEach.call(document.querySelectorAll('[data-ytv-dialog],.ytv-action-dialog'), function (overlay) {
      // Alpine owns the visibility state. Schedule from its show and hide hooks
      // as well as from DOM mutations, including when removing an inline style.
      if (!watched.has(overlay) && overlay._x_doShow && overlay._x_doHide) {
        watched.add(overlay);
        ['_x_doShow', '_x_doHide'].forEach(function (name) {
          var change = overlay[name];
          overlay[name] = function () {
            change.call(this);
            schedule();
          };
        });
      }
      var shell = overlay.parentElement;
      var mounted = shell.classList.contains('ytv-modal');
      var owner = mounted ? shell.parentElement : shell;
      var visible = owner.getClientRects().length && !overlay.hidden && overlay.style.display !== 'none';
      if (!visible) {
        if (mounted) {
          shell.close();
          changeDialogTree(function () {
            owner.insertBefore(overlay, shell);
            shell.remove();
          });
        }
        return;
      }
      if (!mounted) {
        shell = document.createElement('dialog');
        shell.className = 'ytv-modal';
        shell.setAttribute('aria-label', overlay.getAttribute('aria-label') || 'Yamtrack');
        shell.setAttribute('autofocus', '');
        // Keep the same Alpine scope and HTMX target inside the owning card or row.
        changeDialogTree(function () {
          owner.insertBefore(shell, overlay);
          shell.appendChild(overlay);
        });
        shell.addEventListener('cancel', function (event) { event.preventDefault(); });
      }
      if (!shell.open) shell.showModal();
      open = true;
    });
    if (open) document.documentElement.setAttribute('data-ytv-modal-open', '');
    else document.documentElement.removeAttribute('data-ytv-modal-open');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var needsGaps = !supportsFlexGap();
    var previous = new Map();
    var watched = new WeakSet();
    var pending = false;
    var options = {
      subtree:true, childList:true, attributes:true, attributeOldValue:true,
      attributeFilter:['class', 'style', 'hidden', 'open', 'dir']
    };
    function schedule() {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        updateDialogs(schedule, watched);
        if (needsGaps) previous = updateFlexGaps(previous);
      });
    }
    var observer = new MutationObserver(function (records) {
      if (records.some(function (record) {
        if (record.attributeName !== 'class') return true;
        function withoutFocus(value) {
          return (value || '').split(/\s+/).filter(function (name) { return name && name !== 'ytv-focus'; }).join(' ');
        }
        return withoutFocus(record.oldValue) !== withoutFocus(record.target.getAttribute('class'));
      })) schedule();
    });
    observer.observe(document.body, options);
    window.addEventListener('resize', schedule);
    window.addEventListener('load', schedule);
    schedule();
  });

  document.addEventListener('alpine:init', function () {
    var alpine = window.Alpine;
    if (!alpine || typeof alpine.interceptInit !== 'function') return;
    alpine.interceptInit(function (element) {
      var dialog = element.matches('.fixed.inset-0.flex[x-show]');
      if (!dialog && !element.matches('.absolute[x-show]')) return;
      // Start hidden even if x-show fails. Alpine removes the inline display
      // setting when the component's actual open state becomes true.
      element.style.display = 'none';
      element.setAttribute(dialog ? 'data-ytv-dialog' : 'data-ytv-popover', '');
    });
  });
}());

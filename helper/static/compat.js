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

  document.addEventListener('alpine:init', function () {
    var alpine = window.Alpine;
    if (!alpine || typeof alpine.interceptInit !== 'function') return;
    alpine.interceptInit(function (element) {
      var dialog = element.matches('.fixed.inset-0[x-show]');
      if (!dialog && !element.matches('.absolute[x-show]')) return;
      // Start hidden even if x-show fails. Alpine removes the inline display
      // setting when the component's actual open state becomes true.
      element.style.display = 'none';
      element.setAttribute(dialog ? 'data-ytv-dialog' : 'data-ytv-popover', '');
    });
  });
}());

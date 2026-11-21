(function () {
  'use strict';
  var form = document.getElementById('connect');
  var field = document.getElementById('helper-url');
  var hint = document.getElementById('server-hint');
  var error = document.getElementById('server-error');
  var keypad = document.getElementById('address-keypad');
  var keyboard = document.getElementById('keyboard');
  var keys = Array.prototype.slice.call(keypad.querySelectorAll('button'));
  var connect = document.getElementById('open');
  var storageKey = 'yamtrack-helper-origin';
  var keypadHint = hint.textContent;
  var colorKeys = { 403:'http', 404:'https', 405:'.', 406:':' };

  try { field.value = window.localStorage.getItem(storageKey) || ''; } catch (ignored) { /* Storage is optional. */ }
  (field.value ? connect : keys[0]).focus();

  function editAddress(key) {
    if (key === 'clear') field.value = '';
    else if (key === 'delete') field.value = field.value.slice(0, -1);
    else if (key === 'http' || key === 'https') {
      field.value = key + '://' + field.value.trim().replace(/^https?:\/\//i, '');
    } else if (!field.readOnly && document.activeElement === field) {
      field.setRangeText(key, field.selectionStart, field.selectionEnd, 'end');
    } else field.value += key;
    error.hidden = true;
  }

  keypad.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-key]');
    if (button) editAddress(button.getAttribute('data-key'));
  });
  keyboard.addEventListener('click', function () {
    field.readOnly = !field.readOnly;
    keyboard.textContent = field.readOnly ? 'Use keyboard' : 'Use keypad';
    hint.textContent = field.readOnly ? keypadHint : 'Enter the full HTTP or HTTPS address, including its port if needed.';
    (field.readOnly ? keys[0] : field).focus();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var address = field.value.trim();
    var ipv4 = address.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
    if (ipv4) {
      var host = ipv4[1].split('.').map(Number).join('.');
      address = 'http://' + host + ':' + (ipv4[2] || '8765');
    }
    var url;
    try { url = new URL(address); } catch (ignored) { /* Show the same message for invalid input. */ }
    if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      error.textContent = 'Enter an IPv4 address or an HTTP or HTTPS URL with just the host and optional port.';
      error.hidden = false;
      (field.readOnly ? keys[0] : field).focus();
      return;
    }
    error.hidden = true;
    try { window.localStorage.setItem(storageKey, url.origin); } catch (ignored) { /* Connection still works. */ }
    window.location.replace(url.origin + '/__tv/');
  });

  document.addEventListener('keydown', function (event) {
    if (event.keyCode === 461) { window.close(); return; }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    var colorKey = colorKeys[event.keyCode];
    if (colorKey) {
      event.preventDefault();
      editAddress(colorKey);
      return;
    }
    if (field.readOnly && (/^[\d.:]$/.test(event.key) || event.key === 'Backspace')) {
      event.preventDefault();
      editAddress(event.key === 'Backspace' ? 'delete' : event.key);
      return;
    }
    if (event.keyCode < 37 || event.keyCode > 40) return;
    if (document.activeElement === field) {
      if (event.keyCode !== 40) return;
      event.preventDefault();
      (field.readOnly ? keys[0] : connect).focus();
      return;
    }
    var index = keys.indexOf(document.activeElement);
    if (index === -1) return;
    var columns = 4;
    var next = index;
    if (event.keyCode === 37 && index % columns > 0) next--;
    if (event.keyCode === 39 && index % columns < columns - 1) next++;
    if (event.keyCode === 38 && index >= columns) next -= columns;
    if (event.keyCode === 40 && index < keys.length - columns) next += columns;
    event.preventDefault();
    keys[next].focus();
  });
}());

(function () {
  'use strict';
  var form = document.getElementById('connect');
  var field = document.getElementById('helper-url');
  var error = document.getElementById('server-error');
  var connect = document.getElementById('open');
  var storageKey = 'yamtrack-helper-origin';

  try { field.value = window.localStorage.getItem(storageKey) || ''; } catch (ignored) { /* Storage is optional. */ }
  (field.value ? connect : field).focus();

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var url;
    try { url = new URL(field.value.trim()); } catch (ignored) { /* Show the same message for invalid input. */ }
    if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      error.textContent = 'Enter an HTTP or HTTPS address with just the host and optional port.';
      error.hidden = false;
      field.focus();
      return;
    }
    error.hidden = true;
    try { window.localStorage.setItem(storageKey, url.origin); } catch (ignored) { /* Connection still works. */ }
    window.location.replace(url.origin + '/__tv/');
  });

  document.addEventListener('keydown', function (event) {
    if (event.keyCode === 461) window.close();
    if (event.keyCode === 38 && document.activeElement === connect) {
      event.preventDefault();
      field.focus();
    }
    if (event.keyCode === 40 && document.activeElement !== connect) {
      event.preventDefault();
      connect.focus();
    }
  });
}());

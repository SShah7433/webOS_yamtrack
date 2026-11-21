(function () {
  'use strict';
  var status = document.getElementById('status');
  var code = document.getElementById('code');
  var retry = document.getElementById('retry');
  var qr = document.getElementById('qr-code');
  var address = document.getElementById('pair-address');
  var timer;
  function request(path, method) {
    return fetch(path, { method:method || 'GET', credentials:'same-origin', cache:'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('Helper returned ' + response.status);
        return response.json();
      });
  }
  function poll() {
    request('/__tv/status').then(function (data) {
      if (data.ready) { window.location.replace('/'); return; }
      if (data.expired) {
        qr.setAttribute('hidden', '');
        status.textContent = 'This code expired. Press OK for a new code.';
        retry.hidden = false;
        retry.focus();
        return;
      }
      status.textContent = 'Waiting for approval on your phone…';
      timer = setTimeout(poll, 2000);
    }).catch(function () {
      status.textContent = 'Cannot reach the helper. Retrying…';
      timer = setTimeout(poll, 4000);
    });
  }
  function start() {
    clearTimeout(timer);
    retry.hidden = true;
    qr.setAttribute('hidden', '');
    request('/__tv/start', 'POST').then(function (data) {
      if (data.ready) { window.location.replace('/'); return; }
      code.textContent = data.code.slice(0, 3) + ' ' + data.code.slice(3);
      var phoneURL = address.href + '?code=' + encodeURIComponent(data.code);
      if (window.YamtrackQR && window.YamtrackQR.draw(qr, phoneURL)) {
        qr.removeAttribute('hidden');
      }
      poll();
    }).catch(function () {
      status.textContent = 'Cannot connect. Check the helper, then press OK to retry.';
      retry.hidden = false;
      retry.focus();
    });
  }
  retry.onclick = start;
  document.addEventListener('keydown', function (event) {
    if (event.keyCode === 461 || event.keyCode === 27) { event.preventDefault(); window.close(); }
    if (event.keyCode === 13 && !retry.hidden) { event.preventDefault(); start(); }
  });
  start();
}());

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const realQR = require('../helper/static/qr.js').YamtrackQR;

function element(extra) {
  return Object.assign({
    attrs: { hidden:'' }, textContent:'', hidden:true,
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    focus() {}
  }, extra);
}

(async function () {
  const elements = {
    status:element(), code:element(), retry:element(), 'qr-code':element(),
    'pair-address':element({ href:'http://tv.test:8765/__tv/pair' })
  };
  const timers = [];
  const links = [];
  let code = '123456', expired = false, ready = false, destination;
  vm.runInNewContext(fs.readFileSync('helper/static/pair.js', 'utf8'), {
    document:{ getElementById:id => elements[id], addEventListener() {} },
    window:{
      YamtrackQR:{ draw(svg, text) { links.push(text); return realQR.draw(svg, text); } },
      location:{ replace(path) { destination = path; } }
    },
    fetch:async path => ({ ok:true, json:async () => path === '/__tv/start'
      ? { code, ready:false } : { expired, ready } }),
    setTimeout:fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    encodeURIComponent
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.equal(elements.code.textContent, '123 456');
  assert.equal(links[0], 'http://tv.test:8765/__tv/pair?code=123456');
  assert.equal(elements['qr-code'].attrs.hidden, undefined);
  assert.equal(elements['qr-code'].attrs.viewBox, '-4 -4 41 41');
  assert.match(elements['qr-code'].innerHTML, /fill="#fff"/);

  expired = true;
  timers.shift()();
  await flush();
  assert.equal(elements['qr-code'].attrs.hidden, '');
  assert.equal(elements.retry.hidden, false);

  code = '654321'; expired = false;
  elements.retry.onclick();
  await flush();
  assert.equal(links[1], 'http://tv.test:8765/__tv/pair?code=654321');
  assert.equal(elements['qr-code'].attrs.hidden, undefined);
  ready = true;
  timers.shift()();
  await flush();
  assert.equal(destination, '/');
  assert.equal(realQR.draw(element(), 'x'.repeat(79)), false);
  console.log('QR rendering, expiry, refresh, approval redirect, and capacity fallback passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });

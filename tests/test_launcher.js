const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function launch(saved = '') {
  let opened;
  const launcher = join(__dirname, '..', 'app');
  const markup = readFileSync(join(launcher, 'index.html'), 'utf8');
  const document = {
    getElementById(id) { return controls[id]; },
    addEventListener(name, handler) { this[name] = handler; }
  };
  function control() {
    return {
      focus() { document.activeElement = this; },
      addEventListener(name, handler) { this[name] = handler; }
    };
  }
  const controls = {
    connect:control(),
    'server-hint':{ textContent:'Enter an IPv4 address with the keypad.' },
    'server-error':{ hidden:true },
    'helper-url':Object.assign(control(), { readOnly:true }),
    'address-keypad':Object.assign(control(), { querySelectorAll() { return keys; } }),
    keyboard:control(),
    open:control()
  };
  const keys = Array.from(markup.matchAll(/<button[^>]*(?:data-key|id)="([^"]+)"[^>]*>/g), ([, key]) => {
    return controls[key] || Object.assign(control(), { getAttribute() { return key; } });
  });
  const window = {
    location:{ replace(url) { opened = url; } },
    localStorage:{ getItem() { return saved; }, setItem(key, url) { saved = url; } }
  };
  vm.runInNewContext(readFileSync(join(launcher, 'launch.js'), 'utf8'), { document, window, URL });
  return {
    controls, document,
    opened: () => opened,
    saved: () => saved,
    submit() { controls.connect.submit({ preventDefault() {} }); },
    press(key, keyCode) {
      const event = { key, keyCode, preventDefault() { this.defaultPrevented = true; } };
      document.keydown(event);
      return event.defaultPrevented;
    },
    click(key) {
      const target = keys.find(button => button.getAttribute && button.getAttribute('data-key') === key);
      assert(target, `Missing keypad button ${key}`);
      controls['address-keypad'].click({ target:{ closest() { return target; } } });
    }
  };
}

test('launcher connects using the saved or newly entered helper origin', () => {
  const app = launch('http://tv.test:8765');
  const { controls, document } = app;
  assert.equal(document.activeElement, controls.open);
  assert.equal(controls['helper-url'].value, app.saved());

  app.press('ArrowUp', 38);
  assert.equal(document.activeElement, controls.keyboard);
  controls.keyboard.click();
  assert.equal(controls['helper-url'].readOnly, false);
  assert.equal(document.activeElement, controls['helper-url']);

  for (const invalid of ['file:///tmp/helper', 'https://user:pass@tv.test', 'https://tv.test/__tv/', 'https://tv.test?x=1']) {
    controls['helper-url'].value = invalid;
    app.submit();
    assert.equal(controls['server-error'].hidden, false);
    assert.equal(controls['helper-url'], document.activeElement);
    assert.equal(app.opened(), undefined);
  }

  controls['helper-url'].value = '  https://New.TV.Test:443/  ';
  app.submit();
  assert.equal(controls['server-error'].hidden, true);
  assert.equal(app.saved(), 'https://new.tv.test');
  assert.equal(app.opened(), 'https://new.tv.test/__tv/');
});

test('launcher supports keypad dots, an optional port, and remote number keys', () => {
  const app = launch();
  const { controls, document } = app;
  const field = controls['helper-url'];
  assert.equal(field.readOnly, true);
  assert.equal(document.activeElement.getAttribute('data-key'), '1');
  for (let row = 0; row < 3; row++) app.press('ArrowDown', 40);
  assert.equal(document.activeElement.getAttribute('data-key'), '.');
  app.press('ArrowRight', 39);
  app.press('ArrowRight', 39);
  assert.equal(document.activeElement.getAttribute('data-key'), ':');
  for (const key of '192.168.1.20') {
    if (key === '.') app.click(key);
    else app.press(key, key.charCodeAt(0));
  }
  app.submit();
  assert.equal(app.opened(), 'http://192.168.1.20:8765/__tv/');

  app.click(':');
  for (const key of '9099') app.click(key);
  app.click('delete');
  app.click('0');
  app.submit();
  assert.equal(app.opened(), 'http://192.168.1.20:9090/__tv/');

  app.click('clear');
  for (const key of '192.168.1.999') app.click(key);
  app.submit();
  assert.equal(controls['server-error'].hidden, false);
  assert.equal(app.saved(), 'http://192.168.1.20:9090');
});

test('the remote color buttons set the protocol and enter address punctuation', () => {
  const app = launch();
  const field = app.controls['helper-url'];
  assert(app.press('ColorF0Red', 403));
  assert.equal(field.value, 'http://');
  for (const [index, octet] of ['192', '168', '1', '20'].entries()) {
    if (index > 0) assert(app.press('ColorF2Yellow', 405));
    for (const digit of octet) app.press(digit, digit.charCodeAt(0));
  }
  assert(app.press('ColorF3Blue', 406));
  for (const digit of '9090') app.click(digit);
  assert.equal(field.value, 'http://192.168.1.20:9090');
  assert(app.press('ColorF1Green', 404));
  assert(app.press('ColorF1Green', 404));
  assert.equal(field.value, 'https://192.168.1.20:9090');
  app.submit();
  assert.equal(app.opened(), 'https://192.168.1.20:9090/__tv/');
  assert(app.press('ColorF0Red', 403));
  assert.equal(field.value, 'http://192.168.1.20:9090');
});

test('remote punctuation inserts at the cursor when the URL field is editable', () => {
  const app = launch('https://tvtest:9090');
  const field = app.controls['helper-url'];
  app.controls.keyboard.click();
  field.selectionStart = field.selectionEnd = 'https://tv'.length;
  field.setRangeText = function (key, start, end) {
    this.value = this.value.slice(0, start) + key + this.value.slice(end);
  };
  assert(app.press('ColorF2Yellow', 405));
  assert.equal(field.value, 'https://tv.test:9090');
});

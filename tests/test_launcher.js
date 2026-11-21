const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

test('launcher connects using the saved or newly entered helper origin', () => {
  let submit;
  let opened;
  let saved = 'http://tv.test:8765';
  const document = {
    getElementById(id) { return controls[id]; },
    addEventListener() {}
  };
  const controls = {
    connect:{ addEventListener(name, handler) { if (name === 'submit') submit = handler; } },
    'server-error':{ hidden:true },
    'helper-url':{ focus() { document.activeElement = this; } },
    open:{ focus() { document.activeElement = this; } }
  };
  const window = {
    location:{ replace(url) { opened = url; } },
    localStorage:{ getItem() { return saved; }, setItem(key, url) { saved = url; } }
  };
  vm.runInNewContext(readFileSync(join(__dirname, '..', 'app', 'launch.js'), 'utf8'), { document, window, URL });
  const event = { preventDefault() {} };
  assert.equal(document.activeElement, controls.open);
  assert.equal(controls['helper-url'].value, saved);

  for (const invalid of ['file:///tmp/helper', 'https://user:pass@tv.test', 'https://tv.test/__tv/', 'https://tv.test?x=1']) {
    controls['helper-url'].value = invalid;
    submit(event);
    assert.equal(controls['server-error'].hidden, false);
    assert.equal(controls['helper-url'], document.activeElement);
    assert.equal(opened, undefined);
  }

  controls['helper-url'].value = '  https://New.TV.Test:443/  ';
  submit(event);
  assert.equal(controls['server-error'].hidden, true);
  assert.equal(saved, 'https://new.tv.test');
  assert.equal(opened, 'https://new.tv.test/__tv/');
});

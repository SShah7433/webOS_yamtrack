(function () {
  'use strict';

  var status = document.getElementById('ytv-page-status');
  var htmx = window.htmx;
  if (!status || !htmx || !window.Alpine || !window.fetch || !window.AbortController) return;

  var displayed = new URL(window.location.href);
  var request = null;
  var redirecting = false;
  var clickedSubmitter = null;
  var regions = ['body > div[x-data]', '#messages-list', '#persistent-messages-actions'];
  var writes = new Set();
  var appPage = /^(\/|\/(?:search|calendar|lists|journal|statistics|create)|\/list\/\d+|\/(?:lists|settings)\/[^/]+)$/;
  var libraryPage = /^\/[^/]+\/(?:tv|season|episode|movie|anime|manga|game|book|comic|boardgame)$/;
  var detailPage = /^\/details\/[^/]+\/[^/]+\/[^/]+\/[^/]+(?:\/season\/\d+)?$/;
  var listAsset = /^\/static\/(?:css\/libraries\/select2-4\.1\.0\.min\.css|django_select2\/django_select2(?:\.min)?\.js|js\/(?:libraries\/(?:jquery-3\.7\.1|select2-4\.1\.0)\.min\.js|i18n\/[\w-]+\.js))$/;
  var pageScript = /^\/static\/js\/(?:libraries\/(?:chartjs-4\.4\.9|chartjs-datalabels-2\.0\.0)\.min\.js|date-range\.js|statistics-charts\.js|copy-item\.js)$/;

  function eligible(url) {
    return url.origin === window.location.origin &&
      (appPage.test(url.pathname) || libraryPage.test(url.pathname) || detailPage.test(url.pathname));
  }

  function pageAssets(page, base) {
    var assets = { shared:[], optional:[], data:[] };
    var nodes = page.querySelectorAll('head script,head style,head link[rel="stylesheet"],body > script');
    Array.prototype.forEach.call(nodes, function (node) {
      if (node.tagName === 'STYLE' && node.textContent.indexOf('.htmx-indicator') !== -1) return;
      if (node.tagName === 'SCRIPT' && node.getAttribute('type') === 'application/json') {
        assets.data.push(node);
        return;
      }
      var ref = node.getAttribute(node.tagName === 'LINK' ? 'href' : 'src');
      if (ref) {
        var url = new URL(ref, base);
        if (url.origin === base.origin && (listAsset.test(url.pathname) || pageScript.test(url.pathname))) {
          assets.optional.push({ key:url.pathname, url:url.href, node:node });
          return;
        }
      } else if (node.tagName === 'SCRIPT' && /\bfunction pruneEmptyJournalDays\(\)/.test(node.textContent)) {
        assets.optional.push({ key:'journal', node:node });
        return;
      }
      assets.shared.push(node.outerHTML);
    });
    assets.shared = assets.shared.join('\n');
    return assets;
  }

  var initial = pageAssets(document, displayed);
  var loaded = new Map();
  var pageData = initial.data;
  initial.optional.forEach(function (asset) {
    loaded.set(asset.key, { element:asset.node, ready:Promise.resolve() });
  });

  // Keep the old page visible while loading page-specific dependencies in their
  // original order. Scripts register their page initializers once per document.
  function loadAssets(optional) {
    return optional.reduce(function (previous, asset) {
      return previous.then(function () {
        if (loaded.has(asset.key)) return loaded.get(asset.key).ready;
        var element = document.createElement(asset.node.tagName.toLowerCase());
        var pending = new Promise(function (resolve, reject) {
          if (!asset.url) {
            element.textContent = asset.node.textContent;
            document.body.appendChild(element);
            resolve(element);
            return;
          }
          var timer = setTimeout(fail, 15000);
          function fail() {
            clearTimeout(timer);
            element.parentNode.removeChild(element);
            reject(new Error('Page dependency failed to load'));
          }
          element.onload = function () { clearTimeout(timer); resolve(element); };
          element.onerror = fail;
          if (element.tagName === 'LINK') {
            element.rel = 'stylesheet';
            element.href = asset.url;
          } else {
            element.async = false;
            element.src = asset.url;
          }
          document.head.appendChild(element);
        }).catch(function (error) {
          loaded.delete(asset.key);
          throw error;
        });
        loaded.set(asset.key, { element:element, ready:pending });
        return pending;
      });
    }, Promise.resolve());
  }

  function scrollToPage(url, offset) {
    if (offset == null && url.hash) {
      var id = url.hash.slice(1);
      try { id = decodeURIComponent(id); } catch (error) { /* Keep the literal ID. */ }
      var anchor = document.getElementById(id);
      var toolbar = document.getElementById('ytv-toolbar');
      if (anchor) offset = window.pageYOffset + anchor.getBoundingClientRect().top - (toolbar ? toolbar.offsetHeight : 0) - 12;
    }
    window.scrollTo(0, Math.max(0, offset || 0));
  }

  function pushPage(url) {
    window.history.replaceState(Object.assign({}, window.history.state, {
      ytvPage:true, ytvScroll:window.pageYOffset
    }), '', displayed.href);
    window.history.pushState({ ytvPage:true, ytvScroll:null }, '', url.href);
    window.history.scrollRestoration = 'manual';
  }

  function load(url, options) {
    options = options || {};
    if (request) request.abort();
    var controller = new AbortController();
    controller.formSubmission = Boolean(options.body);
    request = controller;
    status.textContent = 'Loading…';
    var timeout = setTimeout(function () { controller.abort(); }, 25000);

    window.fetch(url.href, {
      method:options.body ? 'POST' : 'GET', body:options.body,
      credentials:'same-origin', signal:controller.signal
    }).then(function (response) {
      if (request !== controller) return;
      var destination = response.redirected ? new URL(response.url) : url;
      if (destination.origin !== url.origin) throw new Error('Unexpected cross-origin redirect');
      if (!response.ok || !eligible(destination) || !/\btext\/html\b/i.test(response.headers.get('Content-Type') || '')) {
        // A redirect to the pairing screen still needs to run as a real page.
        if (destination.pathname === '/__tv/') redirecting = true;
        if (redirecting) window.location.href = destination.href;
        else throw new Error('Page request failed');
        return;
      }

      return response.text().then(function (html) {
        if (request !== controller) return;
        var page = new DOMParser().parseFromString(html, 'text/html');
        var current = regions.map(function (selector) { return document.querySelector(selector); });
        var next = regions.map(function (selector) { return page.querySelector(selector); });
        var assets = pageAssets(page, destination);
        if (!current[0] || !next[0] || !next[0].querySelector('main') ||
            assets.shared !== initial.shared || next.some(function (node, index) {
              return Boolean(node) !== Boolean(current[index]) || (node && node.querySelector('script'));
            })) {
          if (options.body && !response.redirected) throw new Error('Unexpected form response');
          redirecting = true;
          window.location.href = destination.href;
          return;
        }

        return loadAssets(assets.optional).then(function () {
          if (request !== controller) return;
          if (controller.signal.aborted || writes.size) throw new Error('Page could not be updated');
          assets.optional.forEach(function (asset) {
            var dateFormat = asset.node.getAttribute('data-date-format');
            if (dateFormat) loaded.get(asset.key).element.setAttribute('data-date-format', dateFormat);
          });
          var replacements = next.map(function (node) { return node && document.importNode(node, true); });
          var data = assets.data.map(function (node) { return document.importNode(node, true); });
          var refresh = options.refresh || destination.href === displayed.href;
          var offset = refresh ? window.pageYOffset : null;
          if (options.restore) {
            offset = (window.history.state || {}).ytvScroll;
            if (destination.href !== url.href) window.history.replaceState(window.history.state, '', destination.href);
          } else if (!refresh) {
            pushPage(destination);
          }
          displayed = destination;

          document.dispatchEvent(new CustomEvent('ytv:before-page'));
          replacements.forEach(function (replacement, index) {
            if (replacement) current[index].parentNode.replaceChild(replacement, current[index]);
          });
          pageData.forEach(function (node) { node.parentNode.removeChild(node); });
          data.forEach(function (node) { document.body.appendChild(node); });
          pageData = data;
          replacements.forEach(function (replacement) { if (replacement) htmx.process(replacement); });

          var jquery = window.jQuery;
          if (jquery && jquery.fn.djangoSelect2) {
            jquery(replacements[0]).find('.django-select2').not('.select2-hidden-accessible').djangoSelect2();
          }
          document.title = page.title;
          document.dispatchEvent(new CustomEvent('ytv:page', { detail:{ refresh:refresh } }));
          scrollToPage(destination, offset);
        });
      });
    }).then(function () {
      clearTimeout(timeout);
      if (request !== controller) return;
      request = null;
      if (!redirecting) status.textContent = '';
    }, function () {
      clearTimeout(timeout);
      if (request !== controller) return;
      request = null;
      if (options.restore) {
        window.history.replaceState({ ytvPage:true, ytvScroll:window.pageYOffset }, '', displayed.href);
      }
      status.textContent = 'Couldn’t load the page. Try again.';
    });
  }

  function navigate(url, homeShortcut) {
    if (!eligible(url)) return false;
    if (redirecting || writes.size || (request && request.formSubmission)) return true;
    if (homeShortcut && url.pathname === '/' && displayed.pathname === '/') {
      load(displayed, { refresh:true });
    } else if (url.pathname === displayed.pathname && url.search === displayed.search) {
      if (request) {
        request.abort();
        request = null;
        status.textContent = '';
      }
      if (url.href !== displayed.href) {
        pushPage(url);
        displayed = url;
      }
      if (url.hash) scrollToPage(url, null);
    } else load(url);
    return true;
  }

  document.addEventListener('htmx:beforeSend', function (event) {
    if (event.detail.requestConfig.verb !== 'get') writes.add(event.detail.xhr);
  });
  document.addEventListener('htmx:afterRequest', function (event) {
    writes.delete(event.detail.xhr);
  });
  document.addEventListener('htmx:beforeOnLoad', function (event) {
    var xhr = event.detail.xhr;
    var redirect = xhr.getResponseHeader('HX-Redirect');
    if (!redirect) {
      redirect = xhr.getResponseHeader('HX-Location');
      if (!redirect) return;
      if (redirect.charAt(0) === '{') {
        try {
          var location = JSON.parse(redirect);
          if (location.target && location.target !== 'body') return;
          redirect = location.path;
        } catch (error) { return; }
      }
    }
    if (!redirect) return;
    if (/^%2f/i.test(redirect)) {
      try { redirect = decodeURIComponent(redirect); } catch (error) { return; }
    }
    var url = new URL(redirect, displayed);
    if (!eligible(url)) return;
    event.preventDefault();
    load(url, { refresh:url.href === displayed.href });
  });

  function usesHtmx(element) {
    return element.closest('[hx-boost],[data-hx-boost]') ||
      element.matches('[hx-get],[hx-post],[hx-put],[hx-patch],[hx-delete],[data-hx-get],[data-hx-post],[data-hx-put],[data-hx-patch],[data-hx-delete]');
  }

  // Chromium 68 has no SubmitEvent.submitter. Keep the button from the click
  // that triggered this submit so its formaction also works on the remote.
  document.addEventListener('click', function (event) {
    var button = event.target.closest('button,input[type="submit"]');
    if (!button || button.type !== 'submit' || !button.form) return;
    clickedSubmitter = button;
    setTimeout(function () { if (clickedSubmitter === button) clickedSubmitter = null; }, 0);
  }, true);

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest('a[href]');
    if (!link || (link.target && link.target.toLowerCase() !== '_self') || link.hasAttribute('download') || usesHtmx(link)) return;
    if (navigate(new URL(link.href), link.matches('#ytv-toolbar .ytv-key-red'))) event.preventDefault();
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (event.defaultPrevented || form.target || usesHtmx(form)) return;
    var submitter = event.submitter || clickedSubmitter || document.activeElement;
    if (!submitter || submitter.form !== form || submitter.type !== 'submit') submitter = null;
    var url = new URL(submitter && submitter.hasAttribute('formaction') ? submitter.formAction : form.action);
    var method = submitter && submitter.hasAttribute('formmethod') ? submitter.formMethod : form.method;
    var data;
    if (method.toLowerCase() === 'get' && eligible(url)) {
      data = new FormData(form);
      if (submitter && submitter.name) data.append(submitter.name, submitter.value);
      url.search = new URLSearchParams(data).toString();
      if (navigate(url)) event.preventDefault();
    } else if (method.toLowerCase() === 'post' && url.origin === displayed.origin &&
               /^\/(?:create|reload_calendar|list\/(?:create|edit|delete))$/.test(url.pathname)) {
      event.preventDefault();
      if (redirecting || writes.size || (request && request.formSubmission)) return;
      data = new FormData(form);
      if (submitter && submitter.name) data.append(submitter.name, submitter.value);
      load(url, { body:new URLSearchParams(data) });
    }
  });

  document.addEventListener('ytv:navigate', function (event) {
    if (navigate(new URL(event.detail))) event.preventDefault();
  });

  window.addEventListener('popstate', function (event) {
    var url = new URL(window.location.href);
    if (request) {
      request.abort();
      request = null;
      status.textContent = '';
    }
    if (redirecting || !event.state || !event.state.ytvPage || !eligible(url)) return;
    if (url.pathname === displayed.pathname && url.search === displayed.search) {
      displayed = url;
      scrollToPage(url, event.state.ytvScroll);
    } else load(url, { restore:true });
  });
}());

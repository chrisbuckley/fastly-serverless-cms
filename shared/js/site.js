/**
 * edge/cms — Public site JavaScript
 *
 * Loaded with `defer` on reader pages. Strict-CSP safe: no inline handlers,
 * no eval, same-origin requests only.
 *
 *   - Edge info widget (sidebar + footer): TTFB, cache state, POP
 *   - "Copy Link" buttons on posts (event delegation on [data-copy-url])
 */
(function () {
  'use strict';

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ===========================================================
  // Edge info widget
  // ===========================================================

  // TTFB from the Navigation Timing API on the main page request.
  function updateTtfb() {
    var entries = performance.getEntriesByType('navigation');
    if (entries.length) {
      setText('edge-stat-ttfb', Math.round(entries[0].responseStart) + 'ms');
    }
  }

  // Cache status of THIS page load. The VCL deliver snippet copies
  // fastly_info.state (HIT/MISS/PASS) into `Server-Timing: cdn-cache;desc=<state>`,
  // which the browser exposes on the navigation entry.
  function updateCache() {
    var entries = performance.getEntriesByType('navigation');
    var timings = (entries.length && entries[0].serverTiming) || [];
    for (var i = 0; i < timings.length; i++) {
      if (timings[i].name === 'cdn-cache' && /^(HIT|MISS|PASS)$/.test(timings[i].description)) {
        setText('edge-stat-cache', timings[i].description);
        return;
      }
    }
  }

  // POP: /api/edge-info is never cached, so it reflects the edge serving this
  // visitor right now. The 3-letter suffix on the last X-Served-By entry is
  // the VCL edge POP; the JSON body's `pop` is the Compute execution POP and
  // is used as a fallback. An optional `city` field is shown when present.
  function updatePop() {
    fetch('/api/edge-info', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('edge-info ' + resp.status);
        var servedBy = resp.headers.get('x-served-by') || '';
        var pop = '';
        if (servedBy) {
          var last = servedBy.split(',').pop().trim();
          var m = last.match(/([A-Z]{3})$/);
          if (m) pop = m[1];
        }
        return resp.json().then(function (data) {
          return {
            pop: pop || (data && data.pop) || '—',
            city: data && typeof data.city === 'string' ? data.city : '',
          };
        });
      })
      .then(function (info) {
        setText('edge-stat-pop', info.pop);
        setText('footer-pop', info.city ? info.city + ' · ' + info.pop : info.pop);
      })
      .catch(function () {});
  }

  function initEdgeInfo() {
    if (!document.getElementById('edge-stat-pop') && !document.getElementById('footer-pop')) return;
    updateTtfb();
    updateCache();
    updatePop();
  }

  // ===========================================================
  // Copy link
  // ===========================================================

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'sr-only';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        return fallbackCopy(text);
      });
    }
    return fallbackCopy(text);
  }

  function flash(button, message) {
    var tip = button.querySelector('.copied-tooltip');
    if (!tip) return;
    tip.textContent = message;
    tip.classList.add('visible');
    window.clearTimeout(button._tipTimer);
    button._tipTimer = window.setTimeout(function () {
      tip.classList.remove('visible');
      tip.textContent = '';
    }, 2000);
  }

  document.addEventListener('click', function (e) {
    var button = e.target.closest('[data-copy-url]');
    if (!button) return;
    e.preventDefault();
    var url = button.getAttribute('data-copy-url') || window.location.href;
    copyText(url).then(
      function () { flash(button, 'Copied!'); },
      function () { flash(button, 'Copy failed'); }
    );
  });

  initEdgeInfo();
}());

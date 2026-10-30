/**
 * edge/cms — Admin JavaScript
 *
 * Single file covering all admin interactivity. Auto-detects which page
 * is loaded and initializes the relevant module. No framework dependencies.
 * Strict-CSP safe: no inline handlers, no eval; user-supplied strings are
 * only ever written with textContent / DOM APIs (the one innerHTML sink, the
 * live preview, escapes its input first).
 *
 * Pages handled:
 *   - Editor     (.editor-pane present)
 *   - Dashboard  (.posts-table present)
 *   - Sidebar    (#sidebar-items present)
 */
(function () {
  'use strict';

  var SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
  var TAG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
  var ICON_RE = /^[a-z0-9-]{1,32}$/;
  var FILENAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.(jpg|jpeg|png|webp|gif)$/;
  var IMAGE_TYPES = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  var MAX_TAGS = 20;
  var MAX_SIDEBAR_ITEMS = 50;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ===========================================================
  // Shared utilities
  // ===========================================================

  /**
   * Generate a URL-safe slug from arbitrary text.
   * Lowercases, replaces spaces with hyphens, strips special chars,
   * collapses runs of hyphens, and trims leading/trailing hyphens.
   */
  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100)
      .replace(/-$/, '');
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Sidebar link rule: https://, http://, or a single leading "/" (not "//"
   * and not "/\", which browsers normalise to "//").
   */
  function isValidSidebarUrl(url) {
    if (!url || /[\s\\]/.test(url)) return false;
    if (/^https?:\/\/./.test(url)) return true;
    return url.charAt(0) === '/' && url.charAt(1) !== '/';
  }

  /**
   * Same-origin fetch that rejects with a readable Error on non-2xx
   * responses (using the JSON `error` field when the server sends one).
   */
  function request(url, options) {
    var opts = options || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (res.ok) return res;
      return res
        .json()
        .catch(function () { return null; })
        .then(function (body) {
          var detail = body && typeof body.error === 'string' ? body.error : 'HTTP ' + res.status;
          throw new Error(detail);
        });
    });
  }

  function showError(el, message) {
    if (!el) {
      if (message) window.alert(message);
      return;
    }
    el.textContent = message || '';
    el.hidden = !message;
  }

  function svgIcon(paths) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (var i = 0; i < paths.length; i++) {
      var node = document.createElementNS(SVG_NS, paths[i][0]);
      var attrs = paths[i][1];
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
      }
      svg.appendChild(node);
    }
    return svg;
  }

  function fetchEdgeInfoPop() {
    return fetch('/api/edge-info', { cache: 'no-store', credentials: 'same-origin' }).then(function (resp) {
      if (!resp.ok) throw new Error('edge-info ' + resp.status);
      var servedBy = resp.headers.get('x-served-by') || '';
      var pop = '';
      if (servedBy) {
        var last = servedBy.split(',').pop().trim();
        var m = last.match(/([A-Z]{3})$/);
        if (m) pop = m[1];
      }
      return resp.json().then(function (data) {
        return pop || (data && data.pop) || '—';
      });
    });
  }

  // ===========================================================
  // Editor page
  // ===========================================================

  function initEditor() {
    var titleInput = document.getElementById('post-title');
    var slugInput = document.getElementById('post-slug');
    var tagsWrapper = document.getElementById('tags-wrapper');
    var tagsInput = document.getElementById('tags-input');
    var tagsHidden = document.getElementById('tags-hidden');
    var imageZone = document.getElementById('image-upload');
    var imageField = document.getElementById('featured-image');
    var editor = document.getElementById('markdown-editor');
    var preview = document.getElementById('preview-content');
    var lineNumbers = document.getElementById('line-numbers');
    var divider = document.getElementById('pane-divider');
    var panes = document.querySelector('.editor-panes');
    var deleteBtn = document.getElementById('delete-post-btn');
    var editorError = document.getElementById('editor-error');

    // ---- Slug auto-generation --------------------------------

    // An existing post keeps its slug unless the author edits it on purpose.
    var slugManuallyEdited = !!(slugInput && slugInput.value);

    if (slugInput) {
      slugInput.addEventListener('input', function () {
        slugManuallyEdited = true;
      });
    }

    if (titleInput && slugInput) {
      titleInput.addEventListener('input', function () {
        if (slugManuallyEdited) return;
        slugInput.value = slugify(titleInput.value);
      });
    }

    // ---- Tag input -------------------------------------------

    function pillTags() {
      var pills = tagsWrapper ? tagsWrapper.querySelectorAll('.tag-pill') : [];
      var values = [];
      for (var i = 0; i < pills.length; i++) values.push(pills[i].getAttribute('data-tag'));
      return values;
    }

    function syncTagsHidden() {
      if (tagsHidden) tagsHidden.value = pillTags().join(',');
    }

    function normalizeTag(text) {
      return text.trim().toLowerCase().replace(/\s+/g, '-');
    }

    function addTag(raw) {
      var text = normalizeTag(raw);
      if (!text || !tagsWrapper || !TAG_RE.test(text)) return;
      var existing = pillTags();
      if (existing.indexOf(text) !== -1 || existing.length >= MAX_TAGS) return;

      var pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.setAttribute('data-tag', text);

      var label = document.createElement('span');
      label.className = 'tag-pill-text';
      label.textContent = text;

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'tag-pill-remove';
      remove.setAttribute('aria-label', 'Remove tag ' + text);
      remove.textContent = '×';

      pill.appendChild(label);
      pill.appendChild(remove);
      tagsWrapper.insertBefore(pill, tagsInput);
      syncTagsHidden();
    }

    if (tagsInput) {
      tagsInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          addTag(tagsInput.value);
          tagsInput.value = '';
        }
        // Backspace on empty input removes last tag
        if (e.key === 'Backspace' && tagsInput.value === '') {
          var pills = tagsWrapper.querySelectorAll('.tag-pill');
          if (pills.length) {
            pills[pills.length - 1].remove();
            syncTagsHidden();
          }
        }
      });
    }

    if (tagsWrapper) {
      tagsWrapper.addEventListener('click', function (e) {
        var remove = e.target.closest('.tag-pill-remove');
        if (remove) {
          remove.closest('.tag-pill').remove();
          syncTagsHidden();
          if (tagsInput) tagsInput.focus();
        } else if (tagsInput && e.target === tagsWrapper) {
          tagsInput.focus();
        }
      });

      // Build pills from the server-provided comma-separated value.
      if (tagsHidden && tagsHidden.value) {
        var initial = tagsHidden.value.split(',');
        for (var t = 0; t < initial.length; t++) addTag(initial[t]);
      }
      syncTagsHidden();
    }

    // ---- Image upload zone -----------------------------------

    function sanitizeFilename(name) {
      var lower = name.toLowerCase();
      var dot = lower.lastIndexOf('.');
      if (dot < 1) return null;
      var ext = lower.slice(dot + 1);
      if (!Object.prototype.hasOwnProperty.call(IMAGE_TYPES, ext)) return null;
      var base = lower
        .slice(0, dot)
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-_]+/, '')
        .slice(0, 64)
        .replace(/[-_]+$/, '');
      var clean = base + '.' + ext;
      return FILENAME_RE.test(clean) ? clean : null;
    }

    function setZone(state, title, sub, hint) {
      var titleEl = document.getElementById('image-upload-title');
      var subEl = document.getElementById('image-upload-sub');
      var hintEl = document.getElementById('image-upload-hint');
      var status = document.getElementById('image-upload-status');
      imageZone.classList.toggle('is-error', state === 'error');
      imageZone.classList.toggle('is-success', state === 'success');
      if (titleEl) titleEl.textContent = title;
      if (subEl) subEl.textContent = sub;
      if (hintEl && hint) hintEl.textContent = hint;
      if (status) {
        status.textContent = title + ' ' + sub;
        status.classList.toggle('is-error', state === 'error');
      }
    }

    function uploadFile(file) {
      if (!file) return;

      var filename = sanitizeFilename(file.name);
      var typeOk = !file.type || /^image\/(jpeg|png|webp|gif)$/.test(file.type);
      if (!filename || !typeOk) {
        setZone('error', 'Unsupported file.', 'Use a JPG, PNG, GIF or WebP image.');
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setZone('error', 'File too large.', 'Images must be 10 MB or smaller.');
        return;
      }

      var slug = slugInput && slugInput.value ? slugInput.value : 'unnamed';
      if (!SLUG_RE.test(slug)) {
        setZone('error', 'Invalid slug.', 'Fix the post slug before uploading an image.');
        return;
      }

      var ext = filename.slice(filename.lastIndexOf('.') + 1);
      var url = '/admin/images?slug=' + encodeURIComponent(slug) +
                '&filename=' + encodeURIComponent(filename);

      setZone('busy', 'Uploading…', filename);

      request(url, {
        method: 'POST',
        headers: { 'Content-Type': file.type || IMAGE_TYPES[ext] },
        body: file,
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data || typeof data.url !== 'string' || data.url.charAt(0) !== '/') {
            throw new Error('Unexpected response from server');
          }
          if (imageField) imageField.value = data.url;
          setZone('success', filename, (file.size / 1024).toFixed(0) + ' KB — click to replace');
        })
        .catch(function (err) {
          setZone('error', 'Upload failed.', err.message || 'Try again.');
        });
    }

    if (imageZone) {
      var filePicker = document.createElement('input');
      filePicker.type = 'file';
      filePicker.accept = 'image/jpeg,image/png,image/webp,image/gif';
      filePicker.hidden = true;
      filePicker.addEventListener('change', function () {
        if (filePicker.files.length) uploadFile(filePicker.files[0]);
        filePicker.value = '';
      });
      imageZone.appendChild(filePicker);

      imageZone.addEventListener('dragover', function (e) {
        e.preventDefault();
        imageZone.classList.add('dragover');
      });

      imageZone.addEventListener('dragleave', function () {
        imageZone.classList.remove('dragover');
      });

      imageZone.addEventListener('drop', function (e) {
        e.preventDefault();
        imageZone.classList.remove('dragover');
        uploadFile(e.dataTransfer.files[0]);
      });

      imageZone.addEventListener('click', function (e) {
        if (e.target === filePicker) return;
        filePicker.click();
      });

      imageZone.addEventListener('keydown', function (e) {
        if (e.target !== imageZone) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          filePicker.click();
        }
      });
    }

    // ---- Markdown preview ------------------------------------

    function safeUrl(url) {
      var scheme = url.match(/^([a-z][a-z0-9+.\-]*):/i);
      if (scheme) {
        return /^(https?|mailto)$/i.test(scheme[1]) ? url : '#';
      }
      return url.slice(0, 2) === '//' ? '#' : url;
    }

    function applyInline(text) {
      // Bold **text**
      text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // Italic *text*
      text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      // Inline code `text`
      text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
      return text;
    }

    // The source is HTML-escaped first, so raw HTML typed into a post can
    // never reach the DOM; only the tags generated below are live.
    function markdownToHtml(md) {
      var html = escapeHtml(md);

      // Fenced code blocks (``` ... ```) — content is already escaped
      html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
        return '<pre><code>' + code.trimEnd() + '</code></pre>';
      });

      // Images ![alt](src) — before links so we don't double-match
      html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, alt, src) {
        return '<img src="' + safeUrl(src) + '" alt="' + alt + '">';
      });

      // Links [text](url) — only those not preceded by !
      html = html.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, text, href) {
        return '<a href="' + safeUrl(href) + '" rel="noopener noreferrer">' + text + '</a>';
      });

      // Process line by line for block elements
      var lines = html.split('\n');
      var result = [];
      var inList = false;

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];

        // Skip lines inside <pre> blocks
        if (line.indexOf('<pre>') !== -1) {
          var preBlock = line;
          while (i < lines.length - 1 && lines[i].indexOf('</pre>') === -1) {
            i++;
            preBlock += '\n' + lines[i];
          }
          result.push(preBlock);
          continue;
        }

        // Headings (check longest prefix first)
        if (/^### /.test(line)) {
          if (inList) { result.push('</ul>'); inList = false; }
          result.push('<h3>' + applyInline(line.replace(/^### /, '')) + '</h3>');
          continue;
        }
        if (/^## /.test(line)) {
          if (inList) { result.push('</ul>'); inList = false; }
          result.push('<h2>' + applyInline(line.replace(/^## /, '')) + '</h2>');
          continue;
        }
        if (/^# /.test(line)) {
          if (inList) { result.push('</ul>'); inList = false; }
          result.push('<h1>' + applyInline(line.replace(/^# /, '')) + '</h1>');
          continue;
        }

        // Unordered list items
        if (/^- /.test(line)) {
          if (!inList) { result.push('<ul>'); inList = true; }
          result.push('<li>' + applyInline(line.replace(/^- /, '')) + '</li>');
          continue;
        } else if (inList) {
          result.push('</ul>');
          inList = false;
        }

        // Empty line — skip
        if (line.trim() === '') continue;

        // Paragraph
        result.push('<p>' + applyInline(line) + '</p>');
      }

      if (inList) result.push('</ul>');
      return result.join('\n');
    }

    function updatePreview() {
      if (!editor || !preview) return;
      preview.innerHTML = markdownToHtml(editor.value);
    }

    // ---- Line numbers ----------------------------------------

    function updateLineNumbers() {
      if (!editor || !lineNumbers) return;
      var count = editor.value.split('\n').length;
      var frag = document.createDocumentFragment();
      for (var i = 1; i <= count; i++) {
        var row = document.createElement('div');
        row.textContent = String(i);
        frag.appendChild(row);
      }
      lineNumbers.replaceChildren(frag);
    }

    if (editor) {
      editor.addEventListener('input', function () {
        updatePreview();
        updateLineNumbers();
      });

      // Sync scroll between line numbers and editor
      editor.addEventListener('scroll', function () {
        if (lineNumbers) {
          lineNumbers.style.transform = 'translateY(-' + editor.scrollTop + 'px)';
        }
      });
    }

    // ---- Pane divider (drag + keyboard resize) ---------------

    if (divider && panes) {
      var isDragging = false;

      function setSplit(pct) {
        if (pct <= 20 || pct >= 80) return;
        panes.style.gridTemplateColumns = pct + '% 1px ' + (100 - pct) + '%';
        divider.setAttribute('aria-valuenow', String(Math.round(pct)));
      }

      divider.addEventListener('mousedown', function (e) {
        isDragging = true;
        divider.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', function (e) {
        if (!isDragging) return;
        var rect = panes.getBoundingClientRect();
        setSplit(((e.clientX - rect.left) / rect.width) * 100);
      });

      document.addEventListener('mouseup', function () {
        if (isDragging) {
          isDragging = false;
          divider.classList.remove('active');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });

      divider.addEventListener('keydown', function (e) {
        var current = Number(divider.getAttribute('aria-valuenow')) || 50;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setSplit(current - 2);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          setSplit(current + 2);
        }
      });
    }

    // ---- Delete post -----------------------------------------

    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        var slug = deleteBtn.getAttribute('data-slug');
        if (!slug) return;
        if (!window.confirm('Delete this post? This cannot be undone.')) return;

        showError(editorError, '');
        deleteBtn.disabled = true;

        request('/admin/posts/' + encodeURIComponent(slug), { method: 'DELETE' })
          .then(function (res) {
            var next = '/admin';
            if (res.redirected && res.url.indexOf(window.location.origin + '/admin') === 0) {
              next = res.url;
            }
            window.location.assign(next);
          })
          .catch(function (err) {
            deleteBtn.disabled = false;
            showError(editorError, 'Delete failed: ' + err.message);
            if (editorError) editorError.scrollIntoView({ block: 'nearest' });
          });
      });
    }

    // ---- Initial render --------------------------------------
    updatePreview();
    updateLineNumbers();
  }

  // ===========================================================
  // Dashboard page
  // ===========================================================

  function initDashboard() {
    var searchInput = document.getElementById('search-input');
    var statusFilter = document.getElementById('status-filter');
    var table = document.getElementById('posts-table');
    var tbody = document.getElementById('posts-tbody');
    var emptyState = document.getElementById('empty-state');
    var tableFooter = document.getElementById('table-footer');
    var rowCount = document.getElementById('row-count');

    if (!table || !tbody) return;

    // ---- Sort state ------------------------------------------

    var sortField = 'date';
    var sortDir = 'desc';

    // ---- Search / status filter ------------------------------

    function filterAndRender() {
      var search = searchInput ? searchInput.value.toLowerCase() : '';
      var filter = statusFilter ? statusFilter.value : 'all';

      var rows = tbody.querySelectorAll('tr');
      var visibleCount = 0;
      var totalCount = rows.length;

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var title = (row.getAttribute('data-title') || '').toLowerCase();
        var status = (row.getAttribute('data-status') || '').toLowerCase();

        var matchSearch = !search || title.indexOf(search) !== -1;
        var matchFilter = filter === 'all' || status === filter;

        row.hidden = !(matchSearch && matchFilter);
        if (!row.hidden) visibleCount++;
      }

      if (emptyState) emptyState.hidden = visibleCount !== 0;
      if (tableFooter) tableFooter.hidden = visibleCount === 0;
      if (rowCount) {
        rowCount.textContent = 'Showing ' + visibleCount + ' of ' + totalCount + ' posts';
      }
    }

    if (searchInput) searchInput.addEventListener('input', filterAndRender);
    if (statusFilter) statusFilter.addEventListener('change', filterAndRender);

    // ---- Column sorting --------------------------------------

    function sortTable(field) {
      if (sortField === field) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortField = field;
        sortDir = field === 'date' ? 'desc' : 'asc';
      }

      var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
      rows.sort(function (a, b) {
        var valA = (a.getAttribute('data-' + field) || '').toLowerCase();
        var valB = (b.getAttribute('data-' + field) || '').toLowerCase();
        if (valA < valB) return sortDir === 'asc' ? -1 : 1;
        if (valA > valB) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });

      for (var i = 0; i < rows.length; i++) {
        tbody.appendChild(rows[i]);
      }

      var headers = table.querySelectorAll('th.sortable');
      for (var j = 0; j < headers.length; j++) {
        var th = headers[j];
        var icon = th.querySelector('.sort-icon');
        if (th.getAttribute('data-sort') === field) {
          th.classList.add('sort-active');
          th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
          if (icon) icon.textContent = sortDir === 'asc' ? '▲' : '▼';
        } else {
          th.classList.remove('sort-active');
          th.setAttribute('aria-sort', 'none');
          if (icon) icon.textContent = '▲▼';
        }
      }
    }

    var sortableHeaders = table.querySelectorAll('th.sortable');
    for (var i = 0; i < sortableHeaders.length; i++) {
      (function (th) {
        var btn = th.querySelector('.sort-btn');
        if (btn) {
          btn.addEventListener('click', function () {
            sortTable(th.getAttribute('data-sort'));
          });
        }
      })(sortableHeaders[i]);
    }

    // ---- Delete confirm --------------------------------------

    table.addEventListener('click', function (e) {
      var deleteBtn = e.target.closest('.action-btn-delete');
      if (!deleteBtn) return;

      e.preventDefault();

      var row = deleteBtn.closest('tr');
      if (!row) return;

      var title = row.getAttribute('data-title') || 'this post';
      var slug = row.getAttribute('data-slug') || '';

      var confirmed = window.confirm(
        'Delete "' + title + '"?\n\n' +
        'This will remove the post and purge it from the edge cache. ' +
        'This action cannot be undone.'
      );

      if (!confirmed) return;

      // Prefer the row's form (works without further JS); otherwise DELETE via fetch
      var deleteForm = row.querySelector('form[data-action="delete"]');
      if (deleteForm) {
        deleteForm.submit();
        return;
      }

      if (slug) {
        request('/admin/posts/' + encodeURIComponent(slug), { method: 'DELETE' })
          .then(function () {
            row.remove();
            filterAndRender();
          })
          .catch(function (err) {
            window.alert('Delete failed (' + err.message + '). Try again.');
          });
      }
    });

    // Initial filter pass (in case the page loads with filters pre-set)
    filterAndRender();

    // Edge stats: TTFB from Navigation Timing, POP from /api/edge-info
    var entries = performance.getEntriesByType('navigation');
    if (entries.length) {
      var ttfb = document.getElementById('admin-edge-ttfb');
      if (ttfb) ttfb.textContent = Math.round(entries[0].responseStart) + 'ms';
    }
    fetchEdgeInfoPop()
      .then(function (pop) {
        var el = document.getElementById('admin-edge-pop');
        if (el) el.textContent = pop;
      })
      .catch(function () {});
  }

  // ===========================================================
  // Sidebar editor page
  // ===========================================================

  var ICON_CATEGORY = [['path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }]];
  var ICON_LINK = [
    ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
    ['polyline', { points: '15 3 21 3 21 9' }],
    ['line', { x1: '10', y1: '14', x2: '21', y2: '3' }],
  ];
  var ICON_EDIT = [
    ['path', { d: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }],
    ['path', { d: 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z' }],
  ];
  var ICON_TRASH = [
    ['polyline', { points: '3 6 5 6 21 6' }],
    ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ['line', { x1: '10', y1: '11', x2: '10', y2: '17' }],
    ['line', { x1: '14', y1: '11', x2: '14', y2: '17' }],
  ];

  function initSidebarEditor() {
    var itemsList = document.getElementById('sidebar-items');
    var addCategoryBtn = document.getElementById('add-category-btn');
    var addLinkBtn = document.getElementById('add-link-btn');
    var saveBtn = document.getElementById('save-sidebar-btn');
    var errorEl = document.getElementById('sidebar-error');
    var statusEl = document.getElementById('sidebar-status');

    var catLabel = document.getElementById('new-cat-label');
    var catSlug = document.getElementById('new-cat-slug');
    var catChildren = document.getElementById('new-cat-children');
    var linkLabel = document.getElementById('new-link-label');
    var linkUrl = document.getElementById('new-link-url');
    var linkIcon = document.getElementById('new-link-icon');

    // The <li> currently loaded into an add-form for editing (replaced in place)
    var editing = null;

    function setStatus(message) {
      if (statusEl) statusEl.textContent = message || '';
    }

    function itemCount() {
      return itemsList ? itemsList.querySelectorAll('.sidebar-preview-item').length : 0;
    }

    function actionButton(kind, label) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-btn ' + (kind === 'edit' ? 'action-btn-edit' : 'action-btn-delete');
      btn.title = kind === 'edit' ? 'Edit item' : 'Remove item';
      btn.setAttribute('aria-label', (kind === 'edit' ? 'Edit ' : 'Remove ') + label);
      btn.setAttribute('data-action', kind);
      btn.appendChild(svgIcon(kind === 'edit' ? ICON_EDIT : ICON_TRASH));
      return btn;
    }

    // Build a list item for `item` ({type,label,slug,children[],url,icon}).
    // All user data goes through textContent / setAttribute.
    function buildItem(item) {
      var isCategory = item.type === 'category';
      var li = document.createElement('li');
      li.className = 'sidebar-preview-item';
      li.setAttribute('data-type', item.type);
      li.setAttribute('data-label', item.label);
      li.setAttribute('data-slug', item.slug || '');
      li.setAttribute('data-children', (item.children || []).join(','));
      li.setAttribute('data-url', item.url || '');
      li.setAttribute('data-icon', item.icon || '');

      var icon = document.createElement('div');
      icon.className = 'sidebar-preview-icon ' + (isCategory ? 'sidebar-preview-icon-cat' : 'sidebar-preview-icon-link');
      icon.appendChild(svgIcon(isCategory ? ICON_CATEGORY : ICON_LINK));

      var label = document.createElement('span');
      label.className = 'sidebar-preview-label';
      label.textContent = item.label;

      var detail = document.createElement('span');
      detail.className = 'sidebar-preview-detail';
      detail.textContent = isCategory ? 'category' : 'link · ' + item.url;

      var actions = document.createElement('div');
      actions.className = 'action-icons ml-auto';
      actions.appendChild(actionButton('edit', item.label));
      actions.appendChild(actionButton('remove', item.label));

      li.appendChild(icon);
      li.appendChild(label);
      li.appendChild(detail);
      li.appendChild(actions);
      return li;
    }

    function placeItem(li) {
      if (editing) {
        editing.replaceWith(li);
      } else if (itemsList) {
        itemsList.appendChild(li);
      }
    }

    function resetForms() {
      editing = null;
      if (catLabel) catLabel.value = '';
      if (catSlug) catSlug.value = '';
      if (catChildren) catChildren.value = '';
      if (linkLabel) linkLabel.value = '';
      if (linkUrl) linkUrl.value = '';
      if (linkIcon) linkIcon.value = '';
      setButtonLabel(addCategoryBtn, 'Add Category');
      setButtonLabel(addLinkBtn, 'Add Link');
    }

    function setButtonLabel(btn, text) {
      var span = btn && btn.querySelector('.btn-label');
      if (span) span.textContent = text;
    }

    // ---- Collect current sidebar state as JSON ---------------

    function serializeSidebar() {
      var items = [];
      var lis = itemsList ? itemsList.querySelectorAll('.sidebar-preview-item') : [];
      for (var i = 0; i < lis.length; i++) {
        var li = lis[i];
        var label = li.getAttribute('data-label') || '';

        if (li.getAttribute('data-type') === 'category') {
          var csv = li.getAttribute('data-children') || '';
          var children = csv
            .split(',')
            .map(function (s) { return s.trim(); })
            .filter(Boolean);
          items.push({
            type: 'category',
            label: label,
            // Existing slugs are preserved; only brand-new items derive one.
            slug: li.getAttribute('data-slug') || slugify(label),
            children: children,
          });
        } else {
          var item = {
            type: 'link',
            label: label,
            url: li.getAttribute('data-url') || '',
          };
          var icon = li.getAttribute('data-icon');
          if (icon) item.icon = icon;
          items.push(item);
        }
      }
      return items;
    }

    // ---- Edit / remove item ----------------------------------

    if (itemsList) {
      itemsList.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var li = btn.closest('.sidebar-preview-item');
        if (!li) return;

        var label = li.getAttribute('data-label') || '';

        if (btn.getAttribute('data-action') === 'remove') {
          if (window.confirm('Remove "' + label + '" from the sidebar?')) {
            if (editing === li) resetForms();
            li.remove();
            setStatus('Removed ' + label + '. Save to apply.');
          }
          return;
        }

        // edit: load the item into the matching form; submitting replaces it
        resetForms();
        editing = li;
        if (li.getAttribute('data-type') === 'category') {
          if (catLabel) catLabel.value = label;
          if (catSlug) catSlug.value = li.getAttribute('data-slug') || '';
          if (catChildren) catChildren.value = li.getAttribute('data-children') || '';
          setButtonLabel(addCategoryBtn, 'Update Category');
          if (catLabel) catLabel.focus();
        } else {
          if (linkLabel) linkLabel.value = label;
          if (linkUrl) linkUrl.value = li.getAttribute('data-url') || '';
          if (linkIcon) linkIcon.value = li.getAttribute('data-icon') || '';
          setButtonLabel(addLinkBtn, 'Update Link');
          if (linkLabel) linkLabel.focus();
        }
      });
    }

    // ---- Add / update category -------------------------------

    if (addCategoryBtn) {
      addCategoryBtn.addEventListener('click', function () {
        var label = catLabel ? catLabel.value.trim() : '';
        var slug = catSlug ? catSlug.value.trim() : '';
        var rawChildren = catChildren ? catChildren.value : '';

        if (!label || label.length > 100) {
          showError(errorEl, 'Enter a category label (1–100 characters).');
          return;
        }
        if (!slug) slug = slugify(label);
        if (!SLUG_RE.test(slug)) {
          showError(errorEl, 'Category slug may only contain lowercase letters, numbers and hyphens.');
          return;
        }

        var children = [];
        var parts = rawChildren.split(',');
        for (var i = 0; i < parts.length; i++) {
          var child = parts[i].trim();
          if (!child) continue;
          if (!SLUG_RE.test(child)) {
            showError(errorEl, '"' + child + '" is not a valid post slug.');
            return;
          }
          if (children.indexOf(child) === -1) children.push(child);
        }

        if (!editing && itemCount() >= MAX_SIDEBAR_ITEMS) {
          showError(errorEl, 'A sidebar can have at most ' + MAX_SIDEBAR_ITEMS + ' items.');
          return;
        }

        showError(errorEl, '');
        placeItem(buildItem({ type: 'category', label: label, slug: slug, children: children }));
        setStatus((editing ? 'Updated ' : 'Added ') + label + '. Save to apply.');
        resetForms();
      });
    }

    // ---- Add / update link -----------------------------------

    if (addLinkBtn) {
      addLinkBtn.addEventListener('click', function () {
        var label = linkLabel ? linkLabel.value.trim() : '';
        var url = linkUrl ? linkUrl.value.trim() : '';
        var icon = linkIcon ? linkIcon.value : '';

        if (!label || label.length > 100) {
          showError(errorEl, 'Enter a link label (1–100 characters).');
          return;
        }
        if (!isValidSidebarUrl(url)) {
          showError(errorEl, 'URL must start with https://, http:// or a single "/".');
          if (linkUrl) linkUrl.focus();
          return;
        }
        if (icon && !ICON_RE.test(icon)) icon = '';

        if (!editing && itemCount() >= MAX_SIDEBAR_ITEMS) {
          showError(errorEl, 'A sidebar can have at most ' + MAX_SIDEBAR_ITEMS + ' items.');
          return;
        }

        showError(errorEl, '');
        placeItem(buildItem({ type: 'link', label: label, url: url, icon: icon }));
        setStatus((editing ? 'Updated ' : 'Added ') + label + '. Save to apply.');
        resetForms();
      });
    }

    // ---- Save sidebar ----------------------------------------

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var items = serializeSidebar();

        for (var i = 0; i < items.length; i++) {
          if (items[i].type === 'link' && !isValidSidebarUrl(items[i].url)) {
            showError(errorEl, 'Link "' + items[i].label + '" has an invalid URL; edit or remove it before saving.');
            return;
          }
        }

        showError(errorEl, '');
        saveBtn.disabled = true;
        setButtonLabel(saveBtn, 'Saving…');

        request('/admin/sidebar', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: items }),
        })
          .then(function () {
            setButtonLabel(saveBtn, 'Saved!');
            setStatus('Sidebar saved.');
            setTimeout(function () {
              saveBtn.disabled = false;
              setButtonLabel(saveBtn, 'Save Sidebar');
            }, 1500);
          })
          .catch(function (err) {
            saveBtn.disabled = false;
            setButtonLabel(saveBtn, 'Save Sidebar');
            showError(errorEl, 'Failed to save sidebar: ' + err.message);
          });
      });
    }
  }

  // ===========================================================
  // Page detection & init
  // ===========================================================

  // Editor page: detected by the markdown editor pane
  if (document.querySelector('.editor-pane')) initEditor();

  // Dashboard page: detected by the posts table
  if (document.querySelector('.posts-table')) initDashboard();

  // Sidebar editor page: detected by the sidebar items list
  if (document.getElementById('sidebar-items')) initSidebarEditor();
})();

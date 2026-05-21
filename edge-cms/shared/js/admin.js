/**
 * edge/cms — Admin JavaScript
 *
 * Single file covering all admin interactivity. Auto-detects which page
 * is loaded and initializes the relevant module. No framework dependencies.
 *
 * Pages handled:
 *   - Editor     (.editor-pane present)
 *   - Dashboard  (.posts-table present)
 *   - Sidebar    (#sidebar-items present)
 */
(function () {
  'use strict';

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
      .replace(/^-|-$/g, '');
  }

  /**
   * Format an ISO date string (YYYY-MM-DD) for display.
   */
  function formatDate(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
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
    var editor = document.getElementById('markdown-editor');
    var preview = document.getElementById('preview-content');
    var lineNumbers = document.getElementById('line-numbers');
    var divider = document.getElementById('pane-divider');
    var panes = document.querySelector('.editor-panes');

    // ---- Slug auto-generation --------------------------------

    var slugManuallyEdited = false;

    if (slugInput) {
      slugInput.addEventListener('input', function () {
        slugManuallyEdited = true;
      });
    }

    if (titleInput && slugInput) {
      titleInput.addEventListener('keyup', function () {
        if (slugManuallyEdited) return;
        slugInput.value = slugify(titleInput.value);
      });
    }

    // ---- Tag input -------------------------------------------

    function syncTagsHidden() {
      if (!tagsHidden) return;
      var pills = tagsWrapper.querySelectorAll('.tag-pill');
      var values = [];
      for (var i = 0; i < pills.length; i++) {
        var text = pills[i].textContent.replace('×', '').trim();
        if (text) values.push(text);
      }
      tagsHidden.value = values.join(',');
    }

    function addTag(text) {
      text = text.trim().toLowerCase();
      if (!text || !tagsWrapper) return;

      // Prevent duplicates
      var existing = tagsWrapper.querySelectorAll('.tag-pill');
      for (var i = 0; i < existing.length; i++) {
        var pillText = existing[i].textContent.replace('×', '').trim().toLowerCase();
        if (pillText === text) return;
      }

      var pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.innerHTML =
        text +
        ' <span class="tag-pill-remove" data-tag="' +
        text.replace(/"/g, '&quot;') +
        '">&times;</span>';
      tagsWrapper.insertBefore(pill, tagsInput);
      syncTagsHidden();
    }

    if (tagsInput) {
      tagsInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
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
        if (e.target.classList.contains('tag-pill-remove')) {
          e.target.closest('.tag-pill').remove();
          syncTagsHidden();
        } else if (tagsInput) {
          tagsInput.focus();
        }
      });

      // Sync hidden input on initial load
      syncTagsHidden();
    }

    // ---- Image upload zone -----------------------------------

    if (imageZone) {
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

        var file = e.dataTransfer.files[0];
        if (!file) return;

        var slug = (slugInput && slugInput.value) ? slugInput.value : 'unnamed';
        var url = '/admin/images?slug=' + encodeURIComponent(slug) +
                  '&filename=' + encodeURIComponent(file.name);

        // Show uploading state
        imageZone.innerHTML =
          '<div class="image-upload-text"><strong>Uploading...</strong></div>' +
          '<div class="image-upload-hint">' + file.name + '</div>';

        fetch(url, { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
          .then(function (res) {
            if (!res.ok) throw new Error('Upload failed: ' + res.status);
            return res.json();
          })
          .then(function (data) {
            // Show success state
            imageZone.innerHTML =
              '<svg class="image-upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
              'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent);">' +
              '<polyline points="20 6 9 17 4 12"/></svg>' +
              '<div class="image-upload-text"><strong>' + (data.filename || file.name) + '</strong></div>' +
              '<div class="image-upload-hint">' +
              (file.size / 1024).toFixed(0) + ' KB &mdash; Click to replace</div>';

            // Insert markdown image at cursor in the editor textarea
            if (editor && data.url) {
              var cursorPos = editor.selectionStart;
              var before = editor.value.substring(0, cursorPos);
              var after = editor.value.substring(cursorPos);
              var imgMd = '![' + (data.alt || file.name) + '](' + data.url + ')';
              editor.value = before + imgMd + after;
              editor.selectionStart = editor.selectionEnd = cursorPos + imgMd.length;
              editor.dispatchEvent(new Event('input'));
            }
          })
          .catch(function () {
            imageZone.innerHTML =
              '<div class="image-upload-text" style="color:var(--terracotta);"><strong>Upload failed</strong></div>' +
              '<div class="image-upload-hint">Try again or check the server logs.</div>';
          });
      });

      // Click to open file picker
      imageZone.addEventListener('click', function () {
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp';
        fileInput.addEventListener('change', function () {
          if (fileInput.files.length) {
            // Reuse the drop handler logic by building a synthetic event
            var dt = new DataTransfer();
            dt.items.add(fileInput.files[0]);
            var dropEvent = new DragEvent('drop', { dataTransfer: dt });
            imageZone.dispatchEvent(dropEvent);
          }
        });
        fileInput.click();
      });
    }

    // ---- Markdown preview ------------------------------------

    function applyInline(text) {
      // Bold **text**
      text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // Italic *text*
      text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      // Inline code `text`
      text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
      return text;
    }

    function markdownToHtml(md) {
      var html = md;

      // Fenced code blocks (``` ... ```)
      html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
        var escaped = code
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return '<pre><code>' + escaped.trimEnd() + '</code></pre>';
      });

      // Images ![alt](src) — before links so we don't double-match
      html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

      // Links [text](url) — only those not preceded by !
      html = html.replace(
        /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" style="color:var(--accent);text-decoration:underline;">$1</a>'
      );

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
      var html = '';
      for (var i = 1; i <= count; i++) {
        html += '<div>' + i + '</div>';
      }
      lineNumbers.innerHTML = html;
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

    // ---- Pane divider drag (resize) --------------------------

    if (divider && panes) {
      var isDragging = false;

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
        var offset = e.clientX - rect.left;
        var pct = (offset / rect.width) * 100;
        if (pct > 20 && pct < 80) {
          panes.style.gridTemplateColumns = pct + '% 1px ' + (100 - pct) + '%';
        }
      });

      document.addEventListener('mouseup', function () {
        if (isDragging) {
          isDragging = false;
          divider.classList.remove('active');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
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

    // ---- Search filter (keyup) -------------------------------

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

        if (matchSearch && matchFilter) {
          row.style.display = '';
          visibleCount++;
        } else {
          row.style.display = 'none';
        }
      }

      // Toggle empty state
      if (emptyState) {
        emptyState.style.display = visibleCount === 0 ? 'block' : 'none';
      }
      if (tableFooter) {
        tableFooter.style.display = visibleCount === 0 ? 'none' : 'flex';
      }
      if (rowCount) {
        rowCount.textContent =
          'Showing ' + visibleCount + ' of ' + totalCount + ' posts';
      }
    }

    if (searchInput) {
      searchInput.addEventListener('keyup', filterAndRender);
      searchInput.addEventListener('input', filterAndRender);
    }
    if (statusFilter) {
      statusFilter.addEventListener('change', filterAndRender);
    }

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

      // Re-append rows in sorted order
      for (var i = 0; i < rows.length; i++) {
        tbody.appendChild(rows[i]);
      }

      // Update header visuals
      var headers = table.querySelectorAll('th.sortable');
      for (var j = 0; j < headers.length; j++) {
        var th = headers[j];
        var icon = th.querySelector('.sort-icon');
        if (th.getAttribute('data-sort') === field) {
          th.classList.add('sort-active');
          if (icon) icon.innerHTML = sortDir === 'asc' ? '&#9650;' : '&#9660;';
        } else {
          th.classList.remove('sort-active');
          if (icon) icon.innerHTML = '&#9650;&#9660;';
        }
      }
    }

    var sortableHeaders = table.querySelectorAll('th.sortable');
    for (var i = 0; i < sortableHeaders.length; i++) {
      (function (th) {
        th.addEventListener('click', function () {
          sortTable(th.getAttribute('data-sort'));
        });
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

      // Look for a delete form inside the row, or build a fetch request
      var deleteForm = row.querySelector('form[data-action="delete"]');
      if (deleteForm) {
        deleteForm.submit();
        return;
      }

      // Fallback: send DELETE via fetch and remove the row on success
      if (slug) {
        fetch('/admin/posts/' + encodeURIComponent(slug), { method: 'DELETE' })
          .then(function (res) {
            if (res.ok) {
              row.remove();
              filterAndRender();
            } else {
              window.alert('Delete failed (HTTP ' + res.status + '). Try again.');
            }
          })
          .catch(function () {
            window.alert('Delete failed. Check your connection and try again.');
          });
      }
    });

    // Initial filter pass (in case the page loads with filters pre-set)
    filterAndRender();
  }

  // ===========================================================
  // Sidebar editor page
  // ===========================================================

  function initSidebarEditor() {
    var itemsList = document.getElementById('sidebar-items');
    var addCategoryBtn = document.getElementById('add-category-btn');
    var addLinkBtn = document.getElementById('add-link-btn');
    var saveBtn = document.getElementById('save-sidebar-btn');

    // ---- Collect current sidebar state as JSON ---------------

    function serializeSidebar() {
      var items = [];
      var lis = itemsList ? itemsList.querySelectorAll('.sidebar-preview-item') : [];
      for (var i = 0; i < lis.length; i++) {
        var li = lis[i];
        var label = '';
        var labelEl = li.querySelector('.sidebar-preview-label');
        if (labelEl) label = labelEl.textContent.trim();

        var detail = '';
        var detailEl = li.querySelector('.sidebar-preview-detail');
        if (detailEl) detail = detailEl.textContent.trim();

        var isCategory = !!li.querySelector('.sidebar-preview-icon-cat');

        if (isCategory) {
          // Parse children from data attribute if present
          var childrenAttr = li.getAttribute('data-children');
          var children = childrenAttr ? childrenAttr.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
          items.push({
            type: 'category',
            label: label,
            slug: slugify(label),
            children: children,
          });
        } else {
          var urlAttr = li.getAttribute('data-url') || '';
          items.push({
            type: 'link',
            label: label,
            url: urlAttr,
            icon: li.getAttribute('data-icon') || '',
          });
        }
      }
      return items;
    }

    // ---- Remove item -----------------------------------------

    if (itemsList) {
      itemsList.addEventListener('click', function (e) {
        var removeBtn = e.target.closest('[data-action="remove"]');
        if (!removeBtn) return;

        var li = removeBtn.closest('.sidebar-preview-item');
        if (!li) return;

        var label = '';
        var labelEl = li.querySelector('.sidebar-preview-label');
        if (labelEl) label = labelEl.textContent.trim();

        if (window.confirm('Remove "' + label + '" from the sidebar?')) {
          li.remove();
        }
      });
    }

    // ---- Add category ----------------------------------------

    if (addCategoryBtn) {
      addCategoryBtn.addEventListener('click', function () {
        var labelInput = document.getElementById('new-cat-label');
        var slugInputEl = document.getElementById('new-cat-slug');
        var childrenInput = document.getElementById('new-cat-children');

        var label = labelInput ? labelInput.value.trim() : '';
        var slug = slugInputEl ? slugInputEl.value.trim() : '';
        var children = childrenInput ? childrenInput.value.trim() : '';

        if (!label) {
          window.alert('Please enter a category label.');
          return;
        }

        if (!slug) slug = slugify(label);

        var li = document.createElement('li');
        li.className = 'sidebar-preview-item';
        li.setAttribute('data-children', children);
        li.innerHTML =
          '<div class="sidebar-preview-icon sidebar-preview-icon-cat">' +
            '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' +
          '</div>' +
          '<span class="sidebar-preview-label">' + label + '</span>' +
          '<span class="sidebar-preview-detail">category</span>' +
          '<div class="action-icons" style="margin-left:auto;">' +
            '<button type="button" class="action-btn action-btn-delete" title="Remove item" data-action="remove">' +
              '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/>' +
              '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
              '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
            '</button>' +
          '</div>';

        if (itemsList) itemsList.appendChild(li);

        // Clear the form
        if (labelInput) labelInput.value = '';
        if (slugInputEl) slugInputEl.value = '';
        if (childrenInput) childrenInput.value = '';
      });
    }

    // ---- Add link --------------------------------------------

    if (addLinkBtn) {
      addLinkBtn.addEventListener('click', function () {
        var labelInput = document.getElementById('new-link-label');
        var urlInput = document.getElementById('new-link-url');
        var iconSelect = document.getElementById('new-link-icon');

        var label = labelInput ? labelInput.value.trim() : '';
        var url = urlInput ? urlInput.value.trim() : '';
        var icon = iconSelect ? iconSelect.value : '';

        if (!label || !url) {
          window.alert('Please enter both a label and a URL.');
          return;
        }

        var li = document.createElement('li');
        li.className = 'sidebar-preview-item';
        li.setAttribute('data-url', url);
        if (icon) li.setAttribute('data-icon', icon);
        li.innerHTML =
          '<div class="sidebar-preview-icon sidebar-preview-icon-link">' +
            '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>' +
            '<polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
          '</div>' +
          '<span class="sidebar-preview-label">' + label + '</span>' +
          '<span class="sidebar-preview-detail">link &middot; ' + url + '</span>' +
          '<div class="action-icons" style="margin-left:auto;">' +
            '<button type="button" class="action-btn action-btn-delete" title="Remove item" data-action="remove">' +
              '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/>' +
              '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
              '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
            '</button>' +
          '</div>';

        if (itemsList) itemsList.appendChild(li);

        // Clear the form
        if (labelInput) labelInput.value = '';
        if (urlInput) urlInput.value = '';
        if (iconSelect) iconSelect.value = '';
      });
    }

    // ---- Save sidebar ----------------------------------------

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var data = serializeSidebar();

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        fetch('/admin/sidebar', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: data }),
        })
          .then(function (res) {
            if (!res.ok) throw new Error('Save failed: ' + res.status);
            saveBtn.textContent = 'Saved!';
            setTimeout(function () {
              saveBtn.disabled = false;
              saveBtn.innerHTML =
                '<svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>' +
                '<polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Sidebar';
            }, 1500);
          })
          .catch(function () {
            saveBtn.disabled = false;
            saveBtn.innerHTML =
              '<svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>' +
              '<polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Sidebar';
            window.alert('Failed to save sidebar. Try again.');
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

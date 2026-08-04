(function () {
  'use strict';

  var parser = null;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function markdownParser() {
    if (parser) return parser;
    if (!window.marked || !window.marked.Marked || !window.marked.Renderer) return null;

    var renderer = new window.marked.Renderer();
    renderer.html = function (token) {
      var source = token && typeof token === 'object'
        ? (token.text != null ? token.text : token.raw)
        : token;
      return escapeHtml(source);
    };

    parser = new window.marked.Marked({
      async: false,
      breaks: true,
      gfm: true,
      renderer: renderer
    });
    return parser;
  }

  function safeUrl(value) {
    try {
      var parsed = new URL(value, window.location.href);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
        ? parsed
        : null;
    } catch (error) {
      return null;
    }
  }

  function hardenLinks(root) {
    var links = root.querySelectorAll('a[href]');
    for (var index = 0; index < links.length; index += 1) {
      var link = links[index];
      var parsed = safeUrl(link.getAttribute('href'));
      if (!parsed) {
        link.removeAttribute('href');
        link.removeAttribute('target');
        link.removeAttribute('rel');
        continue;
      }
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.origin !== window.location.origin) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else {
        link.removeAttribute('target');
        link.removeAttribute('rel');
      }
    }
  }

  function hardenTaskLists(root) {
    var checkboxes = root.querySelectorAll('input[type="checkbox"]');
    for (var index = 0; index < checkboxes.length; index += 1) {
      var checkbox = checkboxes[index];
      checkbox.disabled = true;
      checkbox.tabIndex = -1;
      checkbox.setAttribute('aria-label', checkbox.checked ? 'Completed task' : 'Incomplete task');
    }
  }

  function wrapTables(root) {
    var tables = root.querySelectorAll('table');
    for (var index = 0; index < tables.length; index += 1) {
      var table = tables[index];
      if (table.parentElement && table.parentElement.classList.contains('markdown-table-scroll')) continue;
      var wrapper = document.createElement('div');
      wrapper.className = 'markdown-table-scroll';
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', 'Scrollable table');
      wrapper.tabIndex = 0;
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    }
  }

  function renderInto(target, source) {
    if (!target) return;
    target.classList.add('markdown-body');
    var activeParser = markdownParser();
    if (!activeParser || !window.DOMPurify) {
      target.textContent = source == null ? '' : String(source);
      return;
    }

    try {
      var html = activeParser.parse(source == null ? '' : String(source));
      var fragment = window.DOMPurify.sanitize(html, {
        ALLOWED_TAGS: [
          'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'hr', 'input', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead',
          'tr', 'ul'
        ],
        ALLOWED_ATTR: [
          'align', 'aria-label', 'checked', 'class', 'disabled', 'href', 'start', 'tabindex', 'title', 'type'
        ],
        ALLOW_DATA_ATTR: false,
        FORBID_ATTR: ['style'],
        RETURN_DOM_FRAGMENT: true
      });
      hardenLinks(fragment);
      hardenTaskLists(fragment);
      wrapTables(fragment);
      target.replaceChildren(fragment);
    } catch (error) {
      target.textContent = source == null ? '' : String(source);
    }
  }

  window.MeshMarkdown = Object.freeze({
    renderInto: renderInto
  });
}());

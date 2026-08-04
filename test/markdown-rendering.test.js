const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function rendererPage() {
  const dom = new JSDOM('<!doctype html><main id="target"></main>', {
    runScripts: 'outside-only',
    url: 'https://zqx.lat/qwen38/'
  });
  dom.window.eval(source('dist/assets/vendor/marked.umd.js'));
  dom.window.eval(source('dist/assets/vendor/purify.min.js'));
  dom.window.eval(source('dist/assets/markdown-renderer.js'));
  return dom;
}

function render(markdown) {
  const dom = rendererPage();
  const target = dom.window.document.querySelector('#target');
  dom.window.MeshMarkdown.renderInto(target, markdown);
  return { dom, target };
}

const screenshotFixture = [
  '| Check | Reading | Verdict |',
  '|---|---|---|',
  '| GPU | RTX 3090, **96% util**, 24.1/24.6 GB VRAM, 68 °C, 275 W | ✅ actively training |',
  '| Trainer | `agillm41_v10` (sha-pinned) PID 7964, resumed from step 1269091 | ✅ alive |',
  '| Current step | **1,360,442** (per `latest.json`) | ✅ advancing |',
  '| CPU | load 34 on **96 cores** — earlier “high load” worry was wrong | ✅ fine |',
  '| Latest ckpt | `pretrain_step01360442` saved 22:54 UTC | ✅ complete |',
  '',
  '## The one real finding',
  '',
  'The box is **ahead of GETH**: it is at step **1,360,442**, while sync is lagging.'
].join('\n');

test('renders the screenshot Markdown as semantic table, heading, emphasis, and code', () => {
  const { dom, target } = render(screenshotFixture);
  const document = dom.window.document;
  assert.equal(target.classList.contains('markdown-body'), true);
  assert.equal(target.querySelectorAll('.markdown-table-scroll').length, 1);
  assert.equal(target.querySelectorAll('table').length, 1);
  assert.deepEqual(
    Array.from(target.querySelectorAll('thead th'), (cell) => cell.textContent),
    ['Check', 'Reading', 'Verdict']
  );
  assert.equal(target.querySelectorAll('tbody tr').length, 5);
  assert.equal(target.querySelector('h2').textContent, 'The one real finding');
  assert.ok(target.querySelectorAll('strong').length >= 4);
  assert.ok(target.querySelectorAll('code').length >= 3);
  assert.equal(target.textContent.includes('**'), false);
  assert.equal(target.textContent.includes('##'), false);
  assert.equal(target.textContent.includes('`latest.json`'), false);
  assert.equal(document.querySelector('.markdown-table-scroll').tabIndex, 0);
});

test('covers GFM tables, alignment, escaped pipes, inline code, and mixed Unicode symbols', () => {
  const markdown = [
    '| Left | Right | Centre | Empty |',
    '|:---|---:|:---:|---|',
    '| a\\|b | 42 | `x \\| y` | |',
    '| ✅ ❌ ↔ → ← | ≤ ≥ ≠ ≈ | ± × ÷ ° µ | α β ∑ √ ∞ |',
    '',
    '~~strike~~, _italic_, ***both***, \\*literal\\*, and 👩🏽‍💻 café.'
  ].join('\n');
  const { target } = render(markdown);
  const headers = target.querySelectorAll('th');
  assert.equal(headers[0].getAttribute('align'), 'left');
  assert.equal(headers[1].getAttribute('align'), 'right');
  assert.equal(headers[2].getAttribute('align'), 'center');
  assert.match(target.textContent, /a\|b/);
  assert.match(target.querySelector('td code').textContent, /x \| y/);
  assert.match(target.textContent, /✅ ❌ ↔ → ←/);
  assert.match(target.textContent, /≤ ≥ ≠ ≈/);
  assert.match(target.textContent, /± × ÷ ° µ/);
  assert.match(target.textContent, /α β ∑ √ ∞/);
  assert.ok(target.querySelector('del'));
  assert.ok(target.querySelector('em'));
  assert.equal(target.textContent.includes('*literal*'), true);
});

test('renders lists, task lists, quotes, code blocks, links, and rules', () => {
  const markdown = [
    '- item',
    '  - nested',
    '- [x] complete',
    '- [ ] waiting',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted',
    '',
    '---',
    '',
    '```js',
    'const comparison = x < y && a|b;',
    '```',
    '',
    '[external](https://example.com/a_(b)) [internal](/qwen38/help) [mail](mailto:test@example.com)'
  ].join('\n');
  const { target } = render(markdown);
  assert.ok(target.querySelector('ul ul'));
  assert.ok(target.querySelector('ol'));
  assert.ok(target.querySelector('blockquote'));
  assert.ok(target.querySelector('hr'));
  assert.match(target.querySelector('pre code').textContent, /x < y && a\|b/);
  const checkboxes = target.querySelectorAll('input[type="checkbox"]');
  assert.equal(checkboxes.length, 2);
  assert.equal(checkboxes[0].disabled, true);
  assert.equal(checkboxes[0].tabIndex, -1);
  assert.equal(checkboxes[0].getAttribute('aria-label'), 'Completed task');
  assert.equal(checkboxes[1].getAttribute('aria-label'), 'Incomplete task');
  const links = target.querySelectorAll('a');
  assert.equal(links[0].target, '_blank');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(links[1].hasAttribute('target'), false);
  assert.equal(links[2].protocol, 'mailto:');
});

test('treats raw HTML as text and rejects active or unsafe URL content', () => {
  const payload = [
    '<script>window.__markdownXss = true</script>',
    '<img src=x onerror="window.__markdownXss = true">',
    '<svg onload="window.__markdownXss = true"></svg>',
    '<iframe src="https://example.com"></iframe>',
    '<style>body{display:none}</style>',
    '[js](javascript:alert(1))',
    '[data](data:text/html,boom)',
    '[safe](https://example.com)'
  ].join('\n\n');
  const { dom, target } = render(payload);
  assert.equal(dom.window.__markdownXss, undefined);
  assert.equal(target.querySelectorAll('script,img,svg,iframe,style').length, 0);
  assert.equal(target.querySelector('[onerror],[onload]'), null);
  const links = Array.from(target.querySelectorAll('a'));
  assert.equal(links.length, 3);
  assert.equal(links[0].hasAttribute('href'), false);
  assert.equal(links[1].hasAttribute('href'), false);
  assert.equal(links[2].textContent, 'safe');
  assert.equal(links[2].protocol, 'https:');
  assert.match(target.textContent, /<script>/);
  assert.match(target.textContent, /<img/);
});

test('re-renders an accumulated streaming buffer when incomplete syntax becomes valid', () => {
  const dom = rendererPage();
  const target = dom.window.document.querySelector('#target');
  dom.window.MeshMarkdown.renderInto(target, '| A | B |\n');
  assert.equal(target.querySelector('table'), null);
  dom.window.MeshMarkdown.renderInto(target, '| A | B |\n|---|---|\n| **x** | `y` |');
  assert.ok(target.querySelector('table'));
  assert.equal(target.querySelector('strong').textContent, 'x');
  assert.equal(target.querySelector('code').textContent, 'y');
});

test('wires every assistant path to the shared renderer and cache-busts assets in order', () => {
  const app = source('dist/assets/app.js');
  const index = source('dist/index.html');
  const css = source('dist/assets/app.css');
  const markedPosition = index.indexOf('marked.umd.js');
  const purifyPosition = index.indexOf('purify.min.js');
  const rendererPosition = index.indexOf('markdown-renderer.js');
  const appPosition = index.indexOf('app.js?v=');
  assert.ok(markedPosition < purifyPosition && purifyPosition < rendererPosition && rendererPosition < appPosition);
  assert.match(index, /app\.css\?v=[^"']+/);
  assert.match(app, /message\.role === 'assistant'\) renderAssistantMarkdown/);
  assert.match(app, /renderAssistantMarkdown\(bubble, job\.reply != null \? job\.reply : job\.streamText\)/);
  assert.match(app, /scheduleStreamingMarkdown\(job\)/);
  assert.match(app, /else bubble\.textContent = message\.content/);
  assert.match(css, /\.markdown-table-scroll[\s\S]*overflow-x: auto/);
  assert.match(css, /\.message\.assistant \.message-bubble[\s\S]*white-space: normal/);
  assert.match(css, /\.message\.user \.message-bubble/);
  assert.match(app, /data-active-mode=\"steer\"/);
  assert.match(app, /data-active-mode=\"queue\"/);
  assert.match(app, /function sendSteering\(input\)/);
  assert.match(app, /clientSteeringId/);
  assert.match(app, /function applySteeringEvent\(job, data\)/);
  assert.match(app, /function requireSeparateTurnConfirmation\(job, message\)/);
  assert.match(app, /The stale model draft is stopping so Qwen can replan now/);
  assert.doesNotMatch(app, /turn finished before steering was accepted, so this message was queued next/);
  assert.match(app, /Your text is untouched; press send again/);
  assert.doesNotMatch(app, /MAX_QUEUED_TURNS/);
  assert.doesNotMatch(app, /The queue is full/);
  assert.match(app, /job\.streamText = ''/);
  assert.match(css, /\.active-turn-panel/);
  assert.match(css, /\.composer\.steer-active \.send-button/);
});

test('ships parseable CSS and preserves GFM centre and right table alignment', () => {
  const dom = new JSDOM('<!doctype html><style id="app-style"></style><table class="markdown-body"><tr><th align="center">C</th><td align="right">R</td></tr></table>');
  const style = dom.window.document.querySelector('#app-style');
  style.textContent = source('dist/assets/app.css');
  assert.ok(style.sheet, 'app.css should parse as a stylesheet');
  const centre = dom.window.document.querySelector('th');
  const right = dom.window.document.querySelector('td');
  assert.equal(dom.window.getComputedStyle(centre).textAlign, 'center');
  assert.equal(dom.window.getComputedStyle(right).textAlign, 'right');
});

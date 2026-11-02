/**
 * @jest-environment jsdom
 */
// The Chrome Web Store language picker, against a real DOM.
//
// A switch is only trusted once the combobox shows the language that was picked,
// so a run never writes one locale's text into another's page. That check used
// the configured CWS code, which broke Hebrew: the config says "iw" (Google's old
// code), the dashboard now lists "Hebrew – he", the option was found by name and
// the switch happened, and the check still refused it.
//
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const OPTIONS = ['English – en (default)', 'French – fr', 'Hebrew – he',
                 'Portuguese (Brazil) – pt-BR', 'Portuguese (Portugal) – pt-PT'];

// A combobox whose label follows the option clicked, unless `stuck` says the
// page ignored the click.
function loadSelectLanguage({ stuck = false } = {}) {
  document.body.innerHTML = `
    <div role="combobox" id="combo">Language${OPTIONS[0]}</div>
    <ul>${OPTIONS.map(o => `<li role="option">${o}</li>`).join('')}</ul>`;
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 10, height: 10 }];
  };
  document.querySelectorAll('[role="option"]').forEach(li => {
    li.addEventListener('click', () => {
      if (!stuck) document.getElementById('combo').textContent = 'Language' + li.textContent;
    });
  });

  const sandbox = {
    chrome: { scripting: { executeScript: async () => [{ result: null }] } },
    document,
    getComputedStyle: (el) => window.getComputedStyle(el),
    KeyboardEvent: window.KeyboardEvent,
    setTimeout: (fn) => { fn(); return 0; },
    console,
  };
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'stores', 'cws.js'), 'utf8');
  vm.runInContext(src + '\n;globalThis.__fn = cwsPageSelectLanguage;',
                  vm.createContext(sandbox), { filename: 'stores/cws.js' });
  return sandbox.__fn;
}

describe('confirming a language switch', () => {
  test('accepts the dashboard code when it differs from the configured one', async () => {
    const select = loadSelectLanguage();
    const res = await select({ code: 'iw', names: ['Hebrew'] });
    expect(res).toMatchObject({ ok: true, selected: 'Hebrew – he', confirmed: true });
  });

  test('confirms a plain code match', async () => {
    const select = loadSelectLanguage();
    expect(await select({ code: 'fr', names: ['French'] }))
      .toMatchObject({ ok: true, confirmed: true });
  });

  test('confirms a regional variant', async () => {
    const select = loadSelectLanguage();
    expect(await select({ code: 'pt-BR', names: ['Portuguese (Brazil)'] }))
      .toMatchObject({ ok: true, selected: 'Portuguese (Brazil) – pt-BR', confirmed: true });
  });

  test('still refuses a switch the page did not make', async () => {
    const select = loadSelectLanguage({ stuck: true });
    expect(await select({ code: 'iw', names: ['Hebrew'] }))
      .toMatchObject({ ok: true, confirmed: false });
  });
});

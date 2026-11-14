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


// ── deleting a screenshot ─────────────────────────────────────────────────────
//
// Google changed the confirmation dialog and the run aborted with nothing but
// {before: 5, after: 5}. The dialog is now recognised in more forms, and a
// failure says what the page showed instead.

// `shots` remove buttons under "Localized assets". Clicking one opens `dialog`
// (built by the test); the dialog's confirm removes the first screenshot.
function loadDelete(shots, buildDialog) {
  document.body.innerHTML = `<h2>Localized assets</h2><div id="shots">${
    Array.from({ length: shots }, (_, i) =>
      `<button aria-label="Remove image Screenshot ${i + 1}"></button>`).join('')}</div>`;
  Element.prototype.getClientRects = function getClientRects() {
    return this.closest && this.closest('[hidden]') ? [] : [{ width: 10, height: 10 }];
  };
  const removeOne = () => document.querySelector('#shots button')?.remove();
  document.querySelectorAll('#shots button').forEach(b => b.addEventListener('click', () => {
    if (buildDialog) buildDialog(removeOne);
  }));

  const sandbox = {
    chrome: { scripting: { executeScript: async () => [{ result: null }] } },
    document,
    getComputedStyle: (el) => window.getComputedStyle(el),
    KeyboardEvent: window.KeyboardEvent,
    Node,
    setTimeout: (fn) => { fn(); return 0; },
    console,
  };
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'stores', 'cws.js'), 'utf8');
  vm.runInContext(src + '\n;globalThis.__fn = cwsPageDeleteOneScreenshot;',
                  vm.createContext(sandbox), { filename: 'stores/cws.js' });
  return sandbox.__fn;
}

// A dialog in the light DOM. `confirm` is the label of the button that deletes.
function lightDialog(open, buttons, confirm) {
  return (removeOne) => {
    const host = document.createElement('div');
    host.innerHTML = open;
    const dlg = host.firstElementChild;
    for (const label of buttons) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { if (label === confirm) removeOne(); dlg.remove(); });
      dlg.appendChild(b);
    }
    document.body.appendChild(dlg);
  };
}

describe('deleting a screenshot', () => {
  test('confirms a role="dialog", pressing Delete and not Cancel', async () => {
    const del = loadDelete(5, lightDialog('<div role="dialog"></div>', ['Cancel', 'Delete'], 'Delete'));
    expect(await del('localized')).toMatchObject({ ok: true, before: 5, after: 4, confirmed: 'Delete' });
  });

  test('confirms a native <dialog> with no role', async () => {
    const del = loadDelete(2, lightDialog('<dialog open></dialog>', ['Keep image', 'Remove image'], 'Remove image'));
    expect(await del('localized')).toMatchObject({ ok: true, after: 1, confirmed: 'Remove image' });
  });

  test('confirms an aria-modal container', async () => {
    const del = loadDelete(2, lightDialog('<div aria-modal="true"></div>', ['Cancel', 'OK'], 'OK'));
    expect(await del('localized')).toMatchObject({ ok: true, after: 1 });
  });

  test('confirms a dialog component whose buttons sit in a shadow root', async () => {
    const del = loadDelete(3, (removeOne) => {
      const dlg = document.createElement('x-confirm-dialog');
      const shadow = dlg.attachShadow({ mode: 'open' });
      for (const label of ['Cancel', 'Delete']) {
        const b = document.createElement('button');
        b.textContent = label;
        b.addEventListener('click', () => { if (label === 'Delete') removeOne(); dlg.remove(); });
        shadow.appendChild(b);
      }
      document.body.appendChild(dlg);
    });
    const r = await del('localized');
    expect(r).toMatchObject({ ok: true, after: 2, confirmed: 'Delete' });
  });

  test('still works when the console deletes without asking', async () => {
    const del = loadDelete(2, (removeOne) => removeOne());
    expect(await del('localized')).toMatchObject({ ok: true, after: 1 });
  });

  test('reports what a dialog offered when nothing in it confirms', async () => {
    const del = loadDelete(2, lightDialog('<div role="dialog"><p>Discard?</p></div>', ['Cancel', 'Got it'], null));
    const res = await del('localized');
    expect(res).toMatchObject({ ok: false, step: 'no-confirm-control', before: 2, after: 2 });
    expect(res.dialogs[0].buttons).toEqual(['Cancel', 'Got it']);
  });

  test('lists what the click brought up when no dialog is recognised', async () => {
    const del = loadDelete(2, () => {
      const row = document.createElement('div');
      row.innerHTML = '<span>Are you sure?</span><button>Yes, discard</button>';
      document.body.appendChild(row);
    });
    const res = await del('localized');
    expect(res).toMatchObject({ ok: false, step: 'delete-did-not-take', sawDialog: false });
    expect(res.newButtons).toEqual(['Yes, discard']);
  });
});

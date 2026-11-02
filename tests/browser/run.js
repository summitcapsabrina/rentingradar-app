// Drives the real index.html in headless Chrome over CDP: npm run test:browser
// Optional arguments: a directory holding index.html (to run an older checkout as a
// control) and a port. CHROME_PATH overrides the macOS Chrome location.
// Extension, geocoder, Firestore and saves are stubbed in the page (page.js), and the
// network layer blocks every backend, so nothing can reach production.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const PORT = Number(process.argv[3] || 8791);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BLOCK = ['*firestore.googleapis.com*', '*identitytoolkit.googleapis.com*', '*securetoken.googleapis.com*',
  '*firebaseinstallations.googleapis.com*', '*fcmregistrations.googleapis.com*', '*maps.googleapis.com*', '*cloudfunctions.net*',
  '*googletagmanager.com*', '*google-analytics.com*', '*googleadservices.com*', '*doubleclick.net*', '*stripe.com*',
  '*vercel.app*', '*rentingradar.com*', '*facebook.net*'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '-d', ROOT], { stdio: 'ignore' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-harness-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanup = () => { chrome.kill(); server.kill(); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (_) {} };
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
      chrome.stderr.on('data', (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\S+)/);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
    });
    await sleep(500);
    const base = new URL(wsUrl);
    const list = await (await fetch('http://' + base.host + '/json/list')).json();
    const ws = new WebSocket(list.find((x) => x.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0;
    const waiting = new Map();
    const events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.method) events.push(m);
    };
    const send = (method, params) => new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
    });
    const evalPage = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
      return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: BLOCK });
    const load = async () => {
      events.length = 0;
      await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
      for (let i = 0; i < 100 && !events.some((e) => e.method === 'Page.loadEventFired'); i++) await sleep(100);
      await sleep(1500);
    };
    await load();
    const setup = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
    await evalPage(setup);
    const names = await evalPage('Object.keys(H.scenarios)');
    let failed = 0;
    for (const name of names) {
      await load();
      await evalPage(setup);
      await evalPage('H.init()');
      let res;
      try {
        res = await Promise.race([
          evalPage('H.scenarios[' + JSON.stringify(name) + ']()'),
          sleep(25000).then(() => ({ fails: ['scenario timed out'] })),
        ]);
      } catch (e) { res = { fails: ['threw: ' + e.message] }; }
      const fails = (res && res.fails) || [];
      if (fails.length) failed++;
      console.log((fails.length ? 'FAIL ' : 'ok   ') + name + (res && res.note ? '  [saves by: ' + res.note + ']' : '') + (fails.length ? '\n       - ' + fails.join('\n       - ') : ''));
    }
    // A reload that had to wait for the queue. It ends the page, so it runs apart.
    await load();
    await evalPage(setup);
    await evalPage('H.init()');
    await evalPage('H.startQueueThenReload()');
    let reloaded = false;
    for (let i = 0; i < 60 && !reloaded; i++) {
      await sleep(250);
      reloaded = events.some((e) => e.method === 'Page.loadEventFired') && await evalPage('!window.H').catch(() => false);
    }
    await sleep(800);
    const log = await evalPage("sessionStorage.getItem('rrHarnessQueueLog')");
    const ok = reloaded && log === 'first,queued';
    if (!ok) failed++;
    console.log((ok ? 'ok   ' : 'FAIL ') + 'S5 a reload waits until the queued popup import has run' + (ok ? '' : '\n       - reloaded=' + reloaded + ' ran=' + log));
    console.log(failed ? '\n' + failed + ' scenario(s) failed' : '\nall scenarios passed');
    if (failed) process.exitCode = 1;
    ws.close();
  } finally { cleanup(); }
}
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });

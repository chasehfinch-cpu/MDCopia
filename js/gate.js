// MDCopia password gate.
// Pre-launch curtain only — NOT cryptographic security. Hashes the entered
// password with SHA-256 (Web Crypto) and compares to PASSWORD_HASH below.
// To remove for production: set GATE_ENABLED = false (or delete this file
// + its <script> tag from every page + remove `body { visibility: hidden }`).

const GATE_ENABLED = true;

// SHA-256 of the current pre-launch password. Share the password with
// partners out-of-band (text, call). Never commit the plaintext.
// Current password: mdcopia-2026  (rotate by re-hashing and updating below)
const PASSWORD_HASH = '2f5ab8a88b1d4a8d0fc8f6bbc2aef161eeee6a6ccd01355e38819bb776567dfd';

const STORAGE_KEY = 'mdcopia_access';

function whenReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

whenReady(async function () {
  if (!GATE_ENABLED) {
    document.body.classList.add('gate-disabled');
    return;
  }
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === PASSWORD_HASH) {
    document.body.classList.add('gate-disabled');
    return;
  }
  injectOverlay();
});

function injectOverlay() {
  const wrap = document.createElement('div');
  wrap.id = 'mdcopia-gate';
  wrap.innerHTML = `
    <div id="mdcopia-gate__brand">
      <span class="md">MD</span><span class="copia">Copia</span>
    </div>
    <form id="mdcopia-gate__form" autocomplete="off">
      <input type="password" id="mdcopia-gate__input" placeholder="Password" autofocus aria-label="Password" />
      <button type="submit">Enter</button>
      <div id="mdcopia-gate__error" role="alert"></div>
    </form>
  `;
  document.documentElement.appendChild(wrap);

  document.getElementById('mdcopia-gate__form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('mdcopia-gate__input').value;
    const hash = await sha256(pw);
    if (hash === PASSWORD_HASH) {
      localStorage.setItem(STORAGE_KEY, hash);
      wrap.remove();
      document.body.classList.add('gate-disabled');
    } else {
      document.getElementById('mdcopia-gate__error').textContent = 'Incorrect password';
    }
  });
}

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * CRUDPAY — Payment Module
 * payment.js
 *
 * Handles the full payment flow:
 *   Step 1 → Details + Method selection
 *   Step 2 → Review
 *   Step 3 → Result (Success | Failed | Pending)
 *
 * All analytics events fire silently in the background.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   CONFIGURATION
═══════════════════════════════════════════════════════════ */

const CORRIDORS = {
  'INR-USD': { sym: '₹', geo: 'India', country: 'IN', rec: 'UPI',    label: 'INR → USD', fxHint: '≈ 0.012 USD/₹' },
  'INR-EUR': { sym: '₹', geo: 'EU',    country: 'EU', rec: 'SOFORT', label: 'INR → EUR', fxHint: '≈ 0.011 EUR/₹' },
  'INR-BRL': { sym: '₹', geo: 'Brazil',country: 'BR', rec: 'PIX',    label: 'INR → BRL', fxHint: '≈ 0.059 BRL/₹' },
  'INR-GBP': { sym: '₹', geo: 'EU',    country: 'UK', rec: 'Card',   label: 'INR → GBP', fxHint: '≈ 0.0095 GBP/₹' },
  'USD-INR': { sym: '$', geo: 'India', country: 'IN', rec: 'UPI',    label: 'USD → INR', fxHint: '≈ 83.4 INR/$' },
  'USD-BRL': { sym: '$', geo: 'Brazil',country: 'BR', rec: 'PIX',    label: 'USD → BRL', fxHint: '≈ 5.1 BRL/$' },
};

const METHOD_META = {
  UPI:    { icon: '🇮🇳', name: 'UPI',             sub: 'Instant bank transfer for India', eta: 'Instant',    fee: 0,    rec: true  },
  PIX:    { icon: '🇧🇷', name: 'PIX',             sub: 'Instant transfers in Brazil',     eta: 'Instant',    fee: 0,    rec: true  },
  Card:   { icon: '💳', name: 'Debit/Credit Card', sub: 'Visa, Mastercard, Rupay',        eta: '1-2 min',    fee: 1.5,  rec: false },
  SOFORT: { icon: '🏦', name: 'SOFORT',           sub: 'Direct bank transfer (EU)',        eta: '1-3 days',   fee: 0.5,  rec: false },
  SEPA:   { icon: '🇪🇺', name: 'SEPA Transfer',   sub: 'European bank-to-bank transfer',  eta: '1-2 days',   fee: 0,    rec: false },
  Wire:   { icon: '🌐', name: 'Wire Transfer',     sub: 'International SWIFT wire',         eta: '2-5 days',   fee: 15,   rec: false },
};

/* Methods per corridor (ordered: personalized first on load) */
const CORRIDOR_METHODS = {
  'INR-USD': ['UPI',  'Card',   'Wire'],
  'INR-EUR': ['SEPA', 'SOFORT', 'Card', 'Wire'],
  'INR-BRL': ['PIX',  'Card',   'Wire'],
  'INR-GBP': ['Card', 'SEPA',   'Wire'],
  'USD-INR': ['UPI',  'Card',   'Wire'],
  'USD-BRL': ['PIX',  'Card',   'Wire'],
};

/* Segment write key (same as index.html) */
const WRITE_KEY = 'A6OwrhlAmXxkxkwm3Vnnizkmy18shHkI';

/* localStorage keys */
const LS_USERS   = 'mos_users';
const LS_CURRENT = 'mos_current';

/* sessionStorage key */
const SS_SESSION = 'crudpay_payment_session';

/* ═══════════════════════════════════════════════════════════
   MODULE STATE
═══════════════════════════════════════════════════════════ */

let session      = null;   // parsed from sessionStorage
let currentUser  = null;   // user object from localStorage
let selectedMethod = null; // chosen payment method key
let currentStep  = 1;

/* ═══════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initSession();
  initSegmentIdentify();
  populateTopbar();
  initCorridorSelect();
  renderMethods();
  renderPersonaBanner();
  trackPageView();
  registerAbandonTracking();
});

/* ── Session ── */
function initSession() {
  try {
    const raw = sessionStorage.getItem(SS_SESSION);
    if (raw) session = JSON.parse(raw);
  } catch (e) { /* ignore */ }

  /* Fallback: read directly from localStorage if no session (e.g. direct URL access) */
  if (!session) {
    const email = localStorage.getItem(LS_CURRENT);
    let users = {};
    try { users = JSON.parse(localStorage.getItem(LS_USERS) || '{}'); } catch (e) {}
    const user = email ? users[email] : null;
    if (user) {
      const corridor = user._lastCorridor || 'INR-USD';
      const cfg      = CORRIDORS[corridor] || CORRIDORS['INR-USD'];
      session = {
        userId:           user.mid,
        email:            user.email || email,
        name:             user.name,
        churnRisk:        user.churnRisk || 'LOW',
        trustScore:       user.trustScore || 10,
        activationStatus: user.activationStatus || 'Not Activated',
        checkoutId:       'chk_' + Math.random().toString(36).slice(2, 10),
        startedAt:        new Date().toISOString(),
        device:           detectDevice(),
        corridor:         corridor,
        corridorLabel:    cfg.label,
        geo:              cfg.geo,
        country:          cfg.country,
        preferredMethod:  cfg.rec,
        isMobile:         detectDevice() === 'Mobile',
      };
    } else {
      /* Completely standalone — show notice */
      document.getElementById('standalone-notice').style.display = '';
      session = {
        userId:        'anon',
        email:         '',
        name:          'Guest',
        checkoutId:    'chk_' + Math.random().toString(36).slice(2, 10),
        startedAt:     new Date().toISOString(),
        device:        detectDevice(),
        corridor:      'INR-USD',
        corridorLabel: 'INR → USD',
        geo:           'India',
        country:       'IN',
        preferredMethod: 'UPI',
        isMobile:      detectDevice() === 'Mobile',
      };
    }
  }

  /* Load user from localStorage for transaction saving later */
  const email = localStorage.getItem(LS_CURRENT);
  if (email) {
    let users = {};
    try { users = JSON.parse(localStorage.getItem(LS_USERS) || '{}'); } catch (e) {}
    currentUser = users[email] || null;
  }
}

function detectDevice() {
  const ua = navigator.userAgent;
  if (/tablet|ipad|playbook|silk/i.test(ua)) return 'Tablet';
  if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) return 'Mobile';
  return 'Desktop';
}

/* ── Segment identify ── */
function initSegmentIdentify() {
  if (!session || !session.userId || session.userId === 'anon') return;
  safeTrack(() => {
    window.analytics && analytics.identify(session.userId, {
      email:            session.email,
      name:             session.name,
      device:           session.device,
      corridor:         session.corridor,
      preferredMethod:  session.preferredMethod,
      churnRisk:        session.churnRisk,
      trustScore:       session.trustScore,
      activationStatus: session.activationStatus,
    });
  });
}

/* ── Topbar ── */
function populateTopbar() {
  if (!session) return;
  const name    = session.name || session.email || 'Guest';
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const pill     = document.getElementById('topbar-user');
  const avatarEl = document.getElementById('topbar-avatar');
  const nameEl   = document.getElementById('topbar-name');
  if (pill)     pill.style.display = 'flex';
  if (avatarEl) avatarEl.textContent = initials;
  if (nameEl)   nameEl.textContent = name.split(' ')[0];

  /* Update step 1 sub-text */
  const sub = document.getElementById('step1-sub');
  if (sub && session.geo) {
    sub.textContent = `Sending from ${session.geo}. Choose your corridor, amount, recipient, and preferred payment method.`;
  }
}

/* ═══════════════════════════════════════════════════════════
   CORRIDOR + METHOD RENDERING
═══════════════════════════════════════════════════════════ */

function initCorridorSelect() {
  const sel = document.getElementById('corridor-select');
  if (!sel) return;

  /* Set pre-selected corridor from session */
  if (session && session.corridor) {
    sel.value = session.corridor;
  }

  /* Update amount symbol */
  updateAmountSym();

  sel.addEventListener('change', onCorridorChange);
}

function onCorridorChange() {
  const sel     = document.getElementById('corridor-select');
  const corridor = sel ? sel.value : (session.corridor || 'INR-USD');
  const cfg      = CORRIDORS[corridor] || CORRIDORS['INR-USD'];

  /* Update session corridor fields for review step */
  if (session) {
    session.corridor      = corridor;
    session.corridorLabel = cfg.label;
    session.geo           = cfg.geo;
    session.country       = cfg.country;
    session.preferredMethod = cfg.rec;
  }

  updateAmountSym();
  renderMethods();
  renderPersonaBanner();
  updateCorridorNote();

  /* Reset selected method when corridor changes */
  selectedMethod = null;

  /* Analytics: track corridor change */
  safeTrack(() => analytics.track('Corridor Changed', {
    merchantId:    session.userId,
    checkoutId:    session.checkoutId,
    fromCorridor:  session.corridor,
    toCorridor:    corridor,
    geo:           cfg.geo,
    country:       cfg.country,
    device:        session.device,
    timestamp:     new Date().toISOString(),
  }));
}

function updateAmountSym() {
  const sel      = document.getElementById('corridor-select');
  const corridor = sel ? sel.value : (session ? session.corridor : 'INR-USD');
  const cfg      = CORRIDORS[corridor];
  const symEl    = document.getElementById('amount-sym');
  if (symEl && cfg) symEl.textContent = cfg.sym;
}

function updateCorridorNote() {
  const sel      = document.getElementById('corridor-select');
  const corridor = sel ? sel.value : (session ? session.corridor : 'INR-USD');
  const cfg      = CORRIDORS[corridor];
  const noteEl   = document.getElementById('corridor-note');
  if (noteEl && cfg) noteEl.textContent = cfg.fxHint;
}

/* ── Persona Banner ── */
function renderPersonaBanner() {
  const el = document.getElementById('persona-banner');
  if (!el || !session) return;

  const corridor = getCurrentCorridor();
  const cfg      = CORRIDORS[corridor] || CORRIDORS['INR-USD'];
  const isMobile = session.isMobile;
  const geo      = cfg.geo;

  let cls  = '';
  let text = '';

  if (isMobile && (geo === 'Brazil' || geo === 'India')) {
    cls  = 'persona-mobile';
    text = `📱 Mobile-optimised checkout — showing the fastest 2 methods for your region.`;
  } else if (geo === 'Brazil') {
    cls  = 'persona-brazil';
    text = `🇧🇷 You're sending to Brazil — PIX is instant, free, and the recommended method.`;
  } else if (geo === 'India') {
    cls  = 'persona-india';
    text = `🇮🇳 India corridor detected — UPI is preferred for instant zero-fee transfers.`;
  } else {
    el.style.display = 'none';
    return;
  }

  el.className = `persona-banner ${cls}`;
  el.textContent = text;
  el.style.display = '';
}

/* ── Payment Methods ── */
function renderMethods() {
  const grid = document.getElementById('methods-grid');
  if (!grid || !session) return;

  const corridor = getCurrentCorrider();
  const cfg      = CORRIDORS[corridor] || CORRIDORS['INR-USD'];
  const methods  = CORRIDOR_METHODS[corridor] || ['UPI', 'Card', 'Wire'];

  /* Personalization: for mobile + Brazil/India → show only top 2 */
  const isMobile = session.isMobile;
  const geo      = cfg.geo;
  const displayMethods = (isMobile && (geo === 'Brazil' || geo === 'India'))
    ? methods.slice(0, 2)
    : methods;

  /* Determine the "featured first" method */
  const featuredMethod = cfg.rec;

  /* Recommendation banner */
  const recBanner = document.getElementById('rec-banner');
  const recText   = document.getElementById('rec-banner-text');
  const meta      = METHOD_META[featuredMethod];
  if (recBanner && recText && meta) {
    recText.textContent = `${meta.name} is recommended for this corridor — ${meta.eta.toLowerCase()}, ${meta.fee === 0 ? 'zero fees' : meta.fee + '% fee'}.`;
    recBanner.style.display = '';
  }

  /* Corridor note FX */
  updateCorridorNote();

  /* Build method cards */
  grid.innerHTML = displayMethods.map(method => {
    const m        = METHOD_META[method] || {};
    const isFirst  = method === featuredMethod;
    const isSel    = method === selectedMethod;
    const badgesHtml = buildBadges(method, isFirst);

    return `
      <div class="pay-method-card ${isFirst ? 'featured-first' : ''} ${isSel ? 'selected' : ''}"
           onclick="selectMethod('${method}')"
           data-method="${method}"
           id="method-card-${method}">
        <div class="pm-icon">${m.icon || '💰'}</div>
        <div class="pm-info">
          <div class="pm-name">${m.name || method}</div>
          <div class="pm-sub">${m.sub || ''}</div>
          <div class="pm-badges">${badgesHtml}</div>
        </div>
        <div class="pm-check">✓</div>
      </div>`;
  }).join('');

  /* Mobile notice */
  if (isMobile && (geo === 'Brazil' || geo === 'India')) {
    grid.insertAdjacentHTML('beforeend',
      `<div class="mobile-note">Simplified for mobile — more methods available on desktop.</div>`);
  }

  /* Analytics: methods displayed */
  safeTrack(() => analytics.track('Payment Method Displayed', {
    merchantId:   session.userId,
    checkoutId:   session.checkoutId,
    corridor,
    geo:          cfg.geo,
    country:      cfg.country,
    device:       session.device,
    methodsShown: displayMethods,
    recommended:  featuredMethod,
    isMobileFlow: session.isMobile,
    timestamp:    new Date().toISOString(),
  }));
}

function buildBadges(method, isFirst) {
  const m      = METHOD_META[method] || {};
  const badges = [];
  if (isFirst)  badges.push(`<span class="pm-badge pm-badge-first">✦ Best for corridor</span>`);
  if (m.rec)    badges.push(`<span class="pm-badge pm-badge-preferred">Preferred</span>`);
  if (m.eta)    badges.push(`<span class="pm-badge ${m.eta.includes('days') ? 'pm-badge-slow' : 'pm-badge-rec'}">${m.eta}</span>`);
  if (m.fee === 0) badges.push(`<span class="pm-badge pm-badge-rec">Free</span>`);
  return badges.join('');
}

/* ── Method selection ── */
window.selectMethod = function (method) {
  const prev = selectedMethod;
  selectedMethod = method;

  document.querySelectorAll('.pay-method-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.method === method);
    const check = card.querySelector('.pm-check');
    if (check) check.style.display = card.dataset.method === method ? 'flex' : 'none';
  });

  hideErr('method-err');

  /* Analytics: method selected */
  const corridor = getCurrentCorrider();
  const cfg      = CORRIDORS[corridor] || CORRIDORS['INR-USD'];
  safeTrack(() => analytics.track('Payment Method Selected', {
    merchantId:    session.userId,
    checkoutId:    session.checkoutId,
    corridor,
    geo:           cfg.geo,
    country:       cfg.country,
    device:        session.device,
    method,
    previousMethod: prev,
    isRecommended: method === cfg.rec,
    timestamp:     new Date().toISOString(),
  }));
};

/* ── Helpers to read current corridor ── */
function getCurrentCorrider() { return getCurrentCorridor(); }
function getCurrentCorridor() {
  const sel = document.getElementById('corridor-select');
  return (sel ? sel.value : null) || (session ? session.corridor : 'INR-USD');
}

/* ═══════════════════════════════════════════════════════════
   STEP NAVIGATION
═══════════════════════════════════════════════════════════ */

/* ── Go to Review ── */
window.spGoReview = function () {
  /* Validate */
  const amount    = document.getElementById('amount-input')?.value?.trim();
  const recipient = document.getElementById('recipient-name')?.value?.trim();
  const account   = document.getElementById('recipient-account')?.value?.trim();

  if (!amount || !recipient || !account) {
    showErr('details-err', 'Please fill in all required fields (amount, recipient name, and account).');
    return;
  }
  if (isNaN(Number(amount)) || Number(amount) <= 0) {
    showErr('details-err', 'Please enter a valid positive amount.');
    return;
  }
  if (!selectedMethod) {
    showErr('method-err', 'Please select a payment method to continue.');
    return;
  }

  hideErr('details-err');
  hideErr('method-err');

  /* Populate review */
  buildReview({ amount, recipient, account });

  /* Transition */
  setStep(2);
};

/* ── Build Review Rows ── */
function buildReview({ amount, recipient, account }) {
  const corridor = getCurrentCorridor();
  const cfg      = CORRIDORS[corridor] || CORRIDORS['INR-USD'];
  const method   = METHOD_META[selectedMethod] || {};
  const fee      = method.fee || 0;
  const feeAmt   = fee > 0 ? ((Number(amount) * fee) / 100).toFixed(2) : '0.00';
  const total    = fee > 0 ? (Number(amount) + Number(feeAmt)).toFixed(2) : Number(amount).toFixed(2);

  const rows = [
    { key: 'Corridor',     val: cfg.label },
    { key: 'Amount',       val: `${cfg.sym}${Number(amount).toLocaleString()}` },
    { key: 'Recipient',    val: recipient },
    { key: 'Account',      val: account },
    { key: 'Method',       val: method.name || selectedMethod },
    { key: 'Fee',          val: fee === 0 ? '<span class="rr-free">Free</span>' : `${cfg.sym}${feeAmt} (${fee}%)`, raw: true },
    { key: 'Estimated ETA', val: method.eta || '—' },
    { key: 'Total Charged', val: `<strong>${cfg.sym}${total}</strong>`, raw: true },
  ];

  const container = document.getElementById('review-rows');
  if (!container) return;
  container.innerHTML = rows.map(r => `
    <div class="review-row">
      <span class="rr-key">${r.key}</span>
      <span class="rr-val">${r.raw ? r.val : escHtml(r.val)}</span>
    </div>`).join('');
}

/* ── Back to step 1 ── */
window.spBack = function () { setStep(1); };

/* ── Confirm payment ── */
window.spConfirm = function () {
  const btn = document.getElementById('btn-confirm');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Processing <span class="loading-dots"><span></span><span></span><span></span></span>';
  }

  setStep(3);
  showProcessing();

  /* Read form values */
  const amount    = document.getElementById('amount-input')?.value?.trim();
  const recipient = document.getElementById('recipient-name')?.value?.trim();
  const account   = document.getElementById('recipient-account')?.value?.trim();
  const corridor  = getCurrentCorridor();
  const cfg       = CORRIDORS[corridor] || CORRIDORS['INR-USD'];
  const method    = METHOD_META[selectedMethod] || {};
  const fee       = method.fee || 0;
  const feeAmt    = fee > 0 ? ((Number(amount) * fee) / 100).toFixed(2) : '0.00';
  const total     = fee > 0 ? (Number(amount) + Number(feeAmt)).toFixed(2) : amount;
  const txnId     = 'TXN' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();

  /* Track attempt */
  safeTrack(() => analytics.track('Payment Attempted', {
    merchantId:  session.userId,
    checkoutId:  session.checkoutId,
    txnId,
    corridor,
    corridorLabel: cfg.label,
    geo:         cfg.geo,
    country:     cfg.country,
    device:      session.device,
    method:      selectedMethod,
    amount:      Number(amount),
    currency:    corridor.split('-')[0],
    fee:         Number(feeAmt),
    total:       Number(total),
    recipient,
    account,
    timestamp:   new Date().toISOString(),
  }));

  /* Simulate processing delay (1.8s) */
  setTimeout(() => {
    const outcome = simulateOutcome(selectedMethod, corridor);
    handleResult({ outcome, txnId, amount, corridor, cfg, recipient, account, total, method });
  }, 1800);
};

/* ── Outcome simulation ── */
function simulateOutcome(method, corridor) {
  /* Weighted outcomes based on method reliability */
  const weights = {
    UPI:    { success: 0.90, pending: 0.07, failed: 0.03 },
    PIX:    { success: 0.92, pending: 0.05, failed: 0.03 },
    Card:   { success: 0.87, pending: 0.06, failed: 0.07 },
    SOFORT: { success: 0.80, pending: 0.12, failed: 0.08 },
    SEPA:   { success: 0.88, pending: 0.10, failed: 0.02 },
    Wire:   { success: 0.82, pending: 0.15, failed: 0.03 },
  };
  const w   = weights[method] || { success: 0.85, pending: 0.10, failed: 0.05 };
  const rnd = Math.random();
  if (rnd < w.success)               return 'success';
  if (rnd < w.success + w.pending)   return 'pending';
  return 'failed';
}

/* ── Handle result display ── */
function handleResult({ outcome, txnId, amount, corridor, cfg, recipient, account, total, method }) {
  const iconEl    = document.getElementById('result-icon');
  const titleEl   = document.getElementById('result-title');
  const subEl     = document.getElementById('result-sub');
  const txnBox    = document.getElementById('result-txn-box');
  const txnIdEl   = document.getElementById('result-txn-id');
  const actionsEl = document.getElementById('result-actions');

  const outcomes = {
    success: {
      icon:  '✅',
      title: 'Payment Sent!',
      sub:   `Your ${cfg.label} transfer of ${cfg.sym}${Number(amount).toLocaleString()} to ${recipient} was completed successfully via ${method.name || selectedMethod}. ${method.eta && method.eta.includes('day') ? 'Funds will arrive in ' + method.eta + '.' : 'Funds have been transferred.'}`,
    },
    pending: {
      icon:  '⏳',
      title: 'Payment Pending',
      sub:   `Your payment of ${cfg.sym}${Number(amount).toLocaleString()} to ${recipient} is pending confirmation. You'll receive an update within ${method.eta || '1-2 business days'}.`,
    },
    failed: {
      icon:  '❌',
      title: 'Payment Failed',
      sub:   `We could not process your ${cfg.label} transfer via ${method.name || selectedMethod}. No funds were deducted. Please try again or choose a different payment method.`,
    },
  };

  const display = outcomes[outcome] || outcomes.pending;

  if (iconEl)  iconEl.textContent  = display.icon;
  if (titleEl) titleEl.textContent = display.title;
  if (subEl)   subEl.textContent   = display.sub;

  if (txnBox)  txnBox.style.display  = '';
  if (txnIdEl) txnIdEl.textContent   = txnId;
  if (actionsEl) actionsEl.style.display = '';

  /* Save transaction to localStorage */
  saveTransaction({ outcome, txnId, amount, corridor, cfg, recipient, account, total, method });

  /* Analytics */
  const eventName = {
    success: 'Payment Success',
    pending: 'Payment Pending',
    failed:  'Payment Failed',
  }[outcome] || 'Payment Pending';

  safeTrack(() => analytics.track(eventName, {
    merchantId:    session.userId,
    checkoutId:    session.checkoutId,
    txnId,
    corridor,
    corridorLabel: cfg.label,
    geo:           cfg.geo,
    country:       cfg.country,
    device:        session.device,
    method:        selectedMethod,
    methodName:    method.name || selectedMethod,
    amount:        Number(amount),
    currency:      corridor.split('-')[0],
    fee:           Number((method.fee || 0) * amount / 100),
    total:         Number(total),
    recipient,
    account,
    outcome,
    timestamp:     new Date().toISOString(),
  }));

  /* Toast notification */
  if (outcome === 'success') showToast('Payment sent successfully!', 'success');
  else if (outcome === 'pending') showToast('Payment pending confirmation.', 'info');
  else showToast('Payment failed. Please try again.', 'danger');
}

/* ── Processing screen (while waiting) ── */
function showProcessing() {
  const iconEl  = document.getElementById('result-icon');
  const titleEl = document.getElementById('result-title');
  const subEl   = document.getElementById('result-sub');
  const txnBox  = document.getElementById('result-txn-box');
  const actions = document.getElementById('result-actions');
  if (iconEl)  iconEl.textContent  = '⌛';
  if (titleEl) titleEl.textContent = 'Processing Payment…';
  if (subEl)   subEl.textContent   = 'Please wait while we securely process your transfer.';
  if (txnBox)  txnBox.style.display  = 'none';
  if (actions) actions.style.display = 'none';
}

/* ═══════════════════════════════════════════════════════════
   STEP INDICATOR
═══════════════════════════════════════════════════════════ */

function setStep(n) {
  currentStep = n;

  /* Show/hide step panels */
  document.getElementById('step-details')?.style && (document.getElementById('step-details').style.display = n === 1 ? '' : 'none');
  document.getElementById('step-review')?.style  && (document.getElementById('step-review').style.display  = n === 2 ? '' : 'none');
  document.getElementById('step-result')?.style  && (document.getElementById('step-result').style.display  = n === 3 ? '' : 'none');

  /* Update dots */
  for (let i = 1; i <= 3; i++) {
    const dot = document.getElementById(`dot-${i}`);
    const lbl = document.getElementById(`lbl-${i}`);
    if (!dot || !lbl) continue;
    dot.className = 'si-dot' + (i < n ? ' done' : i === n ? ' active' : '');
    lbl.className = 'si-label' + (i < n ? ' done' : i === n ? ' active' : '');
    if (i < n) dot.textContent = '✓';
    else dot.textContent = String(i);
  }

  /* Update lines */
  for (let i = 1; i <= 2; i++) {
    const line = document.getElementById(`line-${i}`);
    if (line) line.className = 'si-line' + (i < n ? ' done' : '');
  }

  /* Scroll to top */
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ═══════════════════════════════════════════════════════════
   SAVE TRANSACTION TO LOCALSTORAGE
═══════════════════════════════════════════════════════════ */

function saveTransaction({ outcome, txnId, amount, corridor, cfg, recipient, account, total, method }) {
  if (!currentUser) return;
  const email = localStorage.getItem(LS_CURRENT);
  if (!email) return;

  let users = {};
  try { users = JSON.parse(localStorage.getItem(LS_USERS) || '{}'); } catch (e) {}

  const user = users[email];
  if (!user) return;

  if (!Array.isArray(user.transactions)) user.transactions = [];

  const txn = {
    id:          txnId,
    checkoutId:  session.checkoutId,
    corridor,
    corridorLabel: cfg.label,
    amount:      Number(amount),
    total:       Number(total),
    currency:    corridor.split('-')[0],
    recipient,
    account,
    method:      selectedMethod,
    methodName:  method.name || selectedMethod,
    status:      outcome,
    fee:         (method.fee || 0),
    geo:         cfg.geo,
    country:     cfg.country,
    device:      session.device,
    createdAt:   new Date().toISOString(),
  };

  user.transactions.unshift(txn);

  /* Update user metrics */
  if (outcome === 'success') {
    user.successfulPayments = (user.successfulPayments || 0) + 1;
    user.totalSent          = (user.totalSent || 0) + Number(amount);
  }

  /* Save back */
  users[email] = user;
  try {
    localStorage.setItem(LS_USERS, JSON.stringify(users));
  } catch (e) { /* storage full or unavailable */ }
}

/* ═══════════════════════════════════════════════════════════
   NAVIGATION
═══════════════════════════════════════════════════════════ */

window.goBack = function () {
  /* Clear abandon tracking before intentional navigation */
  window._paymentCompleted = true;
  sessionStorage.removeItem(SS_SESSION);
  window.location.href = 'index.html';
};

window.sendAnother = function () {
  /* Reset state */
  selectedMethod = null;
  currentStep    = 1;
  document.getElementById('amount-input')     && (document.getElementById('amount-input').value = '');
  document.getElementById('recipient-name')   && (document.getElementById('recipient-name').value = '');
  document.getElementById('recipient-account')&& (document.getElementById('recipient-account').value = '');
  setStep(1);
  renderMethods();

  /* New checkout ID */
  if (session) {
    session.checkoutId = 'chk_' + Math.random().toString(36).slice(2, 10);
    session.startedAt  = new Date().toISOString();
    sessionStorage.setItem(SS_SESSION, JSON.stringify(session));
  }
};

/* ═══════════════════════════════════════════════════════════
   ANALYTICS HELPERS
═══════════════════════════════════════════════════════════ */

function trackPageView() {
  if (!session) return;
  safeTrack(() => {
    analytics.page('Payment Page', {
      merchantId:     session.userId,
      checkoutId:     session.checkoutId,
      corridor:       session.corridor,
      corridorLabel:  session.corridorLabel,
      geo:            session.geo,
      country:        session.country,
      device:         session.device,
      preferredMethod: session.preferredMethod,
      isMobileFlow:   session.isMobile,
      timestamp:      new Date().toISOString(),
    });
  });

  /* Payment Page Viewed (track event in addition to page) */
  safeTrack(() => analytics.track('Payment Page Viewed', {
    merchantId:     session.userId,
    checkoutId:     session.checkoutId,
    corridor:       session.corridor,
    corridorLabel:  session.corridorLabel,
    geo:            session.geo,
    country:        session.country,
    device:         session.device,
    preferredMethod: session.preferredMethod,
    isMobileFlow:   session.isMobile,
    churnRisk:      session.churnRisk,
    trustScore:     session.trustScore,
    timestamp:      new Date().toISOString(),
  }));
}

function registerAbandonTracking() {
  window.addEventListener('beforeunload', () => {
    if (window._paymentCompleted || currentStep === 3) return;
    safeTrack(() => analytics.track('Checkout Abandoned', {
      merchantId:    session?.userId,
      checkoutId:    session?.checkoutId,
      corridor:      session?.corridor,
      geo:           session?.geo,
      country:       session?.country,
      device:        session?.device,
      method:        selectedMethod,
      lastStep:      currentStep,
      abandonedAt:   new Date().toISOString(),
    }));
  });
}

/* Wraps analytics calls so errors never surface to user */
function safeTrack(fn) {
  try { fn(); } catch (e) { /* silent */ }
}

/* ═══════════════════════════════════════════════════════════
   UI UTILITIES
═══════════════════════════════════════════════════════════ */

function showErr(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || el.textContent;
  el.classList.add('show');
}

function hideErr(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('show');
}

function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className   = `toast ${type} show`;
  setTimeout(() => { el.className = 'toast'; }, 3800);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

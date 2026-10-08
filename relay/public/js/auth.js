/**
 * NXTslide Auth & Billing Client
 * Handles Google Sign-In, session persistence, and Razorpay checkout
 * for the Electron PC dashboard.
 */

(function () {
  'use strict';

  const RELAY_BASE = (typeof window !== 'undefined' && window.location && (window.location.hostname.includes('nxtslide.online') || window.location.hostname.includes('render.com')))
    ? window.location.origin
    : 'https://nxtslide.online';

  // ─── State ──────────────────────────────────────────────────────────────────
  let currentUser = null;

  // ─── DOM Helpers ────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  // ─── Session Persistence (localStorage + Bearer Token) ──────────────────────
  function saveUserLocally(user) {
    if (!user) return;
    try {
      localStorage.setItem('nxtslide_user', JSON.stringify(user));
      if (user.token) localStorage.setItem('nxtslide_auth_token', user.token);
    } catch (e) {}
  }

  function loadUserLocally() {
    try {
      const u = JSON.parse(localStorage.getItem('nxtslide_user') || 'null');
      if (u && !u.token) {
        u.token = localStorage.getItem('nxtslide_auth_token') || null;
      }
      return u;
    } catch (e) { return null; }
  }

  function loadTokenLocally() {
    try {
      return localStorage.getItem('nxtslide_auth_token') || (loadUserLocally()?.token) || null;
    } catch (e) { return null; }
  }

  function clearUserLocally() {
    try {
      localStorage.removeItem('nxtslide_user');
      localStorage.removeItem('nxtslide_auth_token');
    } catch (e) {}
  }

  // ─── Fetch current user from relay (supports Bearer token) ──────────────────
  async function fetchMe() {
    const token = loadTokenLocally();
    try {
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${RELAY_BASE}/api/auth/me`, {
        credentials: 'include',
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        if (token) data.token = token;
        return data;
      }
    } catch (e) {}
    return null;
  }

  // ─── Trial Countdown Timer & Logic ─────────────────────────────────────────
  let trialInterval = null;

  function stopTrialCountdown() {
    if (trialInterval) {
      clearInterval(trialInterval);
      trialInterval = null;
    }
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function startTrialCountdown(expiresAt) {
    stopTrialCountdown();
    if (!expiresAt) return;

    function tick() {
      const now = Date.now();
      const end = new Date(expiresAt).getTime();
      const diffSec = Math.max(0, Math.floor((end - now) / 1000));

      const badgeCountdown = $('auth-trial-countdown');
      const modalActiveTime = $('modal-trial-active-time');
      const timeStr = formatTime(diffSec);

      if (badgeCountdown) badgeCountdown.textContent = timeStr + ' left';
      if (modalActiveTime) modalActiveTime.textContent = timeStr;

      if (diffSec <= 0) {
        stopTrialCountdown();
        if (currentUser && (currentUser.isTrial || currentUser.trial?.active)) {
          console.log('[Auth] 30-min trial session ended.');
          if (badgeCountdown) badgeCountdown.textContent = 'Expired';
          if (modalActiveTime) modalActiveTime.textContent = '00:00';
          refreshAuthState().then(() => {
            alert('⏱️ Your free 30-minute demo has ended. Upgrade to Lifetime Pro (₹89) anytime to keep using Cloud Relay!');
          });
        }
      }
    }

    tick();
    trialInterval = setInterval(tick, 1000);
  }

  // ─── Activate Google ID One-Time 30-Min Demo ────────────────────────────────
  async function activateGoogleTrial() {
    if (!currentUser || !currentUser.email) {
      alert('Please sign in with your Google account first to activate your one-time 30-minute free demo.');
      openGoogleSignIn();
      return;
    }

    const activateBtns = [
      $('btnActivateGoogleTrial'),
      $('auth-start-trial-btn'),
      $('account-modal-start-trial-btn')
    ].filter(Boolean);

    activateBtns.forEach(btn => {
      btn.disabled = true;
      btn.dataset.prevHtml = btn.innerHTML;
      btn.innerHTML = '<span>⏳</span> <span>Activating Demo...</span>';
    });

    try {
      const token = loadTokenLocally();
      const isDesktop = !(typeof window !== 'undefined' && window.location && (window.location.hostname.includes('nxtslide.online') || window.location.hostname.includes('render.com')));

      let endpoint = '/api/auth/start-trial';
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // If running directly on web dashboard, call relay base
      if (!isDesktop) {
        endpoint = `${RELAY_BASE}/api/auth/start-trial`;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers
      });

      const data = await res.json();

      if (res.ok && data.success) {
        currentUser = {
          ...currentUser,
          isPro: true,
          isTrial: true,
          trialStartedAt: data.trialStartedAt || new Date().toISOString(),
          trialExpiresAt: data.trialExpiresAt,
          trial: data.trial || { active: true, eligible: false, used: true, remainingSeconds: data.remainingSeconds || 1800 }
        };
        saveUserLocally(currentUser);
        localStorage.setItem('nxtslide_pro_unlocked', 'true');

        renderAuthUI(currentUser);
        updateLegacyLicenseUI(currentUser);

        // Close modals
        const proModal = $('proModalBackdrop');
        if (proModal) proModal.style.display = 'none';
        const accModal = $('accountModalBackdrop');
        if (accModal) accModal.style.display = 'none';

        // Switch to cloud mode if dashboard switchMode exists
        if (typeof window.switchMode === 'function') {
          window.switchMode('cloud');
        } else if (typeof switchMode === 'function') {
          switchMode('cloud');
        }

        // Refresh QR / Relay UI
        try {
          const infoRes = await fetch('/api/info');
          const infoData = await infoRes.json();
          const cloudQr = $('cloudQrCodeImg');
          if (cloudQr && infoData.cloudQrDataUrl) cloudQr.src = infoData.cloudQrDataUrl;
          if (typeof updateRelayUI === 'function') updateRelayUI(infoData.relay);
        } catch (_) {}

        alert(data.message || '🎉 Your 30-Minute Free Demo is now active! Cloud Relay & Multi-Presenter are unlocked.');
      } else {
        alert(data.error || 'Could not start free trial.');
        await refreshAuthState();
      }
    } catch (err) {
      console.error('[Auth] Trial activation error:', err);
      alert('Error activating trial: ' + err.message);
    } finally {
      activateBtns.forEach(btn => {
        btn.disabled = false;
        if (btn.dataset.prevHtml) btn.innerHTML = btn.dataset.prevHtml;
      });
    }
  }

  // ─── Update the UI based on auth state ────────────────────────────────────
  function renderAuthUI(user) {
    const signedInEl       = $('auth-signed-in');
    const signedOutEl      = $('auth-signed-out');
    const userNameEl       = $('auth-user-name');
    const userEmailEl      = $('auth-user-email');
    const userAvatarEl     = $('auth-user-avatar');
    const proBadgeEl       = $('auth-pro-badge');
    const trialBadgeEl     = $('auth-trial-badge');
    const startTrialBtn    = $('auth-start-trial-btn');
    const upgradeBtn       = $('auth-upgrade-btn');

    if (signedInEl && signedOutEl) {
      if (user) {
        signedOutEl.style.display = 'none';
        signedInEl.style.display  = 'flex';

        if (userNameEl)  userNameEl.textContent  = user.name || user.email;
        if (userEmailEl) userEmailEl.textContent = user.email;
        if (userAvatarEl) {
          if (user.avatar) {
            userAvatarEl.src   = user.avatar;
            userAvatarEl.style.display = 'block';
          } else {
            userAvatarEl.style.display = 'none';
          }
        }

        const isTrialActive = !!(user.isTrial || (user.trial && user.trial.active) || (user.trialExpiresAt && new Date(user.trialExpiresAt) > new Date()));
        const isTrialEligible = !isTrialActive && !user.isPro && (user.trial ? user.trial.eligible : !user.trialUsed);
        const isPaidPro = !!(user.isPro && !isTrialActive);

        if (isTrialActive) {
          if (trialBadgeEl)  trialBadgeEl.style.display  = 'inline-flex';
          if (proBadgeEl)    proBadgeEl.style.display    = 'none';
          if (startTrialBtn) startTrialBtn.style.display = 'none';
          if (upgradeBtn)    upgradeBtn.style.display    = 'inline-flex';
          startTrialCountdown(user.trialExpiresAt);
        } else if (isTrialEligible) {
          if (trialBadgeEl)  trialBadgeEl.style.display  = 'none';
          if (proBadgeEl)    proBadgeEl.style.display    = 'none';
          if (startTrialBtn) startTrialBtn.style.display = 'inline-flex';
          if (upgradeBtn)    upgradeBtn.style.display    = 'none';
          stopTrialCountdown();
        } else if (isPaidPro) {
          if (trialBadgeEl)  trialBadgeEl.style.display  = 'none';
          if (proBadgeEl)    proBadgeEl.style.display    = 'inline-flex';
          if (startTrialBtn) startTrialBtn.style.display = 'none';
          if (upgradeBtn)    upgradeBtn.style.display    = 'none';
          stopTrialCountdown();
        } else {
          // Free tier, trial already used
          if (trialBadgeEl)  trialBadgeEl.style.display  = 'none';
          if (proBadgeEl)    proBadgeEl.style.display    = 'none';
          if (startTrialBtn) startTrialBtn.style.display = 'none';
          if (upgradeBtn)    upgradeBtn.style.display    = 'inline-flex';
          stopTrialCountdown();
        }

        const adminBtn = $('auth-admin-btn');
        const isAdmin = !!(user && (user.isAdmin || (user.email && user.email.toLowerCase() === 'dilpreetsinghverma@gmail.com')));
        if (adminBtn) adminBtn.style.display = isAdmin ? 'inline-flex' : 'none';
      } else {
        signedInEl.style.display  = 'none';
        signedOutEl.style.display = 'flex';
        const adminBtn = $('auth-admin-btn');
        if (adminBtn) adminBtn.style.display = 'none';
        if (trialBadgeEl)  trialBadgeEl.style.display  = 'none';
        if (startTrialBtn) startTrialBtn.style.display = 'none';
        stopTrialCountdown();
      }
    }

    // Also update upgrade modal and account modal
    updateModalCta(user);
    updateAccountModalUI(user);
    if (typeof updateProBadge === 'function') updateProBadge();
  }

  // ─── Account Modal UI Helpers ─────────────────────────────────────────────
  function updateAccountModalUI(user) {
    const avatarEl   = $('account-modal-avatar');
    const nameEl     = $('account-modal-name');
    const emailEl    = $('account-modal-email');
    const badgeEl    = $('account-modal-plan-badge');
    const detailEl   = $('account-modal-details');
    const upBtn      = $('account-modal-upgrade-btn');
    const trialBox   = $('account-modal-trial-box');

    if (!nameEl) return;

    if (user) {
      nameEl.textContent = user.name || user.email || 'My Account';
      if (emailEl) emailEl.textContent = user.email || '';
      if (avatarEl) {
        if (user.avatar) {
          avatarEl.src = user.avatar;
          avatarEl.style.display = 'block';
        } else {
          avatarEl.style.display = 'none';
        }
      }

      const isTrialActive = !!(user.isTrial || (user.trial && user.trial.active) || (user.trialExpiresAt && new Date(user.trialExpiresAt) > new Date()));
      const isTrialEligible = !isTrialActive && !user.isPro && (user.trial ? user.trial.eligible : !user.trialUsed);
      const isPaidPro = !!(user.isPro && !isTrialActive);

      if (badgeEl) {
        if (isTrialActive) {
          badgeEl.textContent = '⏱️ 30-MIN FREE DEMO';
          badgeEl.style.background = 'rgba(34,197,94,0.18)';
          badgeEl.style.color = '#4ade80';
          badgeEl.style.border = '1px solid rgba(34,197,94,0.4)';
        } else if (isPaidPro) {
          badgeEl.textContent = '✦ PRO ACTIVE';
          badgeEl.style.background = 'rgba(34,197,94,0.15)';
          badgeEl.style.color = '#4ade80';
          badgeEl.style.border = '1px solid rgba(34,197,94,0.35)';
        } else {
          badgeEl.textContent = 'Free Plan';
          badgeEl.style.background = 'rgba(148,163,184,0.15)';
          badgeEl.style.color = '#94a3b8';
          badgeEl.style.border = '1px solid rgba(148,163,184,0.3)';
        }
      }

      if (detailEl) {
        if (isTrialActive) {
          const expTime = user.trialExpiresAt ? new Date(user.trialExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '30 mins';
          detailEl.innerHTML = `<strong>30-Minute Free Demo Active</strong> &bull; Ends at: ${expTime}<br><span style="color:#94a3b8;font-size:0.75rem;">Global Cloud Relay and multi-presenter unlocked. Upgrade anytime to keep forever.</span>`;
        } else if (isPaidPro) {
          const exp = user.subscriptionExpiresAt
            ? new Date(user.subscriptionExpiresAt).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })
            : 'Lifetime';
          detailEl.innerHTML = `<strong>Active Pro Subscription</strong> &bull; Valid: ${exp}<br><span style="color:#94a3b8;font-size:0.75rem;">Global Cloud Relay and multi-presenter enabled.</span>`;
        } else if (isTrialEligible) {
          detailEl.innerHTML = `Standard local Wi-Fi mode.<br><span style="color:#a5b4fc;font-size:0.75rem;font-weight:600;">🎁 You have a free 30-minute demo ready to activate anytime!</span>`;
        } else {
          detailEl.innerHTML = `Standard local Wi-Fi mode active.<br><span style="color:#94a3b8;font-size:0.75rem;">Upgrade to Pro (₹89) to present from anywhere via global cloud relay.</span>`;
        }
      }

      if (trialBox) trialBox.style.display = isTrialEligible ? 'block' : 'none';
      if (upBtn) upBtn.style.display = isPaidPro ? 'none' : 'block';

      const modalAdminBtn = $('account-modal-admin-btn');
      const isAdmin = !!(user && (user.isAdmin || (user.email && user.email.toLowerCase() === 'dilpreetsinghverma@gmail.com')));
      if (modalAdminBtn) modalAdminBtn.style.display = isAdmin ? 'block' : 'none';
    } else {
      nameEl.textContent = 'Guest';
      if (emailEl) emailEl.textContent = 'Not signed in';
      if (avatarEl) avatarEl.style.display = 'none';
      if (badgeEl) {
        badgeEl.textContent = 'Free Plan';
        badgeEl.style.background = 'rgba(148,163,184,0.15)';
        badgeEl.style.color = '#94a3b8';
        badgeEl.style.border = '1px solid rgba(148,163,184,0.3)';
      }
      if (detailEl) detailEl.textContent = 'Sign in with Google to get your free 30-minute demo or sync your subscription.';
      if (trialBox) trialBox.style.display = 'none';
      if (upBtn) upBtn.style.display = 'none';

      const modalAdminBtn = $('account-modal-admin-btn');
      if (modalAdminBtn) modalAdminBtn.style.display = 'none';
    }
  }

  function openAccountModal() {
    if (!currentUser) {
      openGoogleSignIn();
      return;
    }
    updateAccountModalUI(currentUser);
    const m = $('accountModalBackdrop');
    if (m) m.style.display = 'flex';
  }

  function closeAccountModal() {
    const m = $('accountModalBackdrop');
    if (m) m.style.display = 'none';
  }

  // ─── Google Sign-In — desktop or web ────────────────────────────────────────
  function openGoogleSignIn() {
    const isDesktop = !!(window.electronAPI && window.electronAPI.openExternal);
    const signInUrl = isDesktop
      ? `${RELAY_BASE}/api/auth/google?redirect=nxtslide://auth`
      : `${RELAY_BASE}/api/auth/google?redirect=${encodeURIComponent(window.location.href)}`;

    if (isDesktop) {
      window.electronAPI.openExternal(signInUrl);
    } else {
      // In web browser: navigate to Google OAuth
      window.location.href = signInUrl;
    }
  }

  // ─── Logout ────────────────────────────────────────────────────────────────
  async function logout() {
    const token = loadTokenLocally();
    try {
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(`${RELAY_BASE}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers,
      });
    } catch (e) {}
    currentUser = null;
    clearUserLocally();
    renderAuthUI(null);
    updateLegacyLicenseUI(null);
  }

  // ─── Refresh auth state from relay ────────────────────────────────────────
  async function refreshAuthState() {
    const cached = loadUserLocally();
    if (cached) {
      currentUser = cached;
      renderAuthUI(cached);
      updateLegacyLicenseUI(cached);
    }

    const user = await fetchMe();
    if (user) {
      currentUser = user;
      saveUserLocally(user);
      renderAuthUI(user);
      updateLegacyLicenseUI(user);
      return user;
    }

    // Do NOT wipe cached user if offline or network hiccup
    if (!cached) {
      renderAuthUI(null);
      updateLegacyLicenseUI(null);
    }
    return currentUser;
  }

  // ─── Razorpay Checkout ────────────────────────────────────────────────────
  async function startProUpgrade(customAmountPaise, customDesc) {
    if (!currentUser) {
      openGoogleSignIn();
      return;
    }

    try {
      const token = loadTokenLocally();
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const bodyPayload = {};
      if (customAmountPaise) bodyPayload.amount = customAmountPaise;
      if (customDesc) bodyPayload.sponsorType = customDesc;

      // 1. Create order on relay server
      const res = await fetch(`${RELAY_BASE}/api/billing/subscribe`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        const err = await res.json();
        alert('Could not start payment: ' + (err.error || 'Unknown error'));
        return;
      }

      const order = await res.json();

      // 2. Load Razorpay script if not loaded
      if (!window.Razorpay) {
        await loadScript('https://checkout.razorpay.com/v1/checkout.js');
      }

      // 3. Open Razorpay checkout
      const rzp = new window.Razorpay({
        key:         order.key,
        amount:      order.amount,
        currency:    order.currency || 'INR',
        name:        'NXTslide',
        description: customDesc || 'Lifetime Pro Plan – Early Bird (1-time payment)',
        order_id:    order.orderId,
        prefill: {
          name:  order.user?.name  || '',
          email: order.user?.email || '',
        },
        theme: { color: '#22c55e' },
        handler: async function (response) {
          console.log('[Auth] Payment success:', response.razorpay_payment_id);
          try {
            const token = loadTokenLocally();
            const verifyHeaders = { 'Content-Type': 'application/json' };
            if (token) verifyHeaders['Authorization'] = `Bearer ${token}`;

            const vRes = await fetch(`${RELAY_BASE}/api/billing/verify`, {
              method: 'POST',
              headers: verifyHeaders,
              body: JSON.stringify({
                orderId:   response.razorpay_order_id,
                paymentId: response.razorpay_payment_id,
                signature: response.razorpay_signature,
                amount:    order.amount,
                email:     currentUser?.email || order.user?.email || ''
              })
            });
            if (vRes.ok) {
              const vData = await vRes.json();
              if (vData.token) localStorage.setItem('nxtslide_auth_token', vData.token);
              if (vData.user) saveUserLocally(vData.user);
            }
          } catch (e) {
            console.warn('[Auth] Direct verification warning:', e);
          }

          // Trigger local desktop server to connect to cloud relay if running locally
          try {
            await fetch('/api/relay/connect', { method: 'POST' });
          } catch (_) {}

          await refreshAuthState();
          alert('🎉 Thank you so much for supporting NXTslide! Lifetime Pro has been activated on your account.');
          window.location.reload();
        },
      });

      rzp.on('payment.failed', function (response) {
        console.error('[Auth] Payment failed:', response.error);
        alert('Payment failed: ' + (response.error?.description || 'Unknown error'));
      });

      rzp.open();
    } catch (err) {
      console.error('[Auth] Upgrade error:', err);
      alert('Error starting payment. Please try again.');
    }
  }

  // ─── Script loader ────────────────────────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // ─── Legacy License UI bridge ────────────────────────────────────────────
  // Updates old license-key UI elements if they exist, so the dashboard
  // shows the correct plan even if it hasn't been fully redesigned yet.
  function updateLegacyLicenseUI(user) {
    const licenseSection = $('license-section');
    const licenseStatus  = $('license-status');
    const proFeatures    = document.querySelectorAll('.pro-only');

    if (user && user.isPro) {
      if (licenseSection) licenseSection.style.display = 'none';
      if (licenseStatus) {
        licenseStatus.textContent = `✅ Pro Active • ${user.email}`;
        licenseStatus.style.color = '#4ade80';
      }
      proFeatures.forEach(el => el.classList.remove('locked'));
    } else {
      if (licenseSection) licenseSection.style.display = 'block';
      if (licenseStatus)  licenseStatus.textContent = '';
      proFeatures.forEach(el => el.classList.add('locked'));
    }
  }

  // ─── Handle Electron deep-link callback (nxtslide://auth?token=...&user=...) ───
  window.nxtslideHandleAuthCallback = async function (userDataBase64, directToken) {
    try {
      const userData = JSON.parse(atob(userDataBase64));
      if (directToken) userData.token = directToken;
      currentUser = userData;
      saveUserLocally(userData);
      renderAuthUI(userData);
      updateLegacyLicenseUI(userData);
      console.log('[Auth] Logged in successfully:', userData.email, 'Pro:', userData.isPro);
    } catch (e) {
      console.error('[Auth] Failed to parse auth callback:', e);
    }
  };

  // ─── Public API ──────────────────────────────────────────────────────────
  window.NXTAuth = {
    signIn:        openGoogleSignIn,
    signOut:       logout,
    upgrade:       startProUpgrade,
    startTrial:    activateGoogleTrial,
    refresh:       refreshAuthState,
    openAccount:   openAccountModal,
    closeAccount:  closeAccountModal,
    getCurrentUser: () => currentUser,
    isPro:         () => !!(currentUser && (currentUser.isPro || (currentUser.trial && currentUser.trial.active))),
  };

  // ─── Init ────────────────────────────────────────────────────────────────
  async function init() {
    // 0. Extract ?token=...&user=... if present in URL (e.g. returned from web Google OAuth)
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const qToken = urlParams.get('token');
      const qUser  = urlParams.get('user');
      if (qToken && qUser) {
        const parsedUser = JSON.parse(atob(qUser));
        parsedUser.token = qToken;
        saveUserLocally(parsedUser);
        currentUser = parsedUser;
        const cleanUrl = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, cleanUrl);
        console.log('[Auth] Logged in via URL callback:', parsedUser.email);
      }
    } catch (e) {
      console.error('[Auth] Failed to parse URL auth callback:', e);
    }

    // 1. Try cached user first for instant UI
    let cached = loadUserLocally();
    if (!cached) {
      try {
        const res = await fetch('/api/auth/cached-user');
        if (res.ok) {
          const d = await res.json();
          if (d && d.user) {
            cached = d.user;
            saveUserLocally(cached);
          }
        }
      } catch (_) {}
    }

    if (cached) {
      currentUser = cached;
      renderAuthUI(cached);
      updateLegacyLicenseUI(cached);
    }

    // 2. Verify with server
    await refreshAuthState();

    // Check for pending sponsor upgrade (e.g. user clicked Sponsor tier before OAuth login)
    try {
      const pendingSponsor = sessionStorage.getItem('pending_sponsor_upgrade');
      if (pendingSponsor && currentUser) {
        sessionStorage.removeItem('pending_sponsor_upgrade');
        const pData = JSON.parse(pendingSponsor);
        setTimeout(() => {
          startProUpgrade(pData.amount, pData.desc);
        }, 600);
      }
    } catch (_) {}

    // 3. Wire up header buttons
    const signInBtn       = $('auth-google-signin-btn');
    const signOutBtn      = $('auth-signout-btn');
    const upgradeBtn      = $('auth-upgrade-btn');
    const accountBtn      = $('auth-account-btn');
    const userPill        = $('auth-user-pill');
    const startTrialBtn   = $('auth-start-trial-btn');
    const trialBadge      = $('auth-trial-badge');

    if (signInBtn)     signInBtn.addEventListener('click',     openGoogleSignIn);
    if (signOutBtn)    signOutBtn.addEventListener('click',    logout);
    if (upgradeBtn)    upgradeBtn.addEventListener('click',    startProUpgrade);
    if (accountBtn)    accountBtn.addEventListener('click',    openAccountModal);
    if (userPill)      userPill.addEventListener('click',      openAccountModal);
    if (startTrialBtn) startTrialBtn.addEventListener('click', activateGoogleTrial);
    if (trialBadge)    trialBadge.addEventListener('click',    openAccountModal);

    // 4. Wire up Account Modal buttons
    const closeAccBtn          = $('closeAccountModalBtn');
    const accModalBackdrop     = $('accountModalBackdrop');
    const accUpgradeBtn        = $('account-modal-upgrade-btn');
    const accRefreshBtn        = $('account-modal-refresh-btn');
    const accSignoutBtn        = $('account-modal-signout-btn');
    const accStartTrialBtn     = $('account-modal-start-trial-btn');

    if (closeAccBtn)      closeAccBtn.addEventListener('click', closeAccountModal);
    if (accModalBackdrop) {
      accModalBackdrop.addEventListener('click', (e) => {
        if (e.target === accModalBackdrop) closeAccountModal();
      });
    }
    if (accUpgradeBtn) {
      accUpgradeBtn.addEventListener('click', () => {
        closeAccountModal();
        startProUpgrade();
      });
    }
    if (accStartTrialBtn) {
      accStartTrialBtn.addEventListener('click', activateGoogleTrial);
    }
    if (accRefreshBtn) {
      accRefreshBtn.addEventListener('click', async () => {
        accRefreshBtn.disabled = true;
        accRefreshBtn.innerHTML = '<span>⏳</span> <span>Refreshing...</span>';
        const u = await refreshAuthState();
        updateAccountModalUI(u);
        accRefreshBtn.disabled = false;
        accRefreshBtn.innerHTML = '<span>✅</span> <span>Account Synced!</span>';
        setTimeout(() => {
          accRefreshBtn.innerHTML = '<span>🔄</span> <span>Refresh Account Status</span>';
        }, 2000);
      });
    }
    if (accSignoutBtn) {
      accSignoutBtn.addEventListener('click', () => {
        closeAccountModal();
        logout();
      });
    }
  }

  // Update modal UI based on sign-in state
  function updateModalCta(user) {
    const signedOutCta   = $('modal-signed-out-cta');
    const signedInCta    = $('modal-signed-in-cta');
    const modalEmail     = $('modal-user-email');
    const modalPayBtn    = $('modal-pay-btn');
    const trialEligible  = $('modal-trial-eligible-box');
    const trialActive    = $('modal-trial-active-box');
    const trialUsed      = $('modal-trial-used-box');

    if (!signedOutCta || !signedInCta) return;

    if (user) {
      signedOutCta.style.display = 'none';
      signedInCta.style.display  = 'block';
      if (modalEmail) modalEmail.textContent = user.email;

      const isTrialActive = !!(user.isTrial || (user.trial && user.trial.active) || (user.trialExpiresAt && new Date(user.trialExpiresAt) > new Date()));
      const isTrialEligible = !isTrialActive && !user.isPro && (user.trial ? user.trial.eligible : !user.trialUsed);
      const isPaidPro = !!((user.isPro && !isTrialActive) || (user.email && user.email.toLowerCase() === 'dilpreetsinghverma@gmail.com'));

      if (trialEligible) trialEligible.style.display = isTrialEligible ? 'block' : 'none';
      if (trialActive)   trialActive.style.display   = isTrialActive ? 'block' : 'none';
      if (trialUsed)     trialUsed.style.display     = (!isTrialActive && !isPaidPro && !isTrialEligible) ? 'block' : 'none';

      if (modalPayBtn) {
        if (isPaidPro) {
          modalPayBtn.innerHTML = '✅ Lifetime Pro Active — Cloud Relay Unlocked';
          modalPayBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
          modalPayBtn.onclick = function() {
            const m = $('proModalBackdrop');
            if (m) m.style.display = 'none';
            if (typeof switchMode === 'function') switchMode('cloud');
          };
        } else if (isTrialActive) {
          modalPayBtn.innerHTML = '✦ Upgrade to Lifetime Pro — ₹89 (Keep Forever)';
          modalPayBtn.style.background = '';
          modalPayBtn.onclick = () => startProUpgrade();
        } else if (isTrialEligible) {
          modalPayBtn.innerHTML = '✦ Or Unlock Lifetime Pro Directly — ₹89 Only';
          modalPayBtn.style.background = '';
          modalPayBtn.onclick = () => startProUpgrade();
        } else {
          modalPayBtn.innerHTML = '✦ Unlock Lifetime Pro — ₹89 Only';
          modalPayBtn.style.background = '';
          modalPayBtn.onclick = () => startProUpgrade();
        }
      }
    } else {
      signedOutCta.style.display = 'block';
      signedInCta.style.display  = 'none';
      if (trialEligible) trialEligible.style.display = 'none';
      if (trialActive)   trialActive.style.display   = 'none';
      if (trialUsed)     trialUsed.style.display     = 'none';
    }
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Wire upgrade modal buttons after DOM load
  function wireModalButtons() {
    const modalSignInBtn   = $('modal-google-signin-btn');
    const modalPayBtn      = $('modal-pay-btn');
    const modalTrialBtn    = $('btnActivateGoogleTrial');

    if (modalSignInBtn) modalSignInBtn.addEventListener('click', openGoogleSignIn);
    if (modalPayBtn)    modalPayBtn.addEventListener('click', startProUpgrade);
    if (modalTrialBtn)  modalTrialBtn.addEventListener('click', activateGoogleTrial);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireModalButtons);
  } else {
    wireModalButtons();
  }

})();

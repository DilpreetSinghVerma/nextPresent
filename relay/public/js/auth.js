/**
 * NXTslide Auth & Billing Client
 * Handles Google Sign-In, session persistence, and Razorpay checkout
 * for the Electron PC dashboard.
 */

(function () {
  'use strict';

  const RELAY_BASE = 'https://nextpresent-relay.onrender.com';

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

  // ─── Update the UI based on auth state ────────────────────────────────────
  function renderAuthUI(user) {
    const signedInEl  = $('auth-signed-in');
    const signedOutEl = $('auth-signed-out');
    const userNameEl  = $('auth-user-name');
    const userEmailEl = $('auth-user-email');
    const userAvatarEl = $('auth-user-avatar');
    const proBadgeEl  = $('auth-pro-badge');
    const upgradeBtn  = $('auth-upgrade-btn');

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
        if (proBadgeEl)  proBadgeEl.style.display = user.isPro ? 'inline-flex' : 'none';
        if (upgradeBtn)  upgradeBtn.style.display  = user.isPro ? 'none' : 'inline-flex';

        const adminBtn = $('auth-admin-btn');
        const isAdmin = !!(user && (user.isAdmin || (user.email && user.email.toLowerCase() === 'dilpreetsinghverma@gmail.com')));
        if (adminBtn) adminBtn.style.display = isAdmin ? 'inline-flex' : 'none';
      } else {
        signedInEl.style.display  = 'none';
        signedOutEl.style.display = 'flex';
        const adminBtn = $('auth-admin-btn');
        if (adminBtn) adminBtn.style.display = 'none';
      }
    }

    // Also update upgrade modal and account modal
    updateModalCta(user);
    updateAccountModalUI(user);
  }

  // ─── Account Modal UI Helpers ─────────────────────────────────────────────
  function updateAccountModalUI(user) {
    const avatarEl = $('account-modal-avatar');
    const nameEl   = $('account-modal-name');
    const emailEl  = $('account-modal-email');
    const badgeEl  = $('account-modal-plan-badge');
    const detailEl = $('account-modal-details');
    const upBtn    = $('account-modal-upgrade-btn');

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
      if (badgeEl) {
        if (user.isPro) {
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
        if (user.isPro) {
          const exp = user.subscriptionExpiresAt
            ? new Date(user.subscriptionExpiresAt).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })
            : 'Active';
          detailEl.innerHTML = `<strong>Active Pro Subscription</strong> &bull; Valid until: ${exp}<br><span style="color:#94a3b8;font-size:0.75rem;">Global Cloud Relay and multi-presenter enabled.</span>`;
        } else {
          detailEl.innerHTML = `Standard local Wi-Fi mode active.<br><span style="color:#94a3b8;font-size:0.75rem;">Upgrade to Pro to present from anywhere via global cloud relay.</span>`;
        }
      }
      if (upBtn) upBtn.style.display = user.isPro ? 'none' : 'block';

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
      if (detailEl) detailEl.textContent = 'Sign in with Google to view and sync your subscription.';
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
  async function startProUpgrade() {
    if (!currentUser) {
      alert('Please sign in with Google first.');
      return;
    }

    try {
      const token = loadTokenLocally();
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // 1. Create order on relay server
      const res = await fetch(`${RELAY_BASE}/api/billing/subscribe`, {
        method: 'POST',
        credentials: 'include',
        headers,
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
        description: 'Lifetime Pro Plan – Early Bird (1-time payment)',
        order_id:    order.orderId,
        prefill: {
          name:  order.user?.name  || '',
          email: order.user?.email || '',
        },
        theme: { color: '#6366f1' },
        handler: async function (response) {
          // Payment success — refresh user plan
          console.log('[Auth] Payment success:', response.razorpay_payment_id);
          // Wait a moment for webhook to process
          await new Promise(r => setTimeout(r, 2000));
          await refreshAuthState();
          alert('🎉 Welcome to NXTslide Pro!');
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
    refresh:       refreshAuthState,
    openAccount:   openAccountModal,
    closeAccount:  closeAccountModal,
    getCurrentUser: () => currentUser,
    isPro:         () => !!(currentUser && currentUser.isPro),
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

    // 3. Wire up header buttons
    const signInBtn  = $('auth-google-signin-btn');
    const signOutBtn = $('auth-signout-btn');
    const upgradeBtn = $('auth-upgrade-btn');
    const accountBtn = $('auth-account-btn');
    const userPill   = $('auth-user-pill');

    if (signInBtn)  signInBtn.addEventListener('click',  openGoogleSignIn);
    if (signOutBtn) signOutBtn.addEventListener('click',  logout);
    if (upgradeBtn) upgradeBtn.addEventListener('click', startProUpgrade);
    if (accountBtn) accountBtn.addEventListener('click', openAccountModal);
    if (userPill)   userPill.addEventListener('click',   openAccountModal);

    // 4. Wire up Account Modal buttons
    const closeAccBtn = $('closeAccountModalBtn');
    const accModalBackdrop = $('accountModalBackdrop');
    const accUpgradeBtn = $('account-modal-upgrade-btn');
    const accRefreshBtn = $('account-modal-refresh-btn');
    const accSignoutBtn = $('account-modal-signout-btn');

    if (closeAccBtn) closeAccBtn.addEventListener('click', closeAccountModal);
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
    const signedOutCta = $('modal-signed-out-cta');
    const signedInCta  = $('modal-signed-in-cta');
    const modalEmail   = $('modal-user-email');
    if (!signedOutCta || !signedInCta) return;
    if (user) {
      signedOutCta.style.display = 'none';
      signedInCta.style.display  = 'block';
      if (modalEmail) modalEmail.textContent = user.email;
    } else {
      signedOutCta.style.display = 'block';
      signedInCta.style.display  = 'none';
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
    const modalSignInBtn = $('modal-google-signin-btn');
    const modalPayBtn    = $('modal-pay-btn');
    if (modalSignInBtn) modalSignInBtn.addEventListener('click', openGoogleSignIn);
    if (modalPayBtn)    modalPayBtn.addEventListener('click', startProUpgrade);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireModalButtons);
  } else {
    wireModalButtons();
  }

})();

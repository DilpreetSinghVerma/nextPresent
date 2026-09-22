/**
 * NXTslide Landing Page Interactive Engine
 */

document.addEventListener('DOMContentLoaded', () => {
  initNavBehavior();
  initSimulator();
  initFaqAccordion();
  initPlatformDownloadHighlight();
  initSmoothScroll();
  injectSlideAnimStyles();
});

function initNavBehavior() {
  const nav = document.getElementById('mainNav');
  if (!nav) return;
  const onScroll = () => {
    nav.classList.toggle('scrolled', window.scrollY > 20);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const hamburger = document.getElementById('navHamburger');
  const navLinks  = document.querySelector('.nav-links');
  if (hamburger && navLinks) {
    hamburger.addEventListener('click', () => {
      navLinks.classList.toggle('open');
    });
    // Close on link click
    navLinks.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => navLinks.classList.remove('open'));
    });
  }
}

function injectSlideAnimStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideInRight { from { opacity:0; transform:translateX(24px); } to { opacity:1; transform:translateX(0); } }
    @keyframes slideInLeft  { from { opacity:0; transform:translateX(-24px); } to { opacity:1; transform:translateX(0); } }
    .anim-next { animation: slideInRight 0.3s cubic-bezier(0.16,1,0.3,1) both; }
    .anim-prev { animation: slideInLeft  0.3s cubic-bezier(0.16,1,0.3,1) both; }
  `;
  document.head.appendChild(style);
}



// ─────────────────────────────────────────────────────────────────────────────
// Interactive Presentation Simulator Engine
// ─────────────────────────────────────────────────────────────────────────────
const SLIDES = [
  {
    tag: "Q3 Strategy Keynote",
    headline: "Scaling High-Performance Teams in 2026",
    detail: "How distributed autonomous teams deliver 10x output while maintaining radical clarity and zero overhead.",
    badge: "Slide 1 of 6"
  },
  {
    tag: "Engineering Architecture",
    headline: "Zero-Latency Realtime Protocol",
    detail: "Sub-5ms WebSocket synchronization paired with hardware-level system interrupt capture for instant tactile response.",
    badge: "Slide 2 of 6"
  },
  {
    tag: "Hardware Innovation",
    headline: "The Tactile Pocket Remote",
    detail: "Feel every slide change physically through your blazer pocket. No looking down. No broken audience eye contact.",
    badge: "Slide 3 of 6"
  },
  {
    tag: "Cloud Infrastructure",
    headline: "Global Relay & Firewall Traversal",
    detail: "Secure WebSockets connect host laptops and mobile companions across separate subnets, guest Wi-Fi, and 5G hotspots.",
    badge: "Slide 4 of 6"
  },
  {
    tag: "Market Traction",
    headline: "140,000+ Keynotes Delivered",
    detail: "Loved by keynote speakers, university professors, sales executives, and conference leads across 42 countries.",
    badge: "Slide 5 of 6"
  },
  {
    tag: "Summary & Launch",
    headline: "Never Carry a Dongle Again",
    detail: "Turn your smartphone into the ultimate invisible presentation remote. Instant setup, zero friction.",
    badge: "Slide 6 of 6"
  }
];

let currentSlideIdx = 0;
let totalClicks = 0;
let simTimerSeconds = 168; // simulated timer starting at ~02:48
let simTimerInterval = null;
let simMode = 'pocket'; // 'pocket' | 'laser' | 'hud'
let isSpotlightActive = false;
let isBlackoutActive = false;
const PROFILES = ['PowerPoint', 'Google Slides', 'Canva', 'Apple Keynote'];
let currentProfileIdx = 0;

function initSimulator() {
  const volUpBtn     = document.getElementById('simVolUp');
  const volDownBtn   = document.getElementById('simVolDown');
  const phoneNextBtn = document.getElementById('simPhoneNext');
  const phonePrevBtn = document.getElementById('simPhonePrev');

  if (volUpBtn)     volUpBtn.addEventListener('click', () => triggerSimulatorAction('NEXT', volUpBtn));
  if (volDownBtn)   volDownBtn.addEventListener('click', () => triggerSimulatorAction('PREV', volDownBtn));
  if (phoneNextBtn) phoneNextBtn.addEventListener('click', () => triggerSimulatorAction('NEXT', phoneNextBtn));
  if (phonePrevBtn) phonePrevBtn.addEventListener('click', () => triggerSimulatorAction('PREV', phonePrevBtn));

  // Mode Switcher Tabs
  const tabPocket = document.getElementById('tabModePocket');
  const tabLaser  = document.getElementById('tabModeLaser');
  const tabHUD    = document.getElementById('tabModeHUD');
  const padPocket = document.getElementById('simPadPocket');
  const padLaser  = document.getElementById('simPadLaser');
  const padHUD    = document.getElementById('simPadHUD');
  const simLaserDot = document.getElementById('simLaserDot');
  const simSpotlightMask = document.getElementById('simSpotlightMask');
  const simSlideMonitor = document.getElementById('simSlideMonitor');

  function setSimMode(mode) {
    simMode = mode;
    if (tabPocket) tabPocket.classList.toggle('active', mode === 'pocket');
    if (tabLaser)  tabLaser.classList.toggle('active', mode === 'laser');
    if (tabHUD)    tabHUD.classList.toggle('active', mode === 'hud');

    if (padPocket) padPocket.style.display = mode === 'pocket' ? 'flex' : 'none';
    if (padLaser)  padLaser.style.display  = mode === 'laser' ? 'flex' : 'none';
    if (padHUD)    padHUD.style.display    = mode === 'hud' ? 'flex' : 'none';

    if (simLaserDot) simLaserDot.style.display = mode === 'laser' ? 'block' : 'none';
    if (simSpotlightMask) simSpotlightMask.style.display = (mode === 'laser' && isSpotlightActive) ? 'block' : 'none';

    const keyInjectedEl = document.getElementById('simKeyInjected');
    if (keyInjectedEl) {
      if (mode === 'laser') keyInjectedEl.textContent = '3D Gyro Motion (X, Y)';
      else if (mode === 'hud') keyInjectedEl.textContent = 'Presentation HUD Controls';
      else keyInjectedEl.textContent = 'Right Arrow [→]';
    }
  }

  if (tabPocket) tabPocket.addEventListener('click', () => setSimMode('pocket'));
  if (tabLaser)  tabLaser.addEventListener('click', () => setSimMode('laser'));
  if (tabHUD)    tabHUD.addEventListener('click', () => setSimMode('hud'));

  // Laser Pointer Aiming on Touchpad or Slide Monitor
  const laserThumb = document.getElementById('simLaserThumb');

  function updateAim(relX, relY) {
    if (!simSlideMonitor || !simLaserDot) return;
    const monRect = simSlideMonitor.getBoundingClientRect();
    const clampedX = Math.max(12, Math.min(monRect.width - 12, relX * monRect.width));
    const clampedY = Math.max(12, Math.min(monRect.height - 12, relY * monRect.height));

    simLaserDot.style.left = `${clampedX}px`;
    simLaserDot.style.top  = `${clampedY}px`;

    if (simSpotlightMask) {
      simSpotlightMask.style.clipPath = `circle(85px at ${clampedX}px ${clampedY}px)`;
    }

    if (laserThumb && padLaser) {
      const padRect = padLaser.getBoundingClientRect();
      laserThumb.style.left = `${relX * padRect.width}px`;
      laserThumb.style.top  = `${relY * padRect.height}px`;
    }
  }

  if (padLaser) {
    const handlePadMove = (e) => {
      const rect = padLaser.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const relY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      updateAim(relX, relY);
    };
    padLaser.addEventListener('mousemove', handlePadMove);
    padLaser.addEventListener('touchmove', handlePadMove, { passive: true });
  }

  if (simSlideMonitor) {
    simSlideMonitor.addEventListener('mousemove', (e) => {
      if (simMode === 'laser') {
        const rect = simSlideMonitor.getBoundingClientRect();
        const relX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const relY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        updateAim(relX, relY);
      }
    });
  }

  // Spotlight Toggle Button
  const spotlightBtn = document.getElementById('simToggleSpotlight');
  if (spotlightBtn) {
    spotlightBtn.addEventListener('click', () => {
      isSpotlightActive = !isSpotlightActive;
      spotlightBtn.classList.toggle('active', isSpotlightActive);
      if (simSpotlightMask) {
        simSpotlightMask.style.display = (simMode === 'laser' && isSpotlightActive) ? 'block' : 'none';
      }
      if (simMode !== 'laser') setSimMode('laser');
    });
  }

  // HUD Action buttons
  const btnBlackout = document.getElementById('simBtnBlackout');
  if (btnBlackout) {
    btnBlackout.addEventListener('click', () => {
      isBlackoutActive = !isBlackoutActive;
      btnBlackout.classList.toggle('active', isBlackoutActive);
      if (simSlideMonitor) simSlideMonitor.classList.toggle('blackout', isBlackoutActive);
      const keyInjectedEl = document.getElementById('simKeyInjected');
      if (keyInjectedEl) keyInjectedEl.textContent = isBlackoutActive ? 'Key [B] Screen Blackout' : 'Key [B] Restored';
    });
  }

  const btnF5 = document.getElementById('simBtnF5');
  if (btnF5) {
    btnF5.addEventListener('click', () => {
      triggerSimulatorAction('NEXT', btnF5);
      const keyInjectedEl = document.getElementById('simKeyInjected');
      if (keyInjectedEl) keyInjectedEl.textContent = 'Key [F5] Presentation Start';
    });
  }

  const btnProfile = document.getElementById('simBtnProfile');
  const hostProfileChip = document.getElementById('simHostProfileChip');
  if (btnProfile) {
    btnProfile.addEventListener('click', () => {
      currentProfileIdx = (currentProfileIdx + 1) % PROFILES.length;
      const prof = PROFILES[currentProfileIdx];
      const valEl = document.getElementById('simProfileVal');
      if (valEl) valEl.textContent = prof;
      if (hostProfileChip) hostProfileChip.textContent = `${prof} Live Host`;
      const keyInjectedEl = document.getElementById('simKeyInjected');
      if (keyInjectedEl) keyInjectedEl.textContent = `Profile: ${prof}`;
    });
  }

  const btnResetTimer = document.getElementById('simBtnTimerReset');
  if (btnResetTimer) {
    btnResetTimer.addEventListener('click', () => {
      simTimerSeconds = 0;
      const timerEl = document.getElementById('simTimerDisplay');
      if (timerEl) timerEl.textContent = '00:00';
    });
  }

  // Global key listener when user interacts with demo
  window.addEventListener('keydown', (e) => {
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (activeTag === 'input' || activeTag === 'textarea') return;

    const demoSection = document.getElementById('demo');
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      if (isInViewport(demoSection)) {
        e.preventDefault();
        triggerSimulatorAction('NEXT', volUpBtn);
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      if (isInViewport(demoSection)) {
        e.preventDefault();
        triggerSimulatorAction('PREV', volDownBtn);
      }
    }
  });

  // Presentation timer tick
  simTimerInterval = setInterval(() => {
    simTimerSeconds++;
    const mins = String(Math.floor(simTimerSeconds / 60)).padStart(2, '0');
    const secs = String(simTimerSeconds % 60).padStart(2, '0');
    const timerEl = document.getElementById('simTimerDisplay');
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  }, 1000);

  updateSlideDisplay('NEXT');
  setTimeout(() => updateAim(0.5, 0.4), 100);
}

function triggerSimulatorAction(action, triggerElement) {
  totalClicks++;

  // Haptic feedback if supported by browser
  if (typeof navigator.vibrate === 'function') {
    navigator.vibrate(35);
  }

  // Visual button trigger animation
  if (triggerElement) {
    triggerElement.classList.add('active-pressed', 'simulated-press');
    setTimeout(() => {
      triggerElement.classList.remove('active-pressed', 'simulated-press');
    }, 140);
  }

  // Slide state progression
  if (action === 'NEXT') {
    currentSlideIdx = (currentSlideIdx + 1) % SLIDES.length;
    updateSlideDisplay('NEXT');
  } else {
    currentSlideIdx = (currentSlideIdx - 1 + SLIDES.length) % SLIDES.length;
    updateSlideDisplay('PREV');
  }

  // Update telemetry HUD
  const keyInjectedEl = document.getElementById('simKeyInjected');
  const latencyEl     = document.getElementById('simLatency');
  const clicksEl      = document.getElementById('simClicks');

  if (keyInjectedEl) {
    keyInjectedEl.textContent = action === 'NEXT' ? 'Right Arrow [→]' : 'Left Arrow [←]';
  }
  if (latencyEl) {
    const lat = (Math.random() * 1.8 + 1.1).toFixed(1);
    latencyEl.textContent = `${lat} ms`;
  }
  if (clicksEl) {
    clicksEl.textContent = `${totalClicks} clicks`;
  }
}

function updateSlideDisplay(direction) {
  const slide = SLIDES[currentSlideIdx];
  const card = document.getElementById('slideCard');
  const tagEl = document.getElementById('slideTag');
  const headEl = document.getElementById('slideHeadline');
  const detailEl = document.getElementById('slideDetail');
  const badgeEl = document.getElementById('slideDeckBadge');
  const indEl = document.getElementById('slideIndicator');

  if (!card) return;

  card.classList.remove('anim-next', 'anim-prev');
  void card.offsetWidth; // trigger reflow

  if (tagEl)    tagEl.textContent = slide.tag;
  if (headEl)   headEl.textContent = slide.headline;
  if (detailEl) detailEl.textContent = slide.detail;
  if (badgeEl)  badgeEl.textContent = slide.badge;
  if (indEl)    indEl.innerHTML = `<span>0${currentSlideIdx + 1}</span> / 0${SLIDES.length}`;

  card.classList.add(direction === 'NEXT' ? 'anim-next' : 'anim-prev');
}

function isInViewport(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.top < window.innerHeight && rect.bottom >= 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// FAQ Accordion
// ─────────────────────────────────────────────────────────────────────────────
function initFaqAccordion() {
  const faqItems = document.querySelectorAll('.faq-item');
  faqItems.forEach(item => {
    const questionBtn = item.querySelector('.faq-question');
    if (questionBtn) {
      questionBtn.addEventListener('click', () => {
        const wasOpen = item.classList.contains('open');
        faqItems.forEach(i => i.classList.remove('open'));
        if (!wasOpen) {
          item.classList.add('open');
        }
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform Download Detection
// ─────────────────────────────────────────────────────────────────────────────
function initPlatformDownloadHighlight() {
  const ua = navigator.userAgent.toLowerCase();
  const isAndroid = /android/i.test(ua);
  const isWindows = /windows|win32/i.test(ua);

  const heroWinBtn = document.getElementById('heroWinBtn');
  const heroAndroidBtn = document.getElementById('heroAndroidBtn');

  if (isAndroid && heroAndroidBtn && heroWinBtn) {
    heroAndroidBtn.classList.remove('btn-secondary');
    heroAndroidBtn.classList.add('btn-primary');
    heroWinBtn.classList.remove('btn-primary');
    heroWinBtn.classList.add('btn-secondary');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Smooth Scrolling
// ─────────────────────────────────────────────────────────────────────────────
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#' || targetId === '') return;
      const targetEl = document.querySelector(targetId);
      if (targetEl) {
        e.preventDefault();
        targetEl.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
}

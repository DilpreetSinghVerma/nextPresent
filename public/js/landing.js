/**
 * nextPresent Landing Page Interactive Engine
 */

document.addEventListener('DOMContentLoaded', () => {
  initSimulator();
  initFaqAccordion();
  initPlatformDownloadHighlight();
  initSmoothScroll();
});

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

function initSimulator() {
  const volUpBtn     = document.getElementById('simVolUp');
  const volDownBtn   = document.getElementById('simVolDown');
  const phoneNextBtn = document.getElementById('simPhoneNext');
  const phonePrevBtn = document.getElementById('simPhonePrev');

  if (volUpBtn)     volUpBtn.addEventListener('click', () => triggerSimulatorAction('NEXT', volUpBtn));
  if (volDownBtn)   volDownBtn.addEventListener('click', () => triggerSimulatorAction('PREV', volDownBtn));
  if (phoneNextBtn) phoneNextBtn.addEventListener('click', () => triggerSimulatorAction('NEXT', phoneNextBtn));
  if (phonePrevBtn) phonePrevBtn.addEventListener('click', () => triggerSimulatorAction('PREV', phonePrevBtn));

  // Global key listener when user interacts with demo
  window.addEventListener('keydown', (e) => {
    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (activeTag === 'input' || activeTag === 'textarea') return;

    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      if (isInViewport(document.getElementById('demoSection'))) {
        e.preventDefault();
        triggerSimulatorAction('NEXT', volUpBtn);
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      if (isInViewport(document.getElementById('demoSection'))) {
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

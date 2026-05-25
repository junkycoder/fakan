// Shake-to-terminál na mobilu. devicemotion s prahem na delta zrychlení;
// iOS 13+ vyžaduje DeviceMotionEvent.requestPermission() po user gestu —
// proto si o povolení říkáme až při prvním tapu.

import { openTerminalPanel } from './panels.js';

const SHAKE_THRESHOLD = 22;       // m/s² delta mezi snímky (citlivost)
const SHAKE_MIN_GAP_MS = 1500;    // cooldown po triggeru — zabraňuje dvojím otevřením
const SAMPLE_GAP_MS = 100;        // sampling

let lastShake = 0;
let lastSample = 0;
let lastX = null, lastY = null, lastZ = null;
let attached = false;

function onMotion(e) {
  const acc = e.accelerationIncludingGravity || e.acceleration;
  if (!acc) return;
  const now = Date.now();
  if (now - lastSample < SAMPLE_GAP_MS) return;
  lastSample = now;
  const { x, y, z } = acc;
  if (x == null || y == null || z == null) return;
  if (lastX !== null) {
    const dx = x - lastX, dy = y - lastY, dz = z - lastZ;
    const magnitude = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (magnitude > SHAKE_THRESHOLD && now - lastShake > SHAKE_MIN_GAP_MS) {
      lastShake = now;
      if (navigator.vibrate) try { navigator.vibrate(20); } catch {}
      openTerminalPanel();
    }
  }
  lastX = x; lastY = y; lastZ = z;
}

function attach() {
  if (attached) return;
  attached = true;
  window.addEventListener('devicemotion', onMotion, { passive: true });
}

export function setupShakeToTerminal() {
  if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') return;
  // jen mobil — desktop má Ctrl+T, akcelerometr tam stejně nebývá
  const isTouch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
  if (!isTouch) return;

  // iOS 13+: requestPermission jen po user gestu
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    const ask = async () => {
      window.removeEventListener('touchend', ask);
      window.removeEventListener('click', ask);
      try {
        const res = await DeviceMotionEvent.requestPermission();
        if (res === 'granted') attach();
      } catch {}
    };
    window.addEventListener('touchend', ask, { once: true });
    window.addEventListener('click', ask, { once: true });
    return;
  }

  // Android / starší iOS — bez permissionu
  attach();
}

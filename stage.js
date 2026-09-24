/*
 * Cinematic Stage runtime.
 *
 * The page IS the footage: one full-viewport stage (canvas frame sequence or
 * all-intra video) is fixed behind everything, and page scroll scrubs it.
 * Text lives in `.beat` overlays whose CSS reads variables written here.
 *
 * This file is infrastructure. Do not restructure it per site — change
 * site.config.json, the HTML beats and styles.css instead.
 * Contract: references/runtime.md
 */

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smoothstep = (t) => t * t * (3 - 2 * t);

export async function boot(configUrl = "site.config.json") {
  const root = document.documentElement;
  const params = new URLSearchParams(location.search);
  const shot = params.has("shot") ? clamp(parseFloat(params.get("shot")) || 0) : null;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(pointer: fine)").matches;

  const config = await fetchJSON(configUrl);
  const portrait = innerWidth / innerHeight < (config.portraitBelow ?? 0.9);
  const variant = portrait && config.sources.mobile ? "mobile" : "desktop";
  const base = config.sources[variant].replace(/\/$/, "");
  const manifest = await fetchJSON(`${base}/manifest.json`);
  const N = manifest.frameCount;
  root.dataset.variant = variant;

  const host = document.querySelector("[data-stage]");
  const track = document.querySelector("[data-track]");
  const loaderValue = document.querySelector("[data-loader-value]");

  const mode = config.mode ?? (manifest.frames ? "frames" : "video");
  const focus = manifest.focus ?? config.focus ?? [0.5, 0.5];
  const onLoad = (f) => {
    root.style.setProperty("--load", f.toFixed(3));
    if (loaderValue) loaderValue.textContent = String(Math.round(f * 100)).padStart(3, "0");
  };
  const readyAt = shot !== null ? 1 : (config.readyAt ?? 0.3);
  const source = mode === "video"
    ? videoSource(base, manifest, focus, onLoad)
    : frameSource(base, manifest, focus, onLoad, readyAt);
  host.replaceChildren(source.el);

  // ---- beats -------------------------------------------------------------
  const segments = Object.fromEntries((manifest.segments ?? []).map((s) => [s.id, s]));
  const beats = [...document.querySelectorAll("[data-beat]")].map((el, index, all) => {
    let from = parseFloat(el.dataset.from);
    let to = parseFloat(el.dataset.to);
    if (el.dataset.segment) {
      const [a, b = a] = el.dataset.segment.split(":");
      if (!segments[a] || !segments[b]) throw new Error(`beat #${el.id}: unknown segment ${el.dataset.segment}`);
      from = segments[a].start / (N - 1);
      to = segments[b].end / (N - 1);
    }
    if (!(to > from)) throw new Error(`beat #${el.id}: needs data-segment or data-from < data-to`);
    return {
      el, index, from, to,
      id: el.id,
      zone: el.dataset.zone ?? "",
      title: el.dataset.title ?? el.id,
      edge: parseFloat(el.dataset.edge ?? config.beatEdge ?? 0.22),
      first: index === 0,
      last: index === all.length - 1,
      counters: [...el.querySelectorAll("[data-count]")],
      cache: "",
    };
  });
  document.querySelectorAll("[data-split]").forEach(split);
  document.querySelectorAll("[data-beat-total]").forEach((n) => (n.textContent = pad(beats.length)));

  // The beat whose range started last at or before p. Segment ranges leave
  // sub-frame gaps between beats; this never falls through them.
  const beatAt = (p) => beats.reduce((hit, b) => (b.from <= p + 1e-9 ? b : hit), beats[0]);

  // ---- scroll length -----------------------------------------------------
  const scrollLength = config.scrollLength ?? Math.max(4, beats.length * 1.8);
  let vh = innerHeight;
  const sizeTrack = () => (track.style.height = `${Math.round((scrollLength + 1) * vh)}px`);
  sizeTrack();
  const maxScroll = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);

  // ?shot=<p> (QA screenshots) pins the timeline without scrolling: headless
  // screenshots capture the top of the document, not the scrolled viewport.
  let target = shot ?? 0;
  if (shot !== null) root.dataset.shot = "";
  const readScroll = () => { if (shot === null) target = clamp(scrollY / maxScroll()); };
  addEventListener("scroll", readScroll, { passive: true });

  let lastWidth = innerWidth;
  addEventListener("resize", () => {
    source.resize();
    // Mobile URL bars change height constantly; only re-measure on real resizes.
    if (innerWidth !== lastWidth || Math.abs(innerHeight - vh) > 160) {
      lastWidth = innerWidth;
      vh = innerHeight;
      sizeTrack();
    }
    readScroll();
    source.invalidate();
  });

  // ---- pointer parallax ---------------------------------------------------
  const parallax = fine && !reduced ? (config.pointer?.parallax ?? 0) : 0;
  let px = 0, py = 0, tx = 0, ty = 0;
  if (parallax) {
    addEventListener("pointermove", (e) => {
      tx = (e.clientX / innerWidth - 0.5) * 2;
      ty = (e.clientY / innerHeight - 0.5) * 2;
    }, { passive: true });
  }

  // ---- anchor navigation: links to #beat-id scroll to that beat's middle ---
  const scrollToBeat = (beat, behavior = "smooth") =>
    scrollTo({ top: ((beat.from + beat.to) / 2) * maxScroll(), behavior });
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a) return;
    const id = a.getAttribute("href").slice(1);
    const beat = id === "" || id === "top" ? { from: 0, to: 0 } : beats.find((b) => b.id === id);
    if (!beat) return;
    e.preventDefault();
    scrollToBeat(beat, reduced ? "auto" : "smooth");
  });

  // ---- ready --------------------------------------------------------------
  await source.ready;
  const hashBeat = beats.find((b) => `#${b.id}` === location.hash);
  if (hashBeat && shot === null) scrollToBeat(hashBeat, "auto");
  readScroll();
  let current = target;
  root.dataset.ready = "true";

  // ---- frame loop -----------------------------------------------------------
  const damping = config.damping ?? 0.12;
  let last = performance.now();
  let activeId = "";
  let lastP = -1;

  function frame(now) {
    const dt = Math.min(64, now - last) / 16.667;
    last = now;

    let goal = target;
    if (reduced) {
      // Reduced motion: no scrubbing, the stage jumps to each beat's key frame.
      const b = beatAt(goal);
      goal = (b.from + b.to) / 2;
    }
    const k = reduced || shot !== null ? 1 : 1 - Math.pow(1 - damping, dt);
    current += (goal - current) * k;
    if (Math.abs(goal - current) < 1e-5) current = goal;

    px += (tx - px) * 0.06 * dt;
    py += (ty - py) * 0.06 * dt;
    source.show(Math.round(current * (N - 1)), px * parallax, py * parallax, parallax * 2.2);

    if (current !== lastP) {
      lastP = current;
      root.style.setProperty("--p", current.toFixed(4));
      for (const b of beats) updateBeat(b, current);
      const active = beatAt(current);
      if (active.id !== activeId) {
        activeId = active.id;
        root.dataset.activeBeat = active.id;
        root.dataset.zone = active.zone;
        document.querySelectorAll("[data-beat-index]").forEach((n) => (n.textContent = pad(active.index + 1)));
        document.querySelectorAll("[data-beat-title]").forEach((n) => (n.textContent = active.title));
        document.querySelectorAll("[data-nav]").forEach((a) =>
          a.toggleAttribute("aria-current", a.getAttribute("href") === `#${active.id}`));
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- QA hooks (read by scripts/shoot.py) --------------------------------
  root.dataset.stageCheck = checkStage(host, source.el);
  root.dataset.frames = String(N);
  if (shot !== null) {
    // Let the loop settle the exact frame before the screenshot is taken.
    const settle = () => (source.settled() ? (root.dataset.shotReady = "true") : requestAnimationFrame(settle));
    requestAnimationFrame(() => requestAnimationFrame(settle));
  }
  window.__stage = { beats, manifest, variant, mode, get progress() { return current; } };
}

function updateBeat(b, p) {
  const local = (p - b.from) / (b.to - b.from);
  const state = local < 0 ? "before" : local > 1 ? "after" : "active";
  const cp = clamp(local);
  const enter = b.first ? 1 : smoothstep(clamp(local / b.edge));
  const exit = b.last ? 0 : smoothstep(clamp((local - (1 - b.edge)) / b.edge));
  const key = `${state}${cp.toFixed(3)}${enter.toFixed(3)}${exit.toFixed(3)}`;
  if (key === b.cache) return;
  b.cache = key;
  b.el.dataset.state = state;
  b.el.style.setProperty("--cp", cp.toFixed(4));
  b.el.style.setProperty("--enter", enter.toFixed(4));
  b.el.style.setProperty("--exit", exit.toFixed(4));
  for (const c of b.counters) {
    const to = parseFloat(c.dataset.count);
    const digits = (c.dataset.count.split(".")[1] ?? "").length;
    c.textContent = (to * enter).toFixed(digits);
  }
}

// ---- sources --------------------------------------------------------------

function frameSource(base, m, focus, onLoad, readyAt) {
  const N = m.frameCount;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const images = new Array(N);
  const url = (i) => `${base}/${m.frames.replace(/%0(\d)d/, (_, w) => String(i + 1).padStart(+w, "0"))}`;

  // Coarse-to-fine order: every 64th frame first, then 32nd ... so scrubbing
  // works early and sharpens as the rest streams in.
  const order = [0, N - 1];
  const seen = new Uint8Array(N);
  seen[0] = seen[N - 1] = 1;
  for (let stride = 64; stride >= 1; stride >>= 1) {
    for (let i = 0; i < N; i += stride) if (!seen[i]) { seen[i] = 1; order.push(i); }
  }

  let drawn = -1, dirty = true, lastImg = null, lx = 0, ly = 0;
  let loaded = 0;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const need = Math.max(2, Math.ceil(N * readyAt));
  const load = (i) => new Promise((done) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { images[i] = img; finish(); };
    img.onerror = finish;
    img.src = url(i);
    function finish() {
      loaded++;
      onLoad(loaded / N);
      if (loaded >= need) resolveReady();
      if (Math.abs(i - drawn) < 64) dirty = true;
      done();
    }
  });
  let next = 0;
  const worker = async () => { while (next < order.length) await load(order[next++]); };
  Promise.all(Array.from({ length: 8 }, worker));

  const nearest = (i) => {
    for (let d = 0; d < N; d++) {
      if (images[i - d]) return images[i - d];
      if (images[i + d]) return images[i + d];
    }
    return null;
  };

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    dirty = true;
  }
  resize();

  function show(i, x, y, zoom) {
    const img = nearest(i);
    if (!img) return;
    if (!dirty && img === lastImg && i === drawn && Math.abs(x - lx) < 1e-4 && Math.abs(y - ly) < 1e-4) return;
    drawn = i; lastImg = img; lx = x; ly = y; dirty = false;
    const cw = canvas.width, ch = canvas.height;
    const s = Math.max(cw / img.naturalWidth, ch / img.naturalHeight) * (1 + zoom);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    // Cover-fit that keeps the subject's focus point on screen, plus parallax.
    const ox = (cw - w) * focus[0] - x * (w - cw) * 0.5;
    const oy = (ch - h) * focus[1] - y * (h - ch) * 0.5;
    ctx.drawImage(img, ox, oy, w, h);
  }

  return { el: canvas, ready, show, resize, invalidate: () => (dirty = true), settled: () => drawn >= 0 };
}

function videoSource(base, m, focus, onLoad) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.disableRemotePlayback = true;
  video.style.objectPosition = `${focus[0] * 100}% ${focus[1] * 100}%`;

  // Load the whole file into memory: seeking a blob never waits on the network.
  const ready = (async () => {
    const res = await fetch(`${base}/${m.video}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) onLoad(received / total);
    }
    onLoad(1);
    video.src = URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
    await new Promise((r) => video.addEventListener("loadeddata", r, { once: true }));
  })();

  let want = 0;
  const half = 0.5 / m.fps;
  video.addEventListener("seeked", () => {
    if (Math.abs(video.currentTime - want) > half) video.currentTime = want;
  });
  function show(i, x, y, zoom) {
    want = (i + 0.5) / m.fps;
    // Only the newest target is ever requested; stale seeks are dropped.
    if (!video.seeking && Math.abs(video.currentTime - want) > half) video.currentTime = want;
    video.style.transform = zoom
      ? `translate3d(${-x * zoom * 50}%, ${-y * zoom * 50}%, 0) scale(${1 + zoom})`
      : "";
  }
  // "Settled" means the target frame was actually presented, not just seeked (QA screenshots).
  let presented = -1;
  const watch = () => video.requestVideoFrameCallback?.((_, meta) => { presented = meta.mediaTime; watch(); });
  watch();
  const settled = () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - want) <= half &&
    (!video.requestVideoFrameCallback || Math.abs(presented - video.currentTime) <= half * 2);
  return { el: video, ready, show, resize() {}, invalidate() {}, settled };
}

// ---- helpers --------------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// data-split="words" | "chars": wraps text so CSS can stagger with --i / --n.
function split(el) {
  const mode = el.dataset.split;
  const nodes = [...el.childNodes];
  el.textContent = "";
  let i = 0;
  const units = [];
  for (const node of nodes) {
    if (node.nodeType !== Node.TEXT_NODE) {
      el.append(node);
      continue;
    }
    for (const word of node.textContent.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) { el.append(" "); continue; }
      const w = document.createElement("span");
      w.className = "w";
      if (mode === "chars") {
        for (const ch of word) {
          const c = document.createElement("span");
          c.className = "c";
          c.textContent = ch;
          c.style.setProperty("--i", i++);
          units.push(c);
          w.append(c);
        }
      } else {
        w.textContent = word;
        w.style.setProperty("--i", i++);
        units.push(w);
      }
      el.append(w);
    }
  }
  el.style.setProperty("--n", i);
  el.setAttribute("aria-label", nodes.map((n) => n.textContent).join(""));
}

function checkStage(host, el) {
  const problems = [];
  const hs = getComputedStyle(host);
  if (hs.position !== "fixed") problems.push(`stage position is ${hs.position}, must be fixed`);
  if (host.parentElement !== document.body) problems.push("stage must be a direct child of <body>");
  const r = el.getBoundingClientRect();
  if (r.left > 1 || r.top > 1 || r.width < innerWidth - 2 || r.height < innerHeight - 2) {
    problems.push(`stage covers ${Math.round(r.width)}x${Math.round(r.height)} of ${innerWidth}x${innerHeight}`);
  }
  if (el.controls) problems.push("stage media must not show controls");
  return problems.length ? `fail: ${problems.join("; ")}` : "ok";
}

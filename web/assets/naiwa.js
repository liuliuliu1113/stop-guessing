(() => {
  "use strict";

  const MANIFEST_URL = "/assets/stickers/manifest.json";
  const ASSET_BASE = "/assets/stickers/";
  const SEEN_KEY = "stopguess.naiwa.seen.v1";
  const EMPTY_HOLD_MS = 1600;
  const COVER_EXIT_MS = 620;
  const BIG_SLOT_NAMES = new Set([
    "cover",
    "listening",
    "thinking",
    "poke",
    "push",
    "done",
    "relapse",
    "oops",
    "farewell",
    "empty",
  ]);

  const page = document.querySelector("#page");
  const cover = document.querySelector("#cover");
  const coverEnter = document.querySelector("#cover-enter");
  const thought = document.querySelector("#thought");
  const slots = new Map();

  for (const element of document.querySelectorAll("[data-naiwa-slot]")) {
    const name = element.dataset.naiwaSlot;
    if (name) slots.set(name, element);
  }

  const reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;
  const desktopQuery = window.matchMedia
    ? window.matchMedia("(min-width: 1024px)")
    : null;

  let manifest = null;
  let activeSlot = null;
  let emptyTimer = 0;
  let coverDismissed = false;
  let lockUntil = 0;

  function prefersReducedMotion() {
    return reducedMotion?.matches === true;
  }

  function isDesktop() {
    return desktopQuery?.matches === true;
  }

  function usesCoverStage(name) {
    return isDesktop() && BIG_SLOT_NAMES.has(name);
  }

  function hasThought() {
    return Boolean(thought && thought.value.trim() !== "");
  }

  function motionDuration(ms) {
    return prefersReducedMotion() ? 0 : ms;
  }

  function readSeen() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "null");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 会话存储不可用时退回从第一张开始。
    }
    return {};
  }

  function writeSeen(seen) {
    try {
      sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    } catch {
      // 写入失败不影响本轮展示。
    }
  }

  function isSafeFile(value) {
    return (
      typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*\.(webp|png|jpg|jpeg|avif)$/i.test(value)
    );
  }

  function slotFiles(name) {
    const list = manifest?.slots?.[name];
    if (!Array.isArray(list)) return [];
    return list.filter(isSafeFile);
  }

  function nextFile(name, commit) {
    const files = slotFiles(name);
    if (files.length === 0) return "";

    const seen = readSeen();
    const usedValues = Array.isArray(seen[name]) ? seen[name] : [];
    const used = new Set(
      usedValues.filter(
        (value) => Number.isInteger(value) && value >= 0 && value < files.length
      )
    );

    let index = files.findIndex((_, itemIndex) => !used.has(itemIndex));
    if (index === -1) {
      used.clear();
      index = 0;
    }

    if (commit) {
      used.add(index);
      seen[name] = [...used].sort((a, b) => a - b);
      writeSeen(seen);
    }

    return files[index];
  }

  function ensureStage(element) {
    let stage = element.querySelector(".naiwa-stage");
    if (!stage) {
      stage = document.createElement("div");
      stage.className = "naiwa-stage";
      element.prepend(stage);
    }
    return stage;
  }

  function ensureFallback(element) {
    let fallback = element.querySelector(".naiwa-fallback");
    if (!fallback) {
      fallback = document.createElement("div");
      fallback.className = "naiwa-fallback";

      const face = document.createElement("div");
      face.className = "naiwa-face";

      const mouth = document.createElement("span");
      mouth.className = "naiwa-face-mouth";

      face.append(mouth);
      fallback.append(face);
      element.append(fallback);
    }
    return fallback;
  }

  function showFallback(element) {
    ensureStage(element);
    ensureFallback(element);
    element.classList.add("naiwa-missing");
  }

  function activateSlot(name) {
    if (name !== "empty") {
      clearTimeout(emptyTimer);
    }

    const target = slots.get(name);
    if (!target) return false;

    if (isDesktop()) {
      const coverSlot = slots.get("cover");
      for (const [slotName, element] of slots) {
        if (slotName === "cover") continue;
        if (slotName === name) continue;
        element.classList.remove("is-visible");
      }
      coverSlot?.classList.add("is-visible");
      target.classList.add("is-visible");
      activeSlot = name;
      return true;
    }

    for (const [slotName, element] of slots) {
      if (slotName !== name) {
        element.classList.remove("is-visible");
      }
    }

    target.classList.add("is-visible");
    activeSlot = name;
    return true;
  }

  function hideSlot(name) {
    const element = slots.get(name);
    if (element) element.classList.remove("is-visible");
    if (activeSlot === name) activeSlot = null;
  }

  function renderImage(element, url, isCover) {
    ensureFallback(element);
    const stage = ensureStage(element);
    const oldImages = [...stage.querySelectorAll("img")];

    const image = document.createElement("img");
    image.className = "naiwa-img";
    image.alt = "";
    image.width = isCover ? 1100 : 900;
    image.height = isCover ? 1212 : 900;
    image.decoding = "async";
    image.loading = isCover ? "eager" : "lazy";
    image.setAttribute("fetchpriority", isCover ? "high" : "low");
    if (!isCover || oldImages.length > 0) image.classList.add("is-new");

    image.addEventListener(
      "load",
      () => {
        element.classList.remove("naiwa-missing");
        if (image.classList.contains("is-new")) {
          requestAnimationFrame(() => image.classList.add("is-in"));
        }
        oldImages.forEach((oldImage) => {
          oldImage.classList.add("is-out");
          setTimeout(() => oldImage.remove(), motionDuration(220));
        });
      },
      { once: true }
    );

    image.addEventListener(
      "error",
      () => {
        image.remove();
        if (!stage.querySelector("img:not(.is-out)")) {
          showFallback(element);
        }
      },
      { once: true }
    );

    image.src = url;
    stage.append(image);
  }

  function renderSlot(name) {
    const targetName = usesCoverStage(name) ? "cover" : name;
    const element = slots.get(targetName);
    if (!element) return;

    if (targetName === "cover") {
      element.dataset.naiwaState = name;
    }

    if (!manifest) {
      showFallback(element);
      return;
    }

    const file = nextFile(name, true);
    if (!file) {
      showFallback(element);
      return;
    }

    renderImage(element, ASSET_BASE + encodeURIComponent(file), targetName === "cover");
  }

  function syncListening() {
    const element = slots.get("listening");
    if (element) element.classList.toggle("is-typing", hasThought());
  }

  function scheduleEmptyHide() {
    clearTimeout(emptyTimer);
    emptyTimer = window.setTimeout(() => {
      if (activeSlot !== "empty") return;
      hideSlot("empty");
      setNaiwa("listening");
    }, EMPTY_HOLD_MS);
  }

  function setNaiwa(name) {
    if (typeof name !== "string" || !slots.has(name)) return;
    if (name === "cover" && coverDismissed) return;
    if (name === "relapse" && Date.now() < lockUntil) return;

    if (!activateSlot(name)) return;
    renderSlot(name);
    if (name === "listening") syncListening();
    if (name === "empty") scheduleEmptyHide();
    if (name === "done") lockUntil = Date.now() + 3000;
  }

  function setChapter(chapter) {
    const value = Number(chapter);
    if (![1, 2, 3].includes(value)) return;
    document.body.dataset.chapter = String(value);
  }

  function focusComposer() {
    if (!thought) return;
    if (
      document.activeElement &&
      document.activeElement !== document.body &&
      document.activeElement !== coverEnter
    ) {
      return;
    }
    thought.focus({ preventScroll: true });
  }

  function dismissCover() {
    if (coverDismissed) return;
    coverDismissed = true;

    if (page) page.inert = false;
    document.body.classList.remove("cover-open");

    if (isDesktop()) {
      if (cover) {
        cover.hidden = false;
        cover.inert = false;
        cover.classList.remove("cover-out");
        cover.removeAttribute("aria-hidden");
      }
      if (coverEnter) coverEnter.textContent = "写下那句话";
      thought?.focus();
      return;
    }

    if (cover) {
      cover.classList.add("cover-out");
      cover.inert = true;
      cover.setAttribute("aria-hidden", "true");
    }

    const delay = motionDuration(COVER_EXIT_MS);

    if (delay > 0) {
      window.setTimeout(() => {
        if (cover) cover.hidden = true;
      }, delay);
    } else if (cover) {
      cover.hidden = true;
    }

    window.setTimeout(focusComposer, Math.max(delay, 30));
  }

  function startCasting() {
    document.body.classList.add("casting");
    setNaiwa("thinking");
    window.setTimeout(() => {
      document.body.classList.remove("casting");
      if (activeSlot === "thinking") hideSlot("thinking");
      if (activeSlot !== "listening" && activeSlot !== "empty") {
        setNaiwa("listening");
      }
    }, motionDuration(950));
  }

  async function loadManifest() {
    try {
      const response = await fetch(MANIFEST_URL, { cache: "no-cache" });
      if (!response.ok) throw new Error("manifest_unavailable");
      const data = await response.json();
      if (!data || typeof data !== "object" || !data.slots || typeof data.slots !== "object") {
        throw new Error("manifest_invalid");
      }
      manifest = data;
    } catch {
      manifest = null;
    }

    if (coverDismissed) {
      if (activeSlot && activeSlot !== "cover") renderSlot(activeSlot);
      return;
    }

    if (!activeSlot) {
      setNaiwa("cover");
      return;
    }

    renderSlot(activeSlot);
  }

  window.setNaiwa = setNaiwa;
  window.setChapter = setChapter;

  if (page) page.inert = true;
  setChapter(1);

  if (cover && coverEnter) {
    coverEnter.addEventListener("click", () => {
      if (isDesktop() && coverDismissed) {
        thought?.focus();
        return;
      }
      startCasting();
      dismissCover();
    });
  } else {
    if (page) page.inert = false;
    document.body.classList.remove("cover-open");
    setNaiwa("listening");
  }

  function syncBreakpoint() {
    if (!coverDismissed) return;

    if (isDesktop()) {
      if (cover) {
        cover.hidden = false;
        cover.inert = false;
        cover.classList.remove("cover-out");
        cover.removeAttribute("aria-hidden");
      }
      if (page) page.inert = false;
      document.body.classList.remove("cover-open");
      if (coverEnter) coverEnter.textContent = "写下那句话";
      renderSlot(activeSlot && activeSlot !== "cover" ? activeSlot : "cover");
      return;
    }

    if (cover) {
      cover.hidden = true;
      cover.inert = true;
      cover.classList.add("cover-out");
      cover.setAttribute("aria-hidden", "true");
    }
    if (activeSlot && activeSlot !== "cover") renderSlot(activeSlot);
  }

  desktopQuery?.addEventListener?.("change", syncBreakpoint);

  if (thought) {
    thought.addEventListener("focus", () => {
      if (activeSlot === "empty") {
        if (!hasThought()) return;
        clearTimeout(emptyTimer);
        hideSlot("empty");
      }

      if (activeSlot === "thinking") {
        syncListening();
        return;
      }

      if (activeSlot !== "listening") setNaiwa("listening");
      syncListening();
    });

    thought.addEventListener("input", () => {
      if (activeSlot === "empty" && hasThought()) {
        clearTimeout(emptyTimer);
        hideSlot("empty");
      }

      if (
        activeSlot !== "empty" &&
        document.activeElement === thought &&
        hasThought() &&
        activeSlot !== "listening"
      ) {
        setNaiwa("listening");
      }

      syncListening();
    });
  }

  for (const button of document.querySelectorAll(".example")) {
    button.addEventListener("click", () => {
      window.setTimeout(() => {
        if (activeSlot === "empty" && hasThought()) {
          clearTimeout(emptyTimer);
          hideSlot("empty");
          setNaiwa("listening");
        }
        syncListening();
      }, 0);
    });
  }

  loadManifest();
})();
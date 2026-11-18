const DEMO_REPORT = {
  body: "你把「没回消息」直接读成了「不想理我」，中间跳过了 5 种可能。",
  facts: ["他 3 天没回我消息", "最后一条是我发的"],
  guesses: ["他不想理我", "他在跟别人聊得更开心"],
  others: [
    { text: "手机丢了或者一直没充电", kind: "意外" },
    { text: "他在赶东西，累到不想说话", kind: "时间" },
    { text: "他也在等你先开口", kind: "关系" },
    { text: "他在生气，但不知道怎么收场", kind: "关系" },
    { text: "他真的就是忘了回", kind: "性格" }
  ],
  action: {
    title: "发一条不带压力的消息",
    why: "把猜测换成一个可验证的回应，比在脑子里推演 10 遍都快",
    say: "在吗？刚看到一个东西想到你",
    time: "今晚 9 点前"
  },
  alternatives: [
    { title: "更轻的做法", desc: "只发一个表情，不解释、不追问、不试探" },
    { title: "更直接的做法", desc: "直接问一句：你最近是不是有点忙" }
  ]
};

const KIND_CLASS = {
  关系: "kind-relationship",
  时间: "kind-time",
  意外: "kind-accident",
  性格: "kind-personality",
  客观: "kind-objective"
};

const PREFS_KEY = "stopguess.prefs.v1";
const REPEAT_KEY = "stopguess.repeat.v1";
const FALLBACK_NOTICE = "这是示例拆解 —— 模型这次没连上，等下再试一次？";
const CONFIG_NOTICE = "这个站还没配好模型，先看个例子";
const RATE_NOTICE = "慢一点，一分钟最多十次";
const ERROR_NOTICE = "刚才没拆成功，再试一次？";

const thought = document.querySelector("#thought");
const count = document.querySelector("#count");
const inputView = document.querySelector("#input-view");
const reportView = document.querySelector("#report-view");
const submitButton = document.querySelector("#submit");
const errorNote = document.querySelector("#composer-error");
const restartButton = document.querySelector("#restart");
const analysisWrap = document.querySelector(".analysis-wrap");
const chipRows = [...document.querySelectorAll(".chip-row[data-field]")];
const reportRecall = document.querySelector("#report-recall");
const reportBody = document.querySelector("#report-body");
const factList = document.querySelector("#fact-list");
const guessList = document.querySelector("#guess-list");
const factCount = document.querySelector("#fact-count");
const guessCount = document.querySelector("#guess-count");
const othersTitle = document.querySelector("#others-title");
const othersList = document.querySelector("#others-list");
const actionTitle = document.querySelector("#action-title");
const actionWhy = document.querySelector("#action-why");
const actionSay = document.querySelector("#action-say");
const actionTime = document.querySelector("#action-time");
const copyButton = document.querySelector("#copy-action");
const didActionButton = document.querySelector("#did-action");
const counterStrip = document.querySelector("#counter-strip");
const counterCountLine = document.querySelector("#counter-count-line");
const counterFirstLine = document.querySelector("#counter-first-line");
const counterGuess = document.querySelector("#counter-guess");
const counterAct = document.querySelector("#counter-act");
const counterFirstGuess = document.querySelector("#counter-first-guess");
const counterNudge = document.querySelector("#counter-nudge");
const alternativesList = document.querySelector("#alternatives-list");
const reportSkeleton = document.querySelector("#report-skeleton");
const reportStatus = document.querySelector("#report-status");
const reportStatusText = document.querySelector("#report-status-text");
const reportStatusAction = document.querySelector("#report-status-action");
const fallbackNote = document.querySelector("#report-fallback");
const copyStatus = document.querySelector("#copy-status");
const reportRevealItems = [...reportView.querySelectorAll("[data-reveal]")];

const state = {
  text: "",
  relation: "",
  duration: "",
  view: "input",
};

let hintTimer;
let copyResetTimer;
let copyFlashTimer;
let copyStatusTimer;
let currentReport = null;
let selectedAlternative = null;
let repeatStore = Object.create(null);
let currentRepeat = null;
let actedThisReport = false;
let copiedThisReport = false;
let shouldReveal = false;

const reducedMotionQuery = window.matchMedia
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : null;
const numberAnimations = new WeakMap();

function chipValues(field) {
  return [...document.querySelectorAll(`.chip-row[data-field="${field}"] .chip`)]
    .map((chip) => chip.dataset.value)
    .filter(Boolean);
}

function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (!prefs || typeof prefs !== "object") return;

    if (chipValues("relation").includes(prefs.relation)) {
      state.relation = prefs.relation;
    }
    if (chipValues("duration").includes(prefs.duration)) {
      state.duration = prefs.duration;
    }
  } catch {
    // 隐私模式或存储不可用时，保持未选择。
  }
}

function savePrefs() {
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ relation: state.relation, duration: state.duration })
    );
  } catch {
    // 存储失败不影响本次交互。
  }
}

function normalizeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function loadRepeatStore() {
  const store = Object.create(null);
  try {
    const parsed = JSON.parse(localStorage.getItem(REPEAT_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return store;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      store[key] = {
        guess: normalizeCount(value.guess),
        act: normalizeCount(value.act),
      };
    }
  } catch {
    // 读取失败按新条目处理。
  }
  return store;
}

function saveRepeatStore() {
  try {
    localStorage.setItem(REPEAT_KEY, JSON.stringify(repeatStore));
  } catch {
    // 写入失败不影响本次展示。
  }
}

function makeRepeatKey(text) {
  const compact = String(text ?? "").replace(/[\p{P}\p{Z}\s]/gu, "");
  return Array.from(compact).slice(0, 20).join("");
}

function setNumber(element, value) {
  const frame = numberAnimations.get(element);
  if (frame !== undefined) cancelAnimationFrame(frame);
  numberAnimations.delete(element);
  element.textContent = String(normalizeCount(value));
}

function animateNumber(element, from, to) {
  const start = normalizeCount(from);
  const end = normalizeCount(to);
  const frame = numberAnimations.get(element);
  if (frame !== undefined) cancelAnimationFrame(frame);
  numberAnimations.delete(element);

  if (!reducedMotionQuery || reducedMotionQuery.matches || start === end) {
    element.textContent = String(end);
    return;
  }

  const startedAt = performance.now();
  const duration = 600;
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    element.textContent = String(Math.round(start + (end - start) * eased));
    if (progress < 1) {
      numberAnimations.set(element, requestAnimationFrame(tick));
    } else {
      element.textContent = String(end);
      numberAnimations.delete(element);
    }
  };
  numberAnimations.set(element, requestAnimationFrame(tick));
}

function paintCounter(entry) {
  const guess = normalizeCount(entry.guess);
  const act = normalizeCount(entry.act);
  const isFirst = guess === 1;

  counterCountLine.hidden = isFirst;
  counterFirstLine.hidden = !isFirst;
  counterNudge.hidden = guess < 3;
  counterNudge.textContent =
    guess >= 3 ? `这条你已经绕了 ${guess} 圈了。要不先做那件小事？` : "";
  counterAct.classList.toggle("is-positive", act > 0);

  setNumber(counterGuess, 0);
  setNumber(counterAct, 0);
  setNumber(counterFirstGuess, 0);
  counterStrip.hidden = false;

  if (isFirst) {
    animateNumber(counterFirstGuess, 0, guess);
  } else {
    animateNumber(counterGuess, 0, guess);
    animateNumber(counterAct, 0, act);
  }

  if (typeof window.setNaiwa === "function") {
    window.setNaiwa(guess >= 3 ? "relapse" : "listening");
  }
}

function recordReportSeen() {
  const key = makeRepeatKey(state.text);
  let entry = repeatStore[key];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    entry = { guess: 0, act: 0 };
    repeatStore[key] = entry;
  }
  entry.guess = normalizeCount(entry.guess) + 1;
  entry.act = normalizeCount(entry.act);
  currentRepeat = entry;
  actedThisReport = false;
  copiedThisReport = false;
  saveRepeatStore();
  paintCounter(entry);
}

function incrementAct() {
  if (!currentRepeat) return;
  currentRepeat.act = normalizeCount(currentRepeat.act) + 1;
  saveRepeatStore();
  counterAct.classList.toggle("is-positive", currentRepeat.act > 0);
  if (!counterFirstLine.hidden) return;
  const from = Number.parseInt(counterAct.textContent ?? "0", 10) || 0;
  animateNumber(counterAct, from, currentRepeat.act);
}

function updateCount() {
  if (thought.value.length > 120) {
    thought.value = thought.value.slice(0, 120);
  }
  state.text = thought.value;
  count.textContent = `${thought.value.length}/120`;
}

function syncChips() {
  chipRows.forEach((row) => {
    const field = row.dataset.field;
    row.querySelectorAll(".chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(chip.dataset.value === state[field]));
    });
  });
}

function syncView() {
  const isReport = state.view === "report";
  inputView.classList.toggle("is-hidden", isReport);
  reportView.classList.toggle("is-hidden", !isReport);
  window.scrollTo(0, 0);
}

function setError(visible) {
  errorNote.hidden = !visible;
}

function fillCompareList(list, items) {
  list.replaceChildren(
    ...items.map((text) => {
      const item = document.createElement("li");
      item.className = "compare-item";
      item.textContent = text;
      return item;
    })
  );
}

function renderBody(body) {
  reportBody.textContent = body;
}

function renderFactsGuesses(facts, guesses) {
  fillCompareList(factList, facts);
  fillCompareList(guessList, guesses);
  factCount.textContent = `${facts.length} 条`;
  guessCount.textContent = `${guesses.length} 条`;
}

function renderOthers(others) {
  othersTitle.textContent = `你还可能没想到的 ${others.length} 种可能`;
  othersList.replaceChildren(
    ...others.map((item, index) => {
      const row = document.createElement("li");
      row.className = "other-row";

      const number = document.createElement("span");
      number.className = "other-index";
      number.textContent = String(index + 1);

      const text = document.createElement("span");
      text.className = "other-text";
      text.textContent = item.text;

      const chip = document.createElement("span");
      chip.className = `kind-chip ${KIND_CLASS[item.kind] ?? "kind-objective"}`;
      chip.textContent = item.kind;

      row.append(number, text, chip);
      return row;
    })
  );
}

function renderAction(action, alternative) {
  actionTitle.textContent = alternative?.title ?? action.title;
  actionWhy.textContent = alternative?.desc ?? action.why;
  actionSay.textContent = action.say;
  actionTime.textContent = `建议时间：${action.time}`;
}

function updateAlternativeSelection() {
  [...alternativesList.children].forEach((card, index) => {
    const isSelected = index === selectedAlternative;
    card.classList.toggle("is-selected", isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
  });
}

function renderAlternatives(alternatives) {
  alternativesList.replaceChildren(
    ...alternatives.map((item, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `alternative${index === selectedAlternative ? " is-selected" : ""}`;
      card.setAttribute("aria-pressed", String(index === selectedAlternative));

      const title = document.createElement("span");
      title.className = "alternative-title";
      title.textContent = item.title;

      const desc = document.createElement("span");
      desc.className = "alternative-desc";
      desc.textContent = item.desc;

      card.append(title, desc);
      card.addEventListener("click", () => {
        selectedAlternative = index;
        renderAction(currentReport.action, currentReport.alternatives[index]);
        updateAlternativeSelection();
      });
      return card;
    })
  );
}

function clearReportStatus() {
  reportStatus.hidden = true;
  reportStatusText.textContent = "";
  reportStatusAction.textContent = "";
  reportStatusAction.dataset.action = "";
  reportStatusAction.hidden = true;
  reportView.classList.remove("is-status");
}

function showReportStatus(kind) {
  const isConfig = kind === "config";
  reportStatusText.textContent = isConfig ? CONFIG_NOTICE : ERROR_NOTICE;
  reportStatusAction.textContent = isConfig ? "看个例子" : "再试一次";
  reportStatusAction.dataset.action = isConfig ? "demo" : "retry";
  reportStatusAction.hidden = false;
  reportStatus.hidden = false;
  reportView.classList.add("is-status");
  reportView.classList.remove("is-loading");
  reportSkeleton.hidden = true;
  fallbackNote.hidden = true;
  reportView.setAttribute("aria-busy", "false");
  shouldReveal = false;
}

function revealReport() {
  reportView.classList.remove("is-revealed");
  reportRevealItems.forEach((item, index) => {
    item.style.setProperty("--reveal-index", String(index));
  });
  void reportView.offsetWidth;
  reportView.classList.add("is-revealed");
}

function finishLoading() {
  reportView.classList.remove("is-loading");
  reportView.setAttribute("aria-busy", "false");
  reportSkeleton.hidden = true;
  if (shouldReveal && !reportView.classList.contains("is-status")) {
    shouldReveal = false;
    revealReport();
  }
}

function renderDemo(noteText) {
  try {
    fallbackNote.textContent = noteText;
    fallbackNote.hidden = false;
    renderReport(DEMO_REPORT);
    return true;
  } catch {
    showReportStatus("error");
    return false;
  }
}

function renderReport(data) {
  clearReportStatus();
  currentReport = data;
  selectedAlternative = null;
  reportRecall.textContent = `你写的是：${state.text}`;
  clearTimeout(copyResetTimer);
  clearTimeout(copyFlashTimer);
  clearTimeout(copyStatusTimer);
  copyButton.classList.remove("is-flashing");
  copyStatus.textContent = "";
  copyButton.textContent = "复制";
  didActionButton.textContent = "我做了";
  didActionButton.disabled = false;
  renderBody(data.body);
  renderFactsGuesses(data.facts, data.guesses);
  renderOthers(data.others);
  renderAction(data.action, null);
  renderAlternatives(data.alternatives);
  recordReportSeen();
  shouldReveal = true;
}

function fallbackCopy(text) {
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.top = "-1000px";
  helper.style.opacity = "0";
  document.body.append(helper);
  helper.select();
  helper.setSelectionRange(0, helper.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  helper.remove();
  return copied;
}

async function copyActionText() {
  if (!copiedThisReport) {
    copiedThisReport = true;
    incrementAct();
  }

  const text = currentReport?.action.say ?? actionSay.textContent;
  let copied = false;

  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    copied = false;
  }

  if (!copied) copied = fallbackCopy(text);
  if (!copied) return;

  copyButton.textContent = "已复制";
  if (reducedMotionQuery?.matches !== true) {
    copyButton.classList.remove("is-flashing");
    void copyButton.offsetWidth;
    copyButton.classList.add("is-flashing");
    clearTimeout(copyFlashTimer);
    copyFlashTimer = setTimeout(() => {
      copyButton.classList.remove("is-flashing");
    }, 420);
  }

  copyStatus.textContent = "";
  clearTimeout(copyStatusTimer);
  copyStatusTimer = setTimeout(() => {
    copyStatus.textContent = "已复制";
  }, 30);

  clearTimeout(copyResetTimer);
  copyResetTimer = setTimeout(() => {
    copyButton.textContent = "复制";
  }, 2000);
}

function handleChipClick(event) {
  const row = event.currentTarget;
  const chip = event.target.closest(".chip");
  if (!(chip instanceof HTMLButtonElement) || !row.contains(chip)) return;

  const field = row.dataset.field;
  const wasPressed = chip.getAttribute("aria-pressed") === "true";
  state[field] = wasPressed ? "" : chip.dataset.value ?? "";
  syncChips();
}

thought.addEventListener("input", () => {
  updateCount();
  setError(false);
});

chipRows.forEach((row) => {
  row.addEventListener("click", handleChipClick);
});

analysisWrap.addEventListener("pointerdown", () => {
  clearTimeout(hintTimer);
  analysisWrap.classList.add("is-hint");
  hintTimer = setTimeout(() => {
    analysisWrap.classList.remove("is-hint");
  }, 2400);
});

document.querySelectorAll(".example").forEach((button) => {
  button.addEventListener("click", () => {
    thought.value = button.dataset.example ?? "";
    state.relation = "恋人";
    state.duration = "几小时";
    updateCount();
    syncChips();
    setError(false);
    thought.focus();
    thought.setSelectionRange(thought.value.length, thought.value.length);
  });
});

async function analyze() {
  if (submitButton.disabled) return;

  updateCount();
  if (state.text.trim() === "") {
    setError(true);
    if (typeof setNaiwa === "function") setNaiwa("empty");
    thought.focus();
    return;
  }

  setError(false);
  savePrefs();
  submitButton.textContent = "正在拆…";
  submitButton.disabled = true;

  clearReportStatus();
  shouldReveal = false;
  state.view = "report";
  fallbackNote.textContent = FALLBACK_NOTICE;
  fallbackNote.hidden = true;
  reportSkeleton.hidden = false;
  counterStrip.hidden = true;
  reportView.classList.add("is-loading");
  reportView.setAttribute("aria-busy", "true");
  syncView();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch("/functions/v1/app", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thought: state.text,
        relation: state.relation,
        duration: state.duration,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data || data.fallback === true) {
      if (response.status === 503 || data?.error === "service_not_configured") {
        showReportStatus("config");
        return;
      }
      if (response.status === 429 || data?.error === "rate_limited") {
        renderDemo(RATE_NOTICE);
        return;
      }
      throw new Error("fallback");
    }

    renderReport(data);
  } catch {
    renderDemo(FALLBACK_NOTICE);
  } finally {
    clearTimeout(timeout);
    finishLoading();
    submitButton.textContent = "去做";
    submitButton.disabled = false;
  }
}

submitButton.addEventListener("click", analyze);

reportStatusAction.addEventListener("click", () => {
  const action = reportStatusAction.dataset.action;
  if (action === "demo") {
    if (renderDemo(FALLBACK_NOTICE)) finishLoading();
    return;
  }
  if (action === "retry") {
    analyze();
  }
});

restartButton.addEventListener("click", () => {
  if (typeof window.setNaiwa === "function") window.setNaiwa("farewell");
  window.setTimeout(() => {
    state.view = "input";
    syncView();
    thought.value = state.text;
    updateCount();
    syncChips();
    setError(false);
    thought.focus({ preventScroll: true });
  }, 300);
});

copyButton.addEventListener("click", copyActionText);

didActionButton.addEventListener("click", () => {
  if (didActionButton.disabled) return;
  didActionButton.textContent = "已做了 ✓";
  didActionButton.disabled = true;
  if (typeof window.setNaiwa === "function") window.setNaiwa("done");
  if (actedThisReport) return;
  actedThisReport = true;
  incrementAct();
});

repeatStore = loadRepeatStore();
loadPrefs();
syncChips();
syncView();
updateCount();

const actionBlock = document.querySelector(".action-block");
const actionCard = document.querySelector(".action-card");
const counterWrap = document.querySelector(".counter-wrap");
const miniAvatars = [...document.querySelectorAll("[data-mini-avatar]")];
const counterDots = [...document.querySelectorAll(".counter-dots i")];

function syncChapter() {
  if (reportView.classList.contains("is-hidden")) {
    window.setChapter?.(1);
    return;
  }
  if (
    reportView.classList.contains("is-loading") ||
    reportView.classList.contains("is-status")
  ) {
    window.setChapter?.(2);
    return;
  }
  const actionTop = actionBlock?.getBoundingClientRect().top ?? Infinity;
  window.setChapter?.(actionTop < window.innerHeight * 0.5 ? 3 : 2);
}

new MutationObserver(syncChapter).observe(reportView, {
  attributes: true,
  attributeFilter: ["class"],
});
window.addEventListener("scroll", syncChapter, { passive: true });
syncChapter();

if (miniAvatars.length > 0) {
  if ("IntersectionObserver" in window) {
    const avatarObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle("is-visible", entry.isIntersecting);
      }
    }, { threshold: 0.2 });
    miniAvatars.forEach((avatar) => avatarObserver.observe(avatar));
  } else {
    miniAvatars.forEach((avatar) => avatar.classList.add("is-visible"));
  }
}

if (counterWrap) {
  if ("IntersectionObserver" in window) {
    const counterObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        entry.target.classList.toggle("is-in-view", entry.isIntersecting);
      }
    }, { threshold: 0.25 });
    counterObserver.observe(counterWrap);
  } else {
    counterWrap.classList.add("is-in-view");
  }
}

actionCard?.addEventListener("click", (event) => {
  if (!event.target.closest("#did-action")) return;
  if (reducedMotionQuery?.matches) return;
  actionCard.classList.remove("is-stamped");
  void actionCard.offsetWidth;
  actionCard.classList.add("is-stamped");
  window.setTimeout(() => actionCard.classList.remove("is-stamped"), 620);
});

function paintCounterDots() {
  const lit = Math.min(5, Number.parseInt(counterAct.textContent ?? "0", 10) || 0);
  counterDots.forEach((dot, index) => {
    dot.classList.toggle("is-lit", index < lit);
  });
}

new MutationObserver(paintCounterDots).observe(counterAct, {
  childList: true,
  characterData: true,
  subtree: true,
});
paintCounterDots();

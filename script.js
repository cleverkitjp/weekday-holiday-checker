(function () {
  "use strict";

  // ===== Config =====
  const TZ = "Asia/Tokyo";
  const API_BASE = "https://api.national-holidays.jp/"; // + YYYY-MM-DD
  const FETCH_TIMEOUT_MS = 4500;

  const CACHE_KEY = "ckHolidayCache_v2";
  const CACHE_TTL_MS = 120 * 24 * 60 * 60 * 1000; // 120 days (soft)

  // ===== DOM =====
  const dateInput = document.getElementById("dateInput");
  const todayBtn = document.getElementById("todayBtn");
  const clearBtn = document.getElementById("clearBtn");

  const datePretty = document.getElementById("datePretty");
  const badges = document.getElementById("badges");
  const dowText = document.getElementById("dowText");
  const calendarDayText = document.getElementById("calendarDayText");
  const holidayText = document.getElementById("holidayText");
  const holidayNameRow = document.getElementById("holidayNameRow");
  const holidayNameText = document.getElementById("holidayNameText");
  const businessDayText = document.getElementById("businessDayText");
  const diffText = document.getElementById("diffText");
  const yearWeekText = document.getElementById("yearWeekText");
  const fiscalWeekText = document.getElementById("fiscalWeekText");
  const noteText = document.getElementById("noteText");

  // ===== Constants =====
  const DOW_JA = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
  const DOW_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  // ===== Helpers =====
  function pad2(n) { return String(n).padStart(2, "0"); }

  function ymdToUTCDate(dateStr) {
    // dateStr: "YYYY-MM-DD" -> Date at UTC midnight of that civil date
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function utcDateToYMD(utcDate) {
    const y = utcDate.getUTCFullYear();
    const m = utcDate.getUTCMonth() + 1;
    const d = utcDate.getUTCDate();
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  function getTokyoTodayYMD() {
    // Stable "today" in Asia/Tokyo even if device timezone differs
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    return fmt.format(new Date()); // "YYYY-MM-DD"
  }

  function ymdPretty(dateStr) {
    return dateStr || "—";
  }

  function clearBadges() { badges.innerHTML = ""; }

  function addBadge(text, kind) {
    const span = document.createElement("span");
    span.className = "ck-badge" + (kind ? ` ${kind}` : "");
    span.textContent = text;
    badges.appendChild(span);
  }

  function setNote(msg) { noteText.textContent = msg || ""; }

  function setHolidayName(name) {
    if (name) {
      holidayNameRow.hidden = false;
      holidayNameText.textContent = name;
    } else {
      holidayNameRow.hidden = true;
      holidayNameText.textContent = "—";
    }
  }

  function weeksDaysLabelFromDiffDays(diffDays) {
    if (diffDays === 0) return "今日（0日）";
    const sign = diffDays > 0 ? 1 : -1;
    const abs = Math.abs(diffDays);
    const w = Math.floor(abs / 7);
    const d = abs % 7;

    const parts = [];
    if (w) parts.push(`${w}週間`);
    if (d) parts.push(`${d}日`);
    const body = parts.length ? parts.join("") : "0日";

    return sign > 0 ? `${body}後（+${abs}日）` : `${body}前（-${abs}日）`;
  }

  // Monday-start week start for a UTC date (civil date basis)
  function mondayStartUTC(utcDate) {
    const dow = utcDate.getUTCDay(); // 0=Sun..6=Sat
    const delta = (dow + 6) % 7;     // Mon->0, Tue->1, ... Sun->6
    return new Date(utcDate.getTime() - delta * MS_PER_DAY);
  }

  function weekIndexAndRemaining(utcDate, periodStartUTC, periodEndUTC) {
    // week index within [periodStart..periodEnd] based on Monday-start weeks
    const firstWeekStart = mondayStartUTC(periodStartUTC);
    const thisWeekStart = mondayStartUTC(utcDate);
    const lastWeekStart = mondayStartUTC(periodEndUTC);

    const idx = Math.floor((thisWeekStart - firstWeekStart) / MS_PER_DAY / 7) + 1;
    const total = Math.floor((lastWeekStart - firstWeekStart) / MS_PER_DAY / 7) + 1;
    const remain = Math.max(0, total - idx);

    return { idx, total, remain };
  }

  function getYearPeriodFor(utcDate) {
    const y = utcDate.getUTCFullYear();
    const start = new Date(Date.UTC(y, 0, 1));   // Jan 1
    const end = new Date(Date.UTC(y, 11, 31));   // Dec 31
    return { y, start, end };
  }

  function getFiscalPeriodFor(utcDate) {
    // FY starts Apr 1. If date < Apr 1, FY start is previous year Apr 1.
    const y = utcDate.getUTCFullYear();
    const apr1This = new Date(Date.UTC(y, 3, 1));
    const fyStart = (utcDate >= apr1This) ? apr1This : new Date(Date.UTC(y - 1, 3, 1));
    const fyEnd = new Date(Date.UTC(fyStart.getUTCFullYear() + 1, 2, 31)); // Mar 31 next year
    return { fyStart, fyEnd };
  }

  // ===== Cache =====
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch {
      return {};
    }
  }

  function saveCache(cache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {}
  }

  function getCached(dateStr) {
    const cache = loadCache();
    const v = cache[dateStr];
    if (!v) return null;
    if (v.ts && (Date.now() - v.ts) > CACHE_TTL_MS) return null;
    return v;
  }

  function setCached(dateStr, payload) {
    const cache = loadCache();
    cache[dateStr] = { ...payload, ts: Date.now() };
    saveCache(cache);
  }

  // ===== Holiday fetch =====
  function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: controller.signal
    }).finally(() => clearTimeout(timer));
  }

  function normalizeHolidayResponse(json) {
    if (!json) return null;

    if (Array.isArray(json)) {
      const first = json[0];
      if (first && typeof first === "object") {
        return { name: first.name || first.title || "", type: first.type || "" };
      }
      return null;
    }

    if (typeof json === "object") {
      return { name: json.name || json.title || "", type: json.type || "" };
    }

    return null;
  }

  async function getHolidayByAPI(dateStr) {
    const cached = getCached(dateStr);
    if (cached) return cached; // {status:'holiday'|'not', name?, type?}

    const url = API_BASE + encodeURIComponent(dateStr);

    try {
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);

      if (res.status === 404) {
        const payload = { status: "not" };
        setCached(dateStr, payload);
        return payload;
      }

      if (!res.ok) {
        return { status: "error", message: `HTTP ${res.status}` };
      }

      const json = await res.json();
      const info = normalizeHolidayResponse(json);

      if (info && info.name) {
        const payload = { status: "holiday", name: info.name, type: info.type || "" };
        setCached(dateStr, payload);
        return payload;
      }

      return { status: "error", message: "unexpected response" };
    } catch {
      return { status: "error", message: "network" };
    }
  }

  // ===== Render =====
  let lastReqId = 0;

  async function render(dateStr) {
    clearBadges();
    setNote("");
    setHolidayName("");

    if (!dateStr) {
      datePretty.textContent = "—";
      dowText.textContent = "—";
      calendarDayText.textContent = "—";
      holidayText.textContent = "—";
      businessDayText.textContent = "—";
      diffText.textContent = "—";
      yearWeekText.textContent = "—";
      fiscalWeekText.textContent = "—";
      return;
    }

    datePretty.textContent = ymdPretty(dateStr);

    const targetUTC = ymdToUTCDate(dateStr);
    const dow = targetUTC.getUTCDay();
    const isWeekend = (dow === 0 || dow === 6);

    // weekday + calendar day
    dowText.textContent = `${DOW_JA[dow]} (${DOW_EN[dow]})`;
    calendarDayText.textContent = isWeekend ? "土日（暦日）" : "平日（暦日）";

    // badges (temporary)
    addBadge(isWeekend ? "土日" : "平日", isWeekend ? "ck-badge-warn" : "ck-badge-accent");
    addBadge("祝日判定", "ck-badge");

    // diff from today (Tokyo)
    const todayYMD = getTokyoTodayYMD();
    const todayUTC = ymdToUTCDate(todayYMD);
    const diffDays = Math.round((targetUTC - todayUTC) / MS_PER_DAY);
    diffText.textContent = weeksDaysLabelFromDiffDays(diffDays);

    // week-of-year
    const yPer = getYearPeriodFor(targetUTC);
    const yw = weekIndexAndRemaining(targetUTC, yPer.start, yPer.end);
    yearWeekText.textContent = `第${yw.idx}週（残り${yw.remain}週）`;

    // week-of-fiscal-year
    const fPer = getFiscalPeriodFor(targetUTC);
    const fw = weekIndexAndRemaining(targetUTC, fPer.fyStart, fPer.fyEnd);
    const fyLabel = `${fPer.fyStart.getUTCFullYear()}年度`;
    fiscalWeekText.textContent = `${fyLabel} 第${fw.idx}週（残り${fw.remain}週）`;

    // holiday: async
    const reqId = ++lastReqId;
    holidayText.textContent = "判定中…";
    businessDayText.textContent = "判定中…";

    const result = await getHolidayByAPI(dateStr);
    if (reqId !== lastReqId) return;

    // rebuild badges after holiday result
    clearBadges();
    addBadge(isWeekend ? "土日" : "平日", isWeekend ? "ck-badge-warn" : "ck-badge-accent");

    let isHoliday = false;
    let holidayName = "";
    let holidayType = "";

    if (result.status === "holiday") {
      isHoliday = true;
      holidayName = result.name || "";
      holidayType = result.type || "";
      holidayText.textContent = "祝日";
      setHolidayName(holidayName);
      addBadge("祝日", "ck-badge-accent");
      if (holidayType) setNote(`種別：${holidayType}`);
    } else if (result.status === "not") {
      holidayText.textContent = "祝日ではありません";
      setHolidayName("");
      setNote("");
    } else {
      holidayText.textContent = "取得失敗（通信/応答）";
      setHolidayName("");
      setNote("ネットワーク状況を確認してください（曜日/暦日/差分/週番号は端末内で表示しています）。");
      addBadge("祝日判定失敗", "ck-badge-warn");
    }

    // business day decision (needs holiday + weekend)
    const isBusinessDay = (!isWeekend) && (!isHoliday);
    businessDayText.textContent = isBusinessDay ? "営業日" : "休業日（非営業日）";
    addBadge(isBusinessDay ? "営業日" : "休業日", isBusinessDay ? "ck-badge-accent" : "ck-badge-warn");
  }

  // ===== Events =====
  dateInput.addEventListener("change", function () {
    render(dateInput.value);
  });

  todayBtn.addEventListener("click", function () {
    const t = getTokyoTodayYMD();
    dateInput.value = t;
    render(t);
  });

  clearBtn.addEventListener("click", function () {
    dateInput.value = "";
    render("");
  });

  // ===== initial: set today (Tokyo) by default =====
  (function init() {
    const t = getTokyoTodayYMD();
    dateInput.value = t;
    render(t);
  })();
})();

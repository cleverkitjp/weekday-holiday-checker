(function () {
  "use strict";

  // ===== Config =====
  const API_BASE = "https://api.national-holidays.jp/"; // + YYYY-MM-DD
  const FETCH_TIMEOUT_MS = 4500;

  const CACHE_KEY = "ckHolidayCache_v1"; // localStorage
  const CACHE_TTL_MS = 120 * 24 * 60 * 60 * 1000; // 120 days (soft)

  // ===== DOM =====
  const dateInput = document.getElementById("dateInput");
  const todayBtn = document.getElementById("todayBtn");
  const clearBtn = document.getElementById("clearBtn");

  const datePretty = document.getElementById("datePretty");
  const badges = document.getElementById("badges");
  const dowText = document.getElementById("dowText");
  const holidayText = document.getElementById("holidayText");
  const holidayNameRow = document.getElementById("holidayNameRow");
  const holidayNameText = document.getElementById("holidayNameText");
  const noteText = document.getElementById("noteText");

  // ===== Helpers =====
  const DOW_JA = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
  const DOW_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function safeDateFromYMD(dateStr) {
    // Avoid timezone drift by anchoring at local midnight.
    // dateStr is "YYYY-MM-DD" from <input type="date">
    return new Date(dateStr + "T00:00:00");
  }

  function ymdPretty(dateStr) {
    // Keep it simple; common.css may already style typography.
    return dateStr ? dateStr : "—";
  }

  function clearBadges() {
    badges.innerHTML = "";
  }

  function addBadge(text, kind) {
    const span = document.createElement("span");
    span.className = "ck-badge" + (kind ? ` ${kind}` : "");
    span.textContent = text;
    badges.appendChild(span);
  }

  function setNote(msg) {
    noteText.textContent = msg || "";
  }

  function setHolidayName(name) {
    if (name) {
      holidayNameRow.hidden = false;
      holidayNameText.textContent = name;
    } else {
      holidayNameRow.hidden = true;
      holidayNameText.textContent = "—";
    }
  }

  // ===== Cache =====
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveCache(cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
      // ignore
    }
  }

  function getCached(dateStr) {
    const cache = loadCache();
    const v = cache[dateStr];
    if (!v) return null;

    // Soft TTL: if too old, ignore.
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
    // API examples: often array of objects [{date,name,type}]
    // but be tolerant.
    if (!json) return null;

    if (Array.isArray(json)) {
      const first = json[0];
      if (first && typeof first === "object") {
        return {
          name: first.name || first.title || "",
          type: first.type || "",
          date: first.date || ""
        };
      }
      return null;
    }

    if (typeof json === "object") {
      return {
        name: json.name || json.title || "",
        type: json.type || "",
        date: json.date || ""
      };
    }

    return null;
  }

  async function getHolidayByAPI(dateStr) {
    // 1) cache
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

      // If response shape unexpected, treat as error (but don't cache)
      return { status: "error", message: "unexpected response" };
    } catch (e) {
      // fetch aborted / offline / CORS / etc
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
      holidayText.textContent = "—";
      return;
    }

    datePretty.textContent = ymdPretty(dateStr);

    // local: day of week + weekend/weekday
    const d = safeDateFromYMD(dateStr);
    const dow = d.getDay();
    const isWeekend = (dow === 0 || dow === 6);

    dowText.textContent = `${DOW_JA[dow]} (${DOW_EN[dow]})`;
    addBadge(isWeekend ? "土日" : "平日", isWeekend ? "ck-badge-warn" : "ck-badge-accent");

    // holiday: async
    const reqId = ++lastReqId;
    holidayText.textContent = "判定中…";
    addBadge("祝日判定", "ck-badge");

    const result = await getHolidayByAPI(dateStr);
    if (reqId !== lastReqId) return; // ignore stale

    // re-render badges to reflect final status
    clearBadges();
    addBadge(isWeekend ? "土日" : "平日", isWeekend ? "ck-badge-warn" : "ck-badge-accent");

    if (result.status === "holiday") {
      addBadge("祝日", "ck-badge-accent");
      holidayText.textContent = "祝日";
      setHolidayName(result.name || "");
      setNote(result.type ? `種別：${result.type}` : "");
    } else if (result.status === "not") {
      holidayText.textContent = "祝日ではありません";
      setHolidayName("");
      setNote("");
    } else {
      holidayText.textContent = "取得失敗（通信/応答）";
      setHolidayName("");
      setNote("ネットワーク状況を確認してください（曜日と土日判定は端末内で表示しています）。");
      addBadge("祝日判定失敗", "ck-badge-warn");
    }
  }

  // ===== Events =====
  dateInput.addEventListener("change", function () {
    render(dateInput.value);
  });

  todayBtn.addEventListener("click", function () {
    const t = todayStr();
    dateInput.value = t;
    render(t);
  });

  clearBtn.addEventListener("click", function () {
    dateInput.value = "";
    render("");
  });

  // initial
  render(dateInput.value);
})();

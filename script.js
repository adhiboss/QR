const STUDENT_DB_KEY = "usn_student_db_v1";
const ATTENDANCE_KEY = "usn_attendance_v1";
const REJECTED_KEY = "usn_rejected_v1";
const PHOTO_DB_NAME = "usn_photo_store_v1";
const PHOTO_STORE_NAME = "scan_photos";
const MAX_RECENT = 100;
const MAX_PHOTO_ARCHIVE = 12;

let scanner = null;
let cameraStarted = false;
let paused = false;
let lastScanText = "";
let lastScanAt = 0;
let deferredInstallPrompt = null;
let photoDbPromise = null;
const photoUrlCache = new Map();

const els = {
	totalScans: document.getElementById("total-scans"),
	dbCount: document.getElementById("db-count"),
	absentCount: document.getElementById("absent-count"),
	lastScan: document.getElementById("last-scan"),
	recentList: document.getElementById("recent-list"),
	statusIndicator: document.getElementById("status-indicator"),
	scanActionBtn: document.getElementById("scan-action-btn"),
	manualIdInput: document.getElementById("manual-id-input"),
	manualSaveBtn: document.getElementById("manual-save-btn"),
	helpBtn: document.getElementById("help-btn"),
	exportCsvBtn: document.getElementById("export-csv-btn"),
	exportRejectedBtn: document.getElementById("export-rejected-btn"),
	forceSyncBtn: document.getElementById("force-sync-btn"),
	offlineList: document.getElementById("offline-list"),
	navItems: document.querySelectorAll(".nav-item"),
	tabContents: document.querySelectorAll(".tab-content"),
	connectionStatus: document.getElementById("connection-status"),
	pendingSync: document.getElementById("pending-sync"),
	pendingCount: document.getElementById("pending-count"),
	dbFileInput: document.getElementById("db-file-input"),
	loadDbBtn: document.getElementById("load-db-btn"),
	dbLoadMessage: document.getElementById("db-load-message")
};

function loadJson(key, fallback = []) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getStudentDb() {
  return loadJson(STUDENT_DB_KEY, []);
}

function setStudentDb(rows) {
  saveJson(STUDENT_DB_KEY, rows);
}

function getAttendance() {
  return loadJson(ATTENDANCE_KEY, []);
}

function setAttendance(rows) {
  saveJson(ATTENDANCE_KEY, rows);
}

function getRejected() {
  return loadJson(REJECTED_KEY, []);
}

function setRejected(rows) {
  saveJson(REJECTED_KEY, rows);
}

function openPhotoDatabase() {
  if (photoDbPromise) return photoDbPromise;

  photoDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(PHOTO_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE_NAME)) {
        db.createObjectStore(PHOTO_STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return photoDbPromise;
}

async function savePhotoRecord(blob, meta = {}) {
  const db = await openPhotoDatabase();
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    blob,
    createdAt: new Date().toISOString(),
    type: meta.type || "attendance",
    usn: meta.usn || "",
    attendanceId: meta.attendanceId || "",
    source: meta.source || "camera",
    label: meta.label || ""
  };

  await new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE_NAME, "readwrite");
    tx.objectStore(PHOTO_STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  return record;
}

async function listPhotoRecords(limit = MAX_PHOTO_ARCHIVE) {
  const db = await openPhotoDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE_NAME, "readonly");
    const store = tx.objectStore(PHOTO_STORE_NAME);
    const records = [];

    if (store.getAll) {
      const request = store.getAll();
      request.onsuccess = () => {
        const items = Array.isArray(request.result) ? request.result : [];
        items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        resolve(items.slice(0, limit));
      };
      request.onerror = () => reject(request.error);
      return;
    }

    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve(records.slice(0, limit));
        return;
      }
      records.push(cursor.value);
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
}

async function getPhotoObjectUrl(photoId) {
  if (!photoId) return null;
  if (photoUrlCache.has(photoId)) return photoUrlCache.get(photoId);

  const db = await openPhotoDatabase();
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE_NAME, "readonly");
    const request = tx.objectStore(PHOTO_STORE_NAME).get(photoId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });

  if (!record?.blob) return null;
  const url = URL.createObjectURL(record.blob);
  photoUrlCache.set(photoId, url);
  return url;
}

function clearPhotoCache() {
  for (const url of photoUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  photoUrlCache.clear();
}

async function clearPhotoStore() {
  clearPhotoCache();
  const db = await openPhotoDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE_NAME, "readwrite");
    tx.objectStore(PHOTO_STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function captureCameraFrameBlob() {
  const video = document.querySelector("#reader video");
  if (!video || video.readyState < 2) return null;

  const width = video.videoWidth || video.clientWidth || 640;
  const height = video.videoHeight || video.clientHeight || 480;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) return null;

  context.drawImage(video, 0, 0, width, height);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.86);
  });
}

async function attachPhotoToAttendance(attendanceId, photoId) {
  const attendance = getAttendance();
  const index = attendance.findIndex((item) => item.id === attendanceId);
  if (index === -1) return;

  attendance[index].photoId = photoId;
  attendance[index].photoAttachedAt = new Date().toISOString();
  setAttendance(attendance);
}

function normalizeUsn(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replaceAll(" ", "");
}

function normalizeSearch(raw) {
  return String(raw || "").trim().toLowerCase();
}

function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function matchesSearch(item, query) {
  if (!query) return true;
  const haystack = [item.usn, item.name, item.branch, item.section, item.source, item.reason]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function getStudentByUsn(usn) {
  const students = getStudentDb();
  return students.find((s) => s.usn === usn) || null;
}

function hasAttendance(usn) {
  const attendance = getAttendance();
  return attendance.some((a) => a.usn === usn);
}

function pushRejected(usn, reason, source) {
  const rejected = getRejected();
  rejected.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    usn,
    reason,
    source,
    ts: new Date().toISOString()
  });
  setRejected(rejected);
}

function markAttendance(rawUsn, source = "scan") {
  const usn = normalizeUsn(rawUsn);
  if (!usn) return null;

  const students = getStudentDb();
  if (students.length === 0) {
    setStatus("Load student database before scanning.", true);
    return null;
  }

  const student = getStudentByUsn(usn);
  if (!student) {
    pushRejected(usn, "USN not found in database", source);
    renderAll();
    setStatus(`Rejected: ${usn} not in database`, true);
    return null;
  }

  if (hasAttendance(usn)) {
    pushRejected(usn, "Duplicate attendance attempt", source);
    renderAll();
    setStatus(`Duplicate: ${usn} already marked`, true);
    return null;
  }

  const attendance = getAttendance();
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    usn: student.usn,
    name: student.name,
    branch: student.branch,
    section: student.section,
    source,
    ts: new Date().toISOString(),
    photoId: ""
  };
  attendance.push(record);
  setAttendance(attendance);
  renderAll();
  setStatus(`Present marked: ${student.usn} (${student.name})`);
  return record;
}

//Funtion call //
function renderStats() {
  const students = getStudentDb();
  const attendance = getAttendance();
  const rejected = getRejected();
  const present = attendance.length;
  const total = students.length;
  const absent = Math.max(total - present, 0);
  const rate = total > 0 ? Math.round((present / total) * 100) : 0;

  if (els.totalScans) els.totalScans.textContent = String(present);
  if (els.dbCount) els.dbCount.textContent = String(total);
  if (els.absentCount) els.absentCount.textContent = String(absent);
  if (els.attendanceRate) els.attendanceRate.textContent = `${rate}%`;
  if (els.rejectedCount) els.rejectedCount.textContent = String(rejected.length);
  if (els.roomName) els.roomName.textContent = "Local only";

  if (els.dbLoadMessage) {
    if (total > 0) {
      els.dbLoadMessage.textContent = `Loaded ${total} students.`;
    } else {
      els.dbLoadMessage.textContent = "No database loaded.";
    }
  }

  if (els.directoryCount) els.directoryCount.textContent = `${total} students`;
  if (els.directoryPresentCount) els.directoryPresentCount.textContent = `${present} present`;
  if (els.dataUpdatedAt) els.dataUpdatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;

  if (els.pendingSync && els.pendingCount) {
    els.pendingSync.classList.add("hidden");
    els.pendingCount.textContent = "0";
  }
}

function renderRecent() {
  if (!els.recentList) return;
  const attendance = getAttendance();
  const query = normalizeSearch(els.attendanceSearchInput?.value);
  const filtered = attendance.filter((item) => matchesSearch(item, query));
  els.recentList.innerHTML = "";

  if (attendance.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No attendance yet";
    els.recentList.appendChild(li);
    if (els.lastScan) els.lastScan.textContent = "None";
    return;
  }

  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.textContent = query ? "No matching attendance records" : "No attendance yet";
    els.recentList.appendChild(li);
    if (els.lastScan) {
      const latest = attendance[attendance.length - 1];
      els.lastScan.textContent = `${latest.usn} - ${latest.name}`;
    }
    return;
  }

  const latest = attendance[attendance.length - 1];
  if (els.lastScan) {
    els.lastScan.textContent = `${latest.usn} - ${latest.name}`;
  }

  const recent = filtered.slice(-MAX_RECENT).reverse();
  for (const item of recent) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeHtml(item.usn)}</strong> | ${escapeHtml(item.name)} | ${escapeHtml(item.branch || "-")} | ${escapeHtml(item.source || "scan")} | ${formatTime(item.ts)}`;
    els.recentList.appendChild(li);
  }
}

function renderStudentDirectory() {
  if (!els.studentList) return;
  const students = getStudentDb();
  const attendance = getAttendance();
  const presentSet = new Set(attendance.map((item) => item.usn));
  const query = normalizeSearch(els.studentSearchInput?.value);
  const filtered = students.filter((student) => matchesSearch(student, query));

  els.studentList.innerHTML = "";

  if (students.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Load a student database to browse the directory.";
    els.studentList.appendChild(li);
    return;
  }

  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No students match the current filter.";
    els.studentList.appendChild(li);
    return;
  }

  for (const student of filtered) {
    const present = presentSet.has(student.usn);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="student-main">
        <strong>${escapeHtml(student.usn)} ${escapeHtml(student.name)}</strong>
        <span class="student-sub">${escapeHtml(student.branch || "-")} • Section ${escapeHtml(student.section || "-")}</span>
      </div>
      <span class="student-pill ${present ? "present" : "absent"}">${present ? "Present" : "Pending"}</span>
    `;
    els.studentList.appendChild(li);
  }
}

function renderRejectedList() {
  if (!els.offlineList) return;
  const rejected = getRejected();
  els.offlineList.innerHTML = "";

  if (rejected.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No rejected attempts";
    els.offlineList.appendChild(li);
    return;
  }

  const recent = rejected.slice(-MAX_RECENT).reverse();
  for (const item of recent) {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeHtml(item.usn)}</strong> | ${escapeHtml(item.reason)} | ${escapeHtml(item.source || "scan")} | ${formatTime(item.ts)}`;
    els.offlineList.appendChild(li);
  }
}

async function renderPhotoArchive() {
  if (!els.photoArchiveList) return;

  els.photoArchiveList.innerHTML = "";
  try {
    const records = await listPhotoRecords(MAX_PHOTO_ARCHIVE);

    if (els.photoCount) {
      els.photoCount.textContent = `${records.length} photos`;
    }

    if (records.length === 0) {
      const li = document.createElement("li");
      li.textContent = "No photos captured yet.";
      els.photoArchiveList.appendChild(li);
      return;
    }

    for (const record of records) {
      const li = document.createElement("li");
      li.className = "photo-card";
      li.innerHTML = `
        <div class="photo-thumb-wrap">
          <img class="photo-thumb" alt="Captured scan photo" />
        </div>
        <div class="photo-meta">
          <strong>${escapeHtml(record.type === "snapshot" ? record.label || "Snapshot" : record.usn || "Attendance scan")}</strong>
          <span>${escapeHtml(formatTime(record.createdAt))}</span>
          <small>${escapeHtml(record.type === "snapshot" ? "Manual snapshot" : `${record.source || "camera"} scan`)}</small>
        </div>
      `;
      els.photoArchiveList.appendChild(li);

      const img = li.querySelector("img");
      if (img) {
        const url = await getPhotoObjectUrl(record.id);
        if (url) img.src = url;
      }
    }
  } catch (error) {
    console.error(error);
    const li = document.createElement("li");
    li.textContent = "Could not load stored photos.";
    els.photoArchiveList.appendChild(li);
  }
}

function renderAll() {
  renderStats();
  renderRecent();
  renderStudentDirectory();
  renderRejectedList();
  void renderPhotoArchive();
}

function setStatus(message, isError = false) {
  if (!els.statusIndicator) return;
  const statusIndicator = els.statusIndicator;
  statusIndicator.style.display = "block";
  statusIndicator.textContent = message;
  statusIndicator.style.color = isError ? "#ef4444" : "#bdf7d2";
}

function setConnectionBadge() {
  if (!els.connectionStatus) return;
  if (navigator.onLine) {
    els.connectionStatus.textContent = "🟢 Online";
    els.connectionStatus.classList.remove("offline");
    els.connectionStatus.classList.add("online");
  } else {
    els.connectionStatus.textContent = "⚪ Offline";
    els.connectionStatus.classList.remove("online");
    els.connectionStatus.classList.add("offline");
  }
}

function toCsvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadAttendanceCsv() {
  const attendance = getAttendance();
  if (attendance.length === 0) {
    alert("No attendance data to export.");
    return;
  }

  const rows = ["id,usn,name,branch,section,source,timestamp"];
  for (const item of attendance) {
    rows.push([
      toCsvCell(item.id),
      toCsvCell(item.usn),
      toCsvCell(item.name),
      toCsvCell(item.branch),
      toCsvCell(item.section),
      toCsvCell(item.source),
      toCsvCell(item.ts)
    ].join(","));
  }
  downloadFile(rows.join("\n"), `attendance-${new Date().toISOString().slice(0, 10)}.csv`);
}

function downloadRejectedCsv() {
  const rejected = getRejected();
  if (rejected.length === 0) {
    alert("No rejected attempts to export.");
    return;
  }

  const rows = ["id,usn,reason,source,timestamp"];
  for (const item of rejected) {
    rows.push([
      toCsvCell(item.id),
      toCsvCell(item.usn),
      toCsvCell(item.reason),
      toCsvCell(item.source),
      toCsvCell(item.ts)
    ].join(","));
  }
  downloadFile(rows.join("\n"), `rejected-${new Date().toISOString().slice(0, 10)}.csv`);
}

function downloadFile(content, filename) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function findUsnIndex(headers) {
  const idx = headers.findIndex((h) => normalizeUsn(h) === "USN");
  return idx >= 0 ? idx : 0;
}

function parseStudentCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const headerParts = lines[0].split(",").map((part) => part.trim());
  const usnIndex = findUsnIndex(headerParts);
  const nameIndex = headerParts.findIndex((h) => normalizeUsn(h) === "NAME");
  const branchIndex = headerParts.findIndex((h) => normalizeUsn(h) === "BRANCH");
  const sectionIndex = headerParts.findIndex((h) => normalizeUsn(h) === "SECTION");

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",").map((col) => col.trim());
    const usn = normalizeUsn(cols[usnIndex] || "");
    if (!usn) continue;
    rows.push({
      usn,
      name: (nameIndex >= 0 ? cols[nameIndex] : "") || "Unknown",
      branch: (branchIndex >= 0 ? cols[branchIndex] : "") || "",
      section: (sectionIndex >= 0 ? cols[sectionIndex] : "") || ""
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.usn)) continue;
    seen.add(row.usn);
    deduped.push(row);
  }
  return deduped;
}

async function loadDatabaseFromFile() {
  const file = els.dbFileInput?.files?.[0];
  if (!file) {
    setStatus("Choose a CSV file first.", true);
    return;
  }

  try {
    const text = await file.text();
    const students = parseStudentCsv(text);
    if (students.length === 0) {
      setStatus("No valid USN rows found in CSV.", true);
      return;
    }

    setStudentDb(students);
    setAttendance([]);
    setRejected([]);
    await clearPhotoStore();
    renderAll();
    setStatus(`Database loaded: ${students.length} students. Attendance reset.`);
  } catch (error) {
    console.error(error);
    setStatus("Could not read database CSV file.", true);
  }
}

async function startCamera() {
  if (cameraStarted) return;

  if (!window.Html5Qrcode) {
    setStatus("Scanner library failed to load.", true);
    if (els.scanActionBtn) {
      els.scanActionBtn.disabled = true;
      els.scanActionBtn.textContent = "Scanner Unavailable";
    }
    return;
  }

  if (!document.getElementById("reader")) {
    setStatus("Reader element not found.", true);
    return;
  }

  scanner = new Html5Qrcode("reader");

  try {
    setStatus("Starting camera...");
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        const now = Date.now();
        if (decodedText === lastScanText && now - lastScanAt < 1200) return;
        lastScanText = decodedText;
        lastScanAt = now;
        void handleDecodedScan(decodedText, "camera");
      },
      () => {}
    );

    cameraStarted = true;
    paused = false;
    if (els.scanActionBtn) {
      els.scanActionBtn.disabled = false;
      els.scanActionBtn.textContent = "Pause Scan";
    }
    if (els.snapshotBtn) {
      els.snapshotBtn.disabled = false;
    }
    setStatus("Camera ready. Load database and scan USNs.");
  } catch (error) {
    setStatus("Could not start camera. Allow camera permission and reload.", true);
    if (els.scanActionBtn) {
      els.scanActionBtn.disabled = true;
      els.scanActionBtn.textContent = "Camera Error";
    }
    if (els.snapshotBtn) {
      els.snapshotBtn.disabled = true;
    }
    console.error(error);
  }
}

async function handleDecodedScan(decodedText, source = "scan") {
  const attendanceRecord = markAttendance(decodedText, source);
  if (!attendanceRecord) return;

  if (source === "camera") {
    const blob = await captureCameraFrameBlob();
    if (!blob) return;

    const photoRecord = await savePhotoRecord(blob, {
      type: "attendance",
      usn: attendanceRecord.usn,
      attendanceId: attendanceRecord.id,
      source
    });

    await attachPhotoToAttendance(attendanceRecord.id, photoRecord.id);
    renderAll();
    setStatus(`Present marked and photo stored: ${attendanceRecord.usn}`);
  }
}

async function captureManualSnapshot() {
  if (!cameraStarted) {
    setStatus("Start the camera before capturing a snapshot.", true);
    return;
  }

  const blob = await captureCameraFrameBlob();
  if (!blob) {
    setStatus("Could not capture a snapshot from the camera.", true);
    return;
  }

  await savePhotoRecord(blob, {
    type: "snapshot",
    label: `Snapshot ${new Date().toLocaleTimeString()}`,
    source: "manual"
  });
  renderAll();
  setStatus("Snapshot captured and stored.");
}

async function togglePause() {
  if (!scanner || !cameraStarted) return;

  try {
    if (paused) {
      await scanner.resume();
      paused = false;
      if (els.scanActionBtn) els.scanActionBtn.textContent = "Pause Scan";
      setStatus("Scanner resumed.");
    } else {
      await scanner.pause();
      paused = true;
      if (els.scanActionBtn) els.scanActionBtn.textContent = "Resume Scan";
      setStatus("Scanner paused.");
    }
  } catch (error) {
    console.error(error);
    setStatus("Could not toggle scanner state.", true);
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("Service worker registration failed:", error);
  }
}

function setupPwaInstall() {
  if (!els.installAppBtn) return;

  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (isStandalone) {
    els.installAppBtn.classList.add("hidden");
    return;
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    els.installAppBtn.classList.remove("hidden");
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    els.installAppBtn.classList.add("hidden");
    setStatus("App installed. Launch it from your home screen.");
  });

  els.installAppBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      setStatus("Install prompt is not ready yet.", true);
      return;
    }

    deferredInstallPrompt.prompt();
    const choiceResult = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installAppBtn.classList.add("hidden");

    if (choiceResult.outcome === "accepted") {
      setStatus("Install request accepted.");
    } else {
      setStatus("Install dismissed.");
    }
  });
}

function setupTabs() {
  if (!els.navItems.length || !els.tabContents.length) return;

  for (const btn of els.navItems) {
    btn.addEventListener("click", () => {
      for (const navBtn of els.navItems) navBtn.classList.remove("active");
      btn.classList.add("active");

      const targetId = btn.dataset.target;
      for (const tab of els.tabContents) {
        const active = tab.id === targetId;
        tab.classList.toggle("active", active);
        tab.classList.toggle("hidden", !active);
      }
    });
  }
}

function setupEvents() {
 feature
	els.loadDbBtn?.addEventListener("click", loadDatabaseFromFile);

	els.manualSaveBtn?.addEventListener("click", () => {
		const value = els.manualIdInput?.value || "";
		if (!value.trim()) return;
		markAttendance(value, "manual");
		els.manualIdInput.value = "";
	});

	els.manualIdInput?.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			els.manualSaveBtn?.click();
		}
	});

	els.scanActionBtn?.addEventListener("click", togglePause);
	els.exportCsvBtn?.addEventListener("click", downloadAttendanceCsv);
	els.exportRejectedBtn?.addEventListener("click", downloadRejectedCsv);
	els.forceSyncBtn?.addEventListener("click", () => {
		setRejected([]);
		renderAll();
		setStatus("Rejected log cleared.");
	});

	els.helpBtn?.addEventListener("click", () => {
		alert("📖 HELP\n\n1. Load Database: Upload CSV with student info\n2. Scan QR: Point camera at QR codes\n3. Manual Entry: Type USN if QR fails\n4. View Stats: See attendance summary\n5. Sync Room: Connect multiple devices\n6. Export: Download attendance as CSV\n7. Data Tab: Manage rejected scans\n\n💡 Tip: Use external scanners for faster entry!");
	});

	window.addEventListener("online", setConnectionBadge);
	window.addEventListener("offline", setConnectionBadge);

  els.loadDbBtn?.addEventListener("click", loadDatabaseFromFile);
  els.attendanceSearchInput?.addEventListener("input", renderRecent);
  els.studentSearchInput?.addEventListener("input", renderStudentDirectory);

  els.manualSaveBtn?.addEventListener("click", () => {
    const value = els.manualIdInput?.value || "";
    if (!value.trim()) return;
    markAttendance(value, "manual");
    if (els.manualIdInput) els.manualIdInput.value = "";
  });

  els.manualIdInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      els.manualSaveBtn?.click();
    }
  });

  els.scanActionBtn?.addEventListener("click", togglePause);
  els.snapshotBtn?.addEventListener("click", () => {
    void captureManualSnapshot();
  });
  els.exportCsvBtn?.addEventListener("click", downloadAttendanceCsv);
  els.exportRejectedBtn?.addEventListener("click", downloadRejectedCsv);
  els.forceSyncBtn?.addEventListener("click", () => {
    setRejected([]);
    renderAll();
    setStatus("Rejected log cleared.");
  });
  els.clearAttendanceBtn?.addEventListener("click", () => {
    if (confirm("Clear all attendance records? This cannot be undone.")) {
      setAttendance([]);
      renderAll();
      setStatus("All attendance records cleared.");
    }
  });

  window.addEventListener("online", setConnectionBadge);
  window.addEventListener("offline", setConnectionBadge);
 main
}

document.addEventListener("DOMContentLoaded", async () => {
  renderAll();
  setupTabs();
  setupEvents();
  setupPwaInstall();
  await registerServiceWorker();
  setConnectionBadge();
  await startCamera();
});


const STUDENT_DB_KEY = "usn_student_db_v1";
const ATTENDANCE_KEY = "usn_attendance_v1";
const REJECTED_KEY = "usn_rejected_v1";
const MAX_RECENT = 100;

let scanner = null;
let cameraStarted = false;
let paused = false;
let lastScanText = "";
let lastScanAt = 0;

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

function normalizeUsn(raw) {
	return String(raw || "")
		.trim()
		.toUpperCase()
		.replaceAll(" ", "");
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
	if (!usn) return;

	const students = getStudentDb();
	if (students.length === 0) {
		setStatus("Load student database before scanning.", true);
		return;
	}

	const student = getStudentByUsn(usn);
	if (!student) {
		pushRejected(usn, "USN not found in database", source);
		renderAll();
		setStatus(`Rejected: ${usn} not in database`, true);
		return;
	}

	if (hasAttendance(usn)) {
		pushRejected(usn, "Duplicate attendance attempt", source);
		renderAll();
		setStatus(`Duplicate: ${usn} already marked`, true);
		return;
	}

	const attendance = getAttendance();
	attendance.push({
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		usn: student.usn,
		name: student.name,
		branch: student.branch,
		section: student.section,
		source,
		ts: new Date().toISOString()
	});
	setAttendance(attendance);
	renderAll();
	setStatus(`Present marked: ${student.usn} (${student.name})`);
}

//Funtion call //
function renderStats() {
	const students = getStudentDb();
	const attendance = getAttendance();
	const present = attendance.length;
	const total = students.length;
	const absent = Math.max(total - present, 0);

	if (els.totalScans) els.totalScans.textContent = `Present: ${present}`;
	if (els.dbCount) els.dbCount.textContent = `Database: ${total}`;
	if (els.absentCount) els.absentCount.textContent = `Absent: ${absent}`;

	if (els.dbLoadMessage) {
		if (total > 0) {
			els.dbLoadMessage.textContent = `Loaded ${total} students.`;
		} else {
			els.dbLoadMessage.textContent = "No database loaded.";
		}
	}

	if (els.pendingSync && els.pendingCount) {
		els.pendingSync.classList.add("hidden");
		els.pendingCount.textContent = "0";
	}
}

function renderRecent() {
	if (!els.recentList) return;
	const attendance = getAttendance();
	els.recentList.innerHTML = "";

	if (attendance.length === 0) {
		const li = document.createElement("li");
		li.textContent = "No attendance yet";
		els.recentList.appendChild(li);
		if (els.lastScan) els.lastScan.textContent = "None";
		return;
	}

	const latest = attendance[attendance.length - 1];
	if (els.lastScan) {
		els.lastScan.textContent = `${latest.usn} - ${latest.name}`;
	}

	const recent = attendance.slice(-MAX_RECENT).reverse();
	for (const item of recent) {
		const li = document.createElement("li");
		li.innerHTML = `<strong>${escapeHtml(item.usn)}</strong> | ${escapeHtml(item.name)} | ${escapeHtml(item.branch || "-")} | ${formatTime(item.ts)}`;
		els.recentList.appendChild(li);
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
		li.innerHTML = `<strong>${escapeHtml(item.usn)}</strong> | ${escapeHtml(item.reason)} | ${formatTime(item.ts)}`;
		els.offlineList.appendChild(li);
	}
}

function renderAll() {
	renderStats();
	renderRecent();
	renderRejectedList();
}

function setStatus(message, isError = false) {
	if (!els.statusIndicator) return;
	els.statusIndicator.style.display = "block";
	els.statusIndicator.textContent = message;
	els.statusIndicator.style.color = isError ? "#ef4444" : "#22c55e";
}

function setConnectionBadge() {
	if (!els.connectionStatus) return;
	if (navigator.onLine) {
		els.connectionStatus.textContent = "Online";
		els.connectionStatus.classList.remove("offline");
		els.connectionStatus.classList.add("online");
	} else {
		els.connectionStatus.textContent = "Offline";
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
		.map((l) => l.trim())
		.filter(Boolean);

	if (lines.length === 0) return [];

	const headerParts = lines[0].split(",").map((p) => p.trim());
	const usnIndex = findUsnIndex(headerParts);
	const nameIndex = headerParts.findIndex((h) => normalizeUsn(h) === "NAME");
	const branchIndex = headerParts.findIndex((h) => normalizeUsn(h) === "BRANCH");
	const sectionIndex = headerParts.findIndex((h) => normalizeUsn(h) === "SECTION");

	const rows = [];
	for (let i = 1; i < lines.length; i += 1) {
		const cols = lines[i].split(",").map((c) => c.trim());
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
				markAttendance(decodedText, "camera");
			},
			() => {}
		);

		cameraStarted = true;
		paused = false;
		if (els.scanActionBtn) {
			els.scanActionBtn.disabled = false;
			els.scanActionBtn.textContent = "Pause Scan";
		}
		setStatus("Camera ready. Load database and scan USNs.");
	} catch (error) {
		setStatus("Could not start camera. Allow camera permission and reload.", true);
		if (els.scanActionBtn) {
			els.scanActionBtn.disabled = true;
			els.scanActionBtn.textContent = "Camera Error";
		}
		console.error(error);
	}
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

	window.addEventListener("online", setConnectionBadge);
	window.addEventListener("offline", setConnectionBadge);
}

document.addEventListener("DOMContentLoaded", async () => {
	renderAll();
	setupTabs();
	setupEvents();
	setConnectionBadge();
	await startCamera();
});

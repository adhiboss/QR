const STORAGE_KEY = "qr_scan_history_v1";
const MAX_RECENT = 100;

let scanner = null;
let cameraStarted = false;
let paused = false;
let lastScanText = "";
let lastScanAt = 0;

const els = {
	totalScans: document.getElementById("total-scans"),
	lastScan: document.getElementById("last-scan"),
	recentList: document.getElementById("recent-list"),
	scanQty: document.getElementById("scan-qty"),
	statusIndicator: document.getElementById("status-indicator"),
	scanActionBtn: document.getElementById("scan-action-btn"),
	manualIdInput: document.getElementById("manual-id-input"),
	manualSaveBtn: document.getElementById("manual-save-btn"),
	exportCsvBtn: document.getElementById("export-csv-btn"),
	forceSyncBtn: document.getElementById("force-sync-btn"),
	offlineList: document.getElementById("offline-list"),
	navItems: document.querySelectorAll(".nav-item"),
	tabContents: document.querySelectorAll(".tab-content"),
	connectionStatus: document.getElementById("connection-status"),
	pendingSync: document.getElementById("pending-sync"),
	pendingCount: document.getElementById("pending-count")
};

function getHistory() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveHistory(entries) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function formatTime(isoString) {
	const date = new Date(isoString);
	return date.toLocaleString();
}

function renderStats(history) {
	if (els.totalScans) {
		els.totalScans.textContent = `Total: ${history.length}`;
	}
	if (els.pendingSync && els.pendingCount) {
		els.pendingSync.classList.add("hidden");
		els.pendingCount.textContent = "0";
	}
}

function renderRecent(history) {
	if (!els.recentList) return;
	els.recentList.innerHTML = "";

	if (history.length === 0) {
		const li = document.createElement("li");
		li.textContent = "No scans yet";
		els.recentList.appendChild(li);
		if (els.lastScan) els.lastScan.textContent = "None";
		return;
	}

	const latest = history[history.length - 1];
	if (els.lastScan) {
		els.lastScan.textContent = `${latest.text} x${latest.qty}`;
	}

	const recent = history.slice(-MAX_RECENT).reverse();
	for (const item of recent) {
		const li = document.createElement("li");
		li.innerHTML = `<strong>${escapeHtml(item.text)}</strong> | Qty: ${item.qty} | ${formatTime(item.ts)}`;
		els.recentList.appendChild(li);
	}
}

function renderOfflineQueue() {
	if (!els.offlineList) return;
	els.offlineList.innerHTML = "";
	const li = document.createElement("li");
	li.textContent = "No pending offline items";
	els.offlineList.appendChild(li);
}

function renderAll() {
	const history = getHistory();
	renderStats(history);
	renderRecent(history);
	renderOfflineQueue();
}

function getQty() {
	const value = Number(els.scanQty?.value || 1);
	if (!Number.isFinite(value) || value < 1) return 1;
	return Math.floor(value);
}

function addCapture(text, source = "scan") {
	const clean = String(text || "").trim();
	if (!clean) return;

	const entry = {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		text: clean,
		qty: getQty(),
		source,
		ts: new Date().toISOString()
	};

	const history = getHistory();
	history.push(entry);
	saveHistory(history);
	renderAll();
}

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
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

function downloadCsv() {
	const history = getHistory();
	if (history.length === 0) {
		alert("No scans to export.");
		return;
	}

	const rows = ["id,text,qty,source,timestamp"];
	for (const item of history) {
		const text = String(item.text).replaceAll('"', '""');
		rows.push(`${item.id},"${text}",${item.qty},${item.source},${item.ts}`);
	}

	const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `scans-${new Date().toISOString().slice(0, 10)}.csv`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
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
				// Ignore duplicate reads fired rapidly by the camera stream.
				if (decodedText === lastScanText && now - lastScanAt < 1200) return;
				lastScanText = decodedText;
				lastScanAt = now;
				addCapture(decodedText, "camera");
				setStatus(`Captured: ${decodedText}`);
			},
			() => {
				// Ignore decode errors from non-code frames.
			}
		);

		cameraStarted = true;
		paused = false;
		if (els.scanActionBtn) {
			els.scanActionBtn.disabled = false;
			els.scanActionBtn.textContent = "Pause Scan";
		}
		setStatus("Camera ready. Scan a code.");
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
	els.manualSaveBtn?.addEventListener("click", () => {
		const value = els.manualIdInput?.value || "";
		if (!value.trim()) return;
		addCapture(value, "manual");
		els.manualIdInput.value = "";
		setStatus("Saved manual entry.");
	});

	els.manualIdInput?.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			els.manualSaveBtn?.click();
		}
	});

	els.scanActionBtn?.addEventListener("click", togglePause);
	els.exportCsvBtn?.addEventListener("click", downloadCsv);
	els.forceSyncBtn?.addEventListener("click", () => {
		setStatus("No offline items to sync.");
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

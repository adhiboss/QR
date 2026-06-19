// --- CONFIGURATION ---
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxKHjx1ylCUzf5_9cPB20AwzCdmDFRRpmtORFRFcheDjCKf8L1QglpEr9lreAyKRkAG2g/exec';

// --- STATE ---
let totalScans = 0;
let isProcessing = false;
let manualScanRequested = false;
let scannedToday = new Set();
let offlineQueue = JSON.parse(localStorage.getItem('offlineQueue') || '[]');
let currentRoom = null;
let peer = null;
let connections = [];

// --- DOM ELEMENTS ---
const totalScansEl = document.getElementById('total-scans');
const statusIndicatorEl = document.getElementById('status-indicator');
const scanActionBtn = document.getElementById('scan-action-btn');
const manualIdInput = document.getElementById('manual-id-input');
const manualSaveBtn = document.getElementById('manual-save-btn');
const lastScanEl = document.getElementById('last-scan');
const recentListEl = document.getElementById('recent-list');
const scanFrameEl = document.querySelector('.scan-frame');
const scanQtyInput = document.getElementById('scan-qty');

// Sync & Online UI
const connStatusEl = document.getElementById('connection-status');
const pendingSyncEl = document.getElementById('pending-sync');
const pendingCountEl = document.getElementById('pending-count');
const offlineListEl = document.getElementById('offline-list');
const forceSyncBtn = document.getElementById('force-sync-btn');

// Tabs
const navItems = document.querySelectorAll('.nav-item');
const tabContents = document.querySelectorAll('.tab-content');

// --- INITIALIZE UI ---
updateOfflineUI();

// --- TAB NAVIGATION ---
navItems.forEach(btn => {
    btn.addEventListener('click', () => {
        navItems.forEach(n => n.classList.remove('active'));
        tabContents.forEach(t => t.classList.add('hidden'));
        
        btn.classList.add('active');
        document.getElementById(btn.dataset.target).classList.remove('hidden');
    });
});

// --- OFFLINE & NETWORK STATUS ---
window.addEventListener('online', () => {
    connStatusEl.className = 'status-pill online';
    connStatusEl.innerText = '🟢 Online';
    syncOfflineQueue();
});

window.addEventListener('offline', () => {
    connStatusEl.className = 'status-pill offline';
    connStatusEl.innerText = '🔴 Offline';
});

function updateOfflineUI() {
    pendingCountEl.innerText = offlineQueue.length;
    if (offlineQueue.length > 0) {
        pendingSyncEl.classList.remove('hidden');
    } else {
        pendingSyncEl.classList.add('hidden');
    }
    
    offlineListEl.innerHTML = '';
    offlineQueue.forEach(item => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${item.id}</span> <span>(Qty: ${item.qty})</span>`;
        offlineListEl.appendChild(li);
    });
}

// --- SCAN HANDLERS ---
scanActionBtn.addEventListener('click', () => {
    manualScanRequested = true;
    scanActionBtn.disabled = true;
    scanActionBtn.innerText = "Scanning... Point at QR";
    statusIndicatorEl.style.display = 'block';
    showStatus('Looking for code...', '');
});

manualSaveBtn.addEventListener('click', () => {
    const studentId = manualIdInput.value.trim();
    if (!studentId) return;
    manualIdInput.value = '';
    processScanResult(studentId);
});

// External Scanner (Keystroke detection)
let keyBuffer = '';
let keyTimer = null;
document.addEventListener('keydown', (e) => {
    // Ignore if typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    if (e.key === 'Enter') {
        if (keyBuffer.length > 2) {
            processScanResult(keyBuffer);
        }
        keyBuffer = '';
        clearTimeout(keyTimer);
        return;
    }
    
    // Alphanumeric keys
    if (e.key.length === 1) {
        keyBuffer += e.key;
        clearTimeout(keyTimer);
        // Scanners usually type very fast (< 30ms per char)
        keyTimer = setTimeout(() => { keyBuffer = ''; }, 100);
    }
});

async function onScanSuccess(decodedText, decodedResult) {
    if (!manualScanRequested) return; 
    
    const studentId = decodedText.trim();
    if (!studentId) return;

    manualScanRequested = false;
    scanFrameEl.classList.add('success-anim');
    setTimeout(() => scanFrameEl.classList.remove('success-anim'), 500);
    
    await processScanResult(studentId);
}

// --- CORE PROCESSING LOGIC ---
async function processScanResult(studentId) {
    if (isProcessing) return; 
    isProcessing = true;
    
    const qty = parseInt(scanQtyInput.value) || 1;
    
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    const duplicateKey = `${studentId}-${dateStr}`;
    if (scannedToday.has(duplicateKey)) {
        showStatus(`✅ Already Scanned<br><small>${studentId}</small>`, 'warning');
        setTimeout(() => { isProcessing = false; resetStatus(); }, 2500);
        return;
    }

    showStatus(`Saving ${studentId}...`, '');
    playBeep();
    
    const payload = { id: studentId, date: dateStr, time: timeStr, qty: qty };
    
    // Broadcast to peers if connected
    broadcastScan(payload);

    if (navigator.onLine) {
        try {
            await sendToSheet([payload]);
            handleSuccess(studentId, timeStr, duplicateKey);
        } catch (error) {
            queueOffline(payload);
            handleSuccess(studentId, timeStr, duplicateKey, true);
        }
    } else {
        queueOffline(payload);
        handleSuccess(studentId, timeStr, duplicateKey, true);
    }

    setTimeout(() => { isProcessing = false; resetStatus(); }, 2000);
}

function queueOffline(payload) {
    offlineQueue.push(payload);
    localStorage.setItem('offlineQueue', JSON.stringify(offlineQueue));
    updateOfflineUI();
}

async function sendToSheet(payloadArray) {
    // For bulk uploads and CORS avoidance, we use a simple text/plain POST that is processed by Apps Script's doPost
    const response = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify(payloadArray)
    });
    const result = await response.json();
    if (result.status !== 'success') throw new Error('Server error');
}

forceSyncBtn.addEventListener('click', syncOfflineQueue);

async function syncOfflineQueue() {
    if (offlineQueue.length === 0 || !navigator.onLine) return;
    
    forceSyncBtn.innerText = "Syncing...";
    forceSyncBtn.disabled = true;
    
    try {
        await sendToSheet(offlineQueue);
        offlineQueue = [];
        localStorage.removeItem('offlineQueue');
        updateOfflineUI();
        showStatus(`✅ Synced offline data`, 'success');
        setTimeout(resetStatus, 3000);
    } catch (e) {
        console.error("Sync failed", e);
    } finally {
        forceSyncBtn.innerText = "🔄 Force Sync Now";
        forceSyncBtn.disabled = false;
    }
}

// --- UI HELPERS ---
function handleSuccess(studentId, timeStr, duplicateKey, isOffline = false) {
    scannedToday.add(duplicateKey);
    totalScans++;
    totalScansEl.innerText = `Total: ${totalScans}`;
    lastScanEl.innerText = studentId;
    
    if (isOffline) {
        showStatus(`💾 Saved Offline<br><small>${studentId}</small>`, 'warning');
    } else {
        showStatus(`✅ Recorded<br><small>${studentId}</small>`, 'success');
    }
    
    const li = document.createElement('li');
    li.innerHTML = `<span class="scan-id">${studentId}</span><span class="scan-time">${timeStr}</span>`;
    recentListEl.prepend(li);
    if (recentListEl.children.length > 50) recentListEl.removeChild(recentListEl.lastChild);
}

function showStatus(message, type) {
    statusIndicatorEl.innerHTML = message;
    statusIndicatorEl.className = 'status-indicator ' + type;
    statusIndicatorEl.style.display = 'flex';
}

function resetStatus() {
    if (!isProcessing) {
        scanActionBtn.disabled = false;
        scanActionBtn.innerText = "Click to Scan Code";
        statusIndicatorEl.style.display = 'none';
    }
}

function onScanFailure() {}

// --- AUDIO (Beep Sound) ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(900, audioCtx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.15);
}

// --- INITIALIZE SCANNER ---
document.addEventListener("DOMContentLoaded", () => {
    const html5QrCode = new Html5Qrcode("reader");
    const config = { fps: 10, qrbox: { width: 200, height: 200 }, aspectRatio: 1.0, disableFlip: false };

    html5QrCode.start({ facingMode: "environment" }, config, onScanSuccess, onScanFailure)
    .then(() => resetStatus())
    .catch(err => {
        html5QrCode.start({ facingMode: "user" }, config, onScanSuccess, onScanFailure)
        .then(() => resetStatus())
        .catch(fallbackErr => {
            showStatus(`❌ Camera Error<br><small>Please check permissions</small>`, 'error');
        });
    });
});

// --- PEERJS SYNC LOGIC ---
const createRoomBtn = document.getElementById('create-room-btn');
const joinRoomBtn = document.getElementById('join-room-btn');
const joinRoomInput = document.getElementById('join-room-input');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const setupUI = document.getElementById('sync-setup-ui');
const activeSyncUI = document.getElementById('active-sync-ui');
const activeRoomIdEl = document.getElementById('active-room-id');
const peerCountEl = document.getElementById('peer-count');
const peerListEl = document.getElementById('peer-list');
const roomBadge = document.getElementById('room-badge');
const roomNameEl = document.getElementById('room-name');

function initPeer() {
    if (peer) return peer;
    peer = new Peer();
    peer.on('connection', handleConnection);
    return peer;
}

createRoomBtn.addEventListener('click', () => {
    createRoomBtn.disabled = true;
    createRoomBtn.innerText = "Creating...";
    
    initPeer().on('open', (id) => {
        currentRoom = id;
        showActiveRoomUI(id);
    });
});

joinRoomBtn.addEventListener('click', () => {
    const roomId = joinRoomInput.value.trim();
    if (!roomId) return;
    
    joinRoomBtn.disabled = true;
    initPeer().on('open', () => {
        const conn = peer.connect(roomId);
        handleConnection(conn);
        showActiveRoomUI(roomId);
    });
});

leaveRoomBtn.addEventListener('click', () => {
    connections.forEach(c => c.close());
    connections = [];
    if (peer) {
        peer.destroy();
        peer = null;
    }
    currentRoom = null;
    setupUI.classList.remove('hidden');
    activeSyncUI.classList.add('hidden');
    roomBadge.classList.add('hidden');
    createRoomBtn.disabled = false;
    createRoomBtn.innerText = "🏠 Create Sync Room";
    joinRoomBtn.disabled = false;
    updatePeerList();
});

function handleConnection(conn) {
    conn.on('open', () => {
        connections.push(conn);
        updatePeerList();
        
        conn.on('data', (data) => {
            if (data.type === 'scan') {
                handleRemoteScan(data.payload);
            }
        });
        
        conn.on('close', () => {
            connections = connections.filter(c => c.peer !== conn.peer);
            updatePeerList();
        });
    });
}

function broadcastScan(payload) {
    connections.forEach(conn => {
        conn.send({ type: 'scan', payload: payload });
    });
}

function handleRemoteScan(payload) {
    const duplicateKey = `${payload.id}-${payload.date}`;
    handleSuccess(payload.id, payload.time, duplicateKey, false);
}

function showActiveRoomUI(id) {
    setupUI.classList.add('hidden');
    activeSyncUI.classList.remove('hidden');
    activeRoomIdEl.innerText = id;
    roomBadge.classList.remove('hidden');
    roomNameEl.innerText = id.substring(0, 5) + "...";
    updatePeerList();
}

function updatePeerList() {
    peerCountEl.innerText = connections.length;
    peerListEl.innerHTML = '';
    connections.forEach(c => {
        const li = document.createElement('li');
        li.innerText = `Device: ${c.peer.substring(0, 8)}...`;
        peerListEl.appendChild(li);
    });
}

// --- CSV EXPORT ---
document.getElementById('export-csv-btn').addEventListener('click', async () => {
    const btn = document.getElementById('export-csv-btn');
    btn.disabled = true;
    btn.innerText = "⏳ Fetching Data...";
    
    try {
        const res = await fetch(SCRIPT_URL + '?action=export');
        const data = await res.json();
        
        if (!data || data.length === 0) {
            alert("No data found.");
            return;
        }
        
        let csvContent = "data:text/csv;charset=utf-8,";
        data.forEach(rowArray => {
            let row = rowArray.join(",");
            csvContent += row + "\r\n";
        });
        
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `inventory_export_${new Date().getTime()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
    } catch (e) {
        alert("Failed to fetch export data. Check internet connection.");
    } finally {
        btn.disabled = false;
        btn.innerText = "📥 Export to CSV";
    }
});

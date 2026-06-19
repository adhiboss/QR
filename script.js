// --- CONFIGURATION ---
// IMPORTANT: Replace this with the URL of your deployed Google Apps Script Web App
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxKHjx1ylCUzf5_9cPB20AwzCdmDFRRpmtORFRFcheDjCKf8L1QglpEr9lreAyKRkAG2g/exec';

// --- STATE ---
let totalScans = 0;
let isProcessing = false;
let manualScanRequested = false;
let scannedToday = new Set(); // To prevent duplicate scans locally

// --- DOM ELEMENTS ---
const totalScansEl = document.getElementById('total-scans');
const statusIndicatorEl = document.getElementById('status-indicator');
const scanActionBtn = document.getElementById('scan-action-btn');
const manualIdInput = document.getElementById('manual-id-input');
const manualSaveBtn = document.getElementById('manual-save-btn');
const lastScanEl = document.getElementById('last-scan');
const recentListEl = document.getElementById('recent-list');
const scanFrameEl = document.querySelector('.scan-frame');

// --- EVENT LISTENERS ---
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
    
    manualIdInput.value = ''; // clear input
    processScanResult(studentId);
});

// --- AUDIO (Beep Sound) ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep() {
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.type = 'sine';
    // A nice pleasant beep (high pitch, short duration)
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

// --- SCAN HANDLER ---
async function onScanSuccess(decodedText, decodedResult) {
    if (!manualScanRequested) return; // Wait for the user to click the button
    
    const studentId = decodedText.trim();
    if (!studentId) return;

    manualScanRequested = false;
    
    // Add visual feedback to scanner frame
    scanFrameEl.classList.add('success-anim');
    setTimeout(() => scanFrameEl.classList.remove('success-anim'), 500);
    
    await processScanResult(studentId);
}

async function processScanResult(studentId) {
    if (isProcessing) return; // Prevent multiple triggers for the same scan
    isProcessing = true;
    
    // Current Date and Time formatting
    const now = new Date();
    // Format: DD-MM-YYYY
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
    // Format: 09:45 AM
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    const duplicateKey = `${studentId}-${dateStr}`;
    
    // Check local duplicate for today
    if (scannedToday.has(duplicateKey)) {
        showStatus(`✅ Attendance Already Marked<br><small>${studentId}</small>`, 'warning');
        setTimeout(() => { isProcessing = false; resetStatus(); }, 2500);
        return;
    }

    // Mark as processing visually
    showStatus(`Saving ${studentId}...`, '');

    // Send to Google Sheets
    try {
        if(SCRIPT_URL !== 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
            // Using GET request to avoid CORS preflight issues with simple Web Apps
            const params = new URLSearchParams({
                id: studentId,
                date: dateStr,
                time: timeStr
            });
            
            const response = await fetch(`${SCRIPT_URL}?${params.toString()}`);
            const result = await response.json();
            
            if (result.status === 'success') {
                playBeep();
                handleSuccess(studentId, dateStr, timeStr, duplicateKey);
            } else if (result.status === 'duplicate') {
                scannedToday.add(duplicateKey);
                showStatus(`✅ Attendance Already Marked<br><small>${studentId}</small>`, 'warning');
            } else {
                throw new Error(result.message || 'Server error');
            }
        } else {
            // Simulated Success for Demonstration when URL is not set
            playBeep();
            handleSuccess(studentId, dateStr, timeStr, duplicateKey);
            console.warn("Using simulated success because SCRIPT_URL is not configured.");
        }
    } catch (error) {
        console.error('Error saving data:', error);
        showStatus(`❌ Failed to save<br><small>Check internet connection</small>`, 'error');
    }

    setTimeout(() => { isProcessing = false; resetStatus(); }, 2500);
}

function handleSuccess(studentId, dateStr, timeStr, duplicateKey) {
    scannedToday.add(duplicateKey);
    totalScans++;
    totalScansEl.innerText = totalScans;
    
    lastScanEl.innerText = studentId;
    showStatus(`✅ Attendance Recorded<br><small>${studentId}</small>`, 'success');
    
    // Add to recent list UI
    const li = document.createElement('li');
    li.innerHTML = `<span class="scan-id">${studentId}</span><span class="scan-time">${timeStr}</span>`;
    recentListEl.prepend(li);
    
    // Keep only the last 50 items in the DOM
    if (recentListEl.children.length > 50) {
        recentListEl.removeChild(recentListEl.lastChild);
    }
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

function onScanFailure(error) {
    // Failure is triggered constantly when no QR is in frame. 
    // We purposefully ignore it to keep the console clean.
}

// --- INITIALIZE SCANNER ---
document.addEventListener("DOMContentLoaded", () => {
    const html5QrCode = new Html5Qrcode("reader");
    
    // Make qrbox slightly smaller to ensure it fits on small phone screens
    const config = { 
        fps: 10, 
        qrbox: { width: 200, height: 200 },
        aspectRatio: 1.0,
        disableFlip: false
    };

    // Try starting the back camera automatically
    html5QrCode.start(
        { facingMode: "environment" }, 
        config,
        onScanSuccess,
        onScanFailure
    ).then(() => {
        resetStatus();
    }).catch(err => {
        // If environment camera fails, try a generic user fallback
        console.warn("Back camera failed, trying any camera", err);
        html5QrCode.start(
            { facingMode: "user" },
            config,
            onScanSuccess,
            onScanFailure
        ).then(() => {
            resetStatus();
        }).catch(fallbackErr => {
            showStatus(`❌ Camera Error<br><small>Please check permissions</small>`, 'error');
            console.error(fallbackErr);
        });
    });
});

# QR

USN Attendance Hub is a lightweight QR attendance web app with installable PWA support, live camera scanning, and local storage for attendance data.

## Features

- Scan USNs with the camera and mark attendance instantly.
- Automatically capture and store a photo snapshot for each accepted camera scan.
- Save extra camera snapshots manually from the app.
- Search the attendance log, student directory, and photo archive.
- Export attendance and rejected scans as CSV.
- Install the app to the device home screen and use it offline after the shell is cached.

## Storage

- Student database and attendance records are stored in `localStorage`.
- Captured scan photos and snapshots are stored locally in IndexedDB on the device.

## Notes

- Use a local web server instead of opening the app through `file://` so camera access, install prompts, and service-worker caching work correctly.

# Shorts Auto Next v1.5.0

Automatic advancement for YouTube Shorts.

## New in v1.5.0
- **Debug Button**: Added a "Debug" button to the mini-panel. Click it to see current status (Video found, Time, Armed status).
- **Enhanced Logging**: Added detailed console logs to help diagnose why it might not be scrolling.
- **Robust Next Logic**: Improved fallback mechanisms for navigating to the next Short.

## Installation
1. Download `yt-shorts-auto-next.zip` and extract it.
2. Open Chrome/Brave and go to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the extracted folder.

## Troubleshooting
- **Not working in background?** 
  - Go to `chrome://settings/performance` and add `youtube.com` to **Always keep these sites active** (disable Memory Saver for YouTube).
  - Keep your computer awake.
- **Still not scrolling?**
  - Click the **Debug** button on the mini-panel.
  - Right-click the page -> **Inspect** -> **Console**.
  - Look for `[SAN]` logs. If it's not working, let me know what the Debug popup says and what's in the console!

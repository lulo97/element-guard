// Element Guard - background service worker
// Handles the keyboard shortcut (Alt+Shift+E) to start the element picker.

async function startPickerOn(tab) {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_PICKER' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'START_PICKER' });
    } catch (e) {
      console.warn('Element Guard: cannot run on this page', e);
    }
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-picker') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  startPickerOn(tab);
});

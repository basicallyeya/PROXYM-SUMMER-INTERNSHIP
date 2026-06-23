'use strict';
/* content.js, runs on every page, has full chrome.runtime access.
   Handles: page info lookup, overlay button relay.
   (Speech recognition runs locally in recorder.js, see that file for why.) */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'GET_PAGE_INFO') {
    sendResponse({ url: window.location.href, title: document.title });
    return false;
  }

  /* Overlay buttons relay */
  if (msg.type === 'CONTROLBAR_STOP' || msg.type === 'CONTROLBAR_PAUSE' || msg.type === 'CONTROLBAR_RESUME') {
    chrome.runtime.sendMessage(msg);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

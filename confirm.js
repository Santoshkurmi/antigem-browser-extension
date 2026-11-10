// A question from the service worker (an agent wants a tab outside the AntiGem group, or VS Code wants to shorten the
// blocklist). Closing the window or waiting 2 minutes counts as Deny.
const id = location.hash.slice(1);
const $ = (x) => document.getElementById(x);
const answer = (allow) => {
  chrome.runtime.sendMessage({ antigem: 'confirm-answer', id, allow });
  window.close();
};
chrome.runtime.sendMessage({ antigem: 'confirm-info', id }).then((info) => {
  if (!info) {
    $('title').textContent = 'This request has expired';
    $('allow').disabled = true;
    return;
  }
  $('title').textContent = info.title;
  $('message').textContent = info.message;
  $('detail').textContent = info.detail;
  $('allow').textContent = info.allowLabel || 'Allow';
  $('deny').textContent = info.denyLabel || 'Deny';
});
$('allow').onclick = (e) => e.isTrusted && answer(true);
$('deny').onclick = (e) => e.isTrusted && answer(false);

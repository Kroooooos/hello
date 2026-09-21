const HEADERS = ["Time", "Who", "Date", "Time of day", "Plan", "Doesn't eat", "Note", "Times she dodged No", "Status"];
const PAGE_URL = "https://kroooooos.github.io/hello/";

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Date invite").addItem("New link…", "newLink").addToUi();
}

function newLink() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt("New link", "Her name (goes into the link):", ui.ButtonSet.OK_CANCEL);
  const who = res.getResponseText().trim();
  if (res.getSelectedButton() !== ui.Button.OK || !who) return;
  const url = PAGE_URL + "?" + encodeURIComponent(who);
  const html = HtmlService.createHtmlOutput(
    `<div style="font:14px sans-serif">
       <p>Link for <b>${escapeHtml(who)}</b>. Copy and send it:</p>
       <input id="u" value="${url}" readonly style="width:100%;padding:8px;font-size:14px" onclick="this.select()">
     </div>
     <script>document.getElementById("u").select()</script>`
  ).setWidth(420).setHeight(140);
  ui.showModalDialog(html, "Link ready");
}

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (d.website) return done();

  // Serialise writes so replies arriving at the same moment never land on the same row.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName("Replies") || ss.insertSheet("Replies");
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([
      new Date(),
      clean(d.who, 40) || "(no name in link)",
      clean(d.date, 10),
      clean(d.slot, 20),
      clean((d.activities || []).join(", "), 200),
      clean(d.diet, 200),
      clean(d.message, 1000),
      Number(d.no_clicks) || 0,
      "New",
    ]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return done();
}

function done() {
  return ContentService.createTextOutput('{"ok":true}').setMimeType(ContentService.MimeType.JSON);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// A leading = + - @ would be run as a spreadsheet formula.
function clean(value, max) {
  const s = String(value || "").trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

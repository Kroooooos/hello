const PAGE_URL = "https://kroooooos.github.io/hello/";
const REPLY_HEADERS = ["Time", "Who", "Link code", "Date", "Time of day", "Plan", "Doesn't eat", "Note", "Times she dodged No", "Status"];
const LINK_HEADERS = ["Code", "Who", "Link", "Created"];

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Date invite").addItem("New link…", "newLink").addToUi();
}

function newLink() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt("New link", "Who is this link for? (only you will see this)", ui.ButtonSet.OK_CANCEL);
  const who = res.getResponseText().trim();
  if (res.getSelectedButton() !== ui.Button.OK || !who) return;

  const links = sheet("Links", LINK_HEADERS);
  const used = new Set(links.getRange(1, 1, links.getLastRow(), 1).getValues().flat().map(String));
  let code;
  do code = randomCode(); while (used.has(code));
  const url = PAGE_URL + "?i=" + code;
  links.appendRow([code, who, url, new Date()]);

  const html = HtmlService.createHtmlOutput(
    `<div style="font:14px sans-serif">
       <p>Link for <b>${escapeHtml(who)}</b>. Copy and send it:</p>
       <input id="u" value="${url}" readonly style="width:100%;padding:8px;font-size:14px" onclick="this.select()">
       <p style="color:#777">Also saved in the Links tab.</p>
     </div>
     <script>document.getElementById("u").select()</script>`
  ).setWidth(420).setHeight(170);
  ui.showModalDialog(html, "Link ready");
}

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (d.website) return done();

  // Serialise writes so replies arriving at the same moment never land on the same row.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const code = /^[a-z0-9]{1,12}$/.test(d.code || "") ? d.code : "";
    sheet("Replies", REPLY_HEADERS).appendRow([
      new Date(),
      code ? whoFor(code) || "(unknown link)" : "(no link code)",
      code,
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

function whoFor(code) {
  const hit = sheet("Links", LINK_HEADERS).getRange("A:A").createTextFinder(code).matchEntireCell(true).findNext();
  return hit ? hit.offset(0, 1).getValue() : "";
}

function sheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function randomCode() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
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

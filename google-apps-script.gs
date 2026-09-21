const HEADERS = ["Time", "Name", "Contact", "Date", "Time of day", "Plan", "Doesn't eat", "Note", "Times she dodged No", "Status"];

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  if (d.website) return done();

  // Serialise writes so replies arriving at the same moment never land on the same row.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([
      new Date(),
      clean(d.nickname, 40),
      clean(d.contact, 80),
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

// A leading = + - @ would be run as a spreadsheet formula.
function clean(value, max) {
  const s = String(value || "").trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

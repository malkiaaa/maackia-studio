/**
 * Malkiaa Studio — Gmail notification webhook
 *
 * Deploy as a Google Apps Script Web App:
 *   Execute as: Me (the studio Gmail account)
 *   Who has access: Anyone
 *
 * Authentication is performed with a shared secret in the JSON request body.
 *
 * This webhook ONLY sends email. It does not insert or update order_tracks and
 * must never generate or write emailHash. The Supabase commission-api owns
 * normalized-email hashing and all commission/tracking database writes.
 *
 * Do not store the secret in source control or expose it to the browser.
 */

const SECRET_PROPERTY = "GAS_WEBHOOK_SECRET";
const SENT_PREFIX = "MALKIAA_SENT_";
const DEDUP_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Safe browser health check for the deployed Web App. This does not send email
 * and does not expose the webhook secret or recipient information.
 */
function doGet() {
  return jsonResponse({
    ok: true,
    service: "Malkiaa Studio Gmail webhook",
    method: "GET",
    message: "Web App is reachable. Email notifications are handled by POST."
  });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;

  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 150000) {
      return jsonResponse({ ok: false, status: "failed", message: "Invalid or oversized request body." });
    }

    const payload = JSON.parse(raw);
    const expectedSecret = PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY);
    if (!expectedSecret || !constantTimeEquals(String(payload.secret || ""), expectedSecret)) {
      return jsonResponse({ ok: false, status: "failed", message: "Unauthorized webhook request." });
    }

    const to = String(payload.to || "").trim().toLowerCase();
    const subject = String(payload.subject || "").trim().slice(0, 240);
    const html = String(payload.html || "");
    const text = String(payload.text || "").trim();
    const fromName = String(payload.fromName || "Malkiaa Studio").trim().slice(0, 100);
    const idempotencyKey = String(payload.idempotencyKey || "").trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return jsonResponse({ ok: false, status: "failed", message: "A valid recipient email is required." });
    }
    if (!subject || !html || html.length > 100000 || !text || text.length > 20000 || !idempotencyKey || idempotencyKey.length > 180) {
      return jsonResponse({ ok: false, status: "failed", message: "Required email fields are missing or invalid." });
    }

    // Serialize duplicate checks and sends. The second request waits, then sees
    // the successful key written by the first request.
    locked = lock.tryLock(30000);
    if (!locked) {
      return jsonResponse({ ok: false, status: "failed", message: "Webhook is busy. Retry this notification." });
    }

    const props = PropertiesService.getScriptProperties();
    pruneExpiredKeys(props);
    const key = SENT_PREFIX + sha256Hex(idempotencyKey);
    const alreadySentAt = props.getProperty(key);
    if (alreadySentAt) {
      return jsonResponse({
        ok: true,
        status: "sent",
        duplicate: true,
        message: "This notification was already sent.",
        sentAt: alreadySentAt
      });
    }

    const remainingQuota = MailApp.getRemainingDailyQuota();
    if (remainingQuota < 1) {
      return jsonResponse({ ok: false, status: "failed", message: "Gmail recipient quota is exhausted. Retry after the quota resets." });
    }

    MailApp.sendEmail({
      to: to,
      subject: subject,
      body: text,
      htmlBody: html,
      name: fromName,
      replyTo: "mmaackia@gmail.com"
    });

    const sentAt = new Date().toISOString();
    console.log("Malkiaa email accepted by MailApp", JSON.stringify({
      orderId: String(payload.orderId || "").slice(0, 40),
      kind: String(payload.kind || "").slice(0, 80),
      recipientDomain: to.split("@")[1] || "",
      recipientMasked: maskEmail(to),
      quotaBefore: remainingQuota,
      quotaAfter: MailApp.getRemainingDailyQuota(),
      sentAt: sentAt
    }));
    // Persist only successful sends. Failed attempts remain eligible for retry.
    props.setProperty(key, sentAt);

    return jsonResponse({ ok: true, status: "sent", duplicate: false, sentAt: sentAt });
  } catch (error) {
    console.error("Malkiaa Gmail webhook failed:", error && error.stack ? error.stack : error);
    return jsonResponse({
      ok: false,
      status: "failed",
      message: String(error && error.message ? error.message : "MailApp failed.").slice(0, 500)
    });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function jsonResponse(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function constantTimeEquals(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function maskEmail(email) {
  const parts = String(email || "").split("@");
  if (parts.length !== 2) return "invalid";
  const local = parts[0];
  return (local.length > 2 ? local.slice(0, 2) + "***" : "*") + "@" + parts[1];
}

function sha256Hex(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (byte) {
    const unsigned = (byte + 256) % 256;
    return ("0" + unsigned.toString(16)).slice(-2);
  }).join("");
}

function pruneExpiredKeys(props) {
  const all = props.getProperties();
  const cutoff = Date.now() - DEDUP_RETENTION_MS;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(SENT_PREFIX) !== 0) return;
    const timestamp = Date.parse(all[key]);
    if (!Number.isFinite(timestamp) || timestamp < cutoff) {
      props.deleteProperty(key);
    }
  });
}

/**
 * TEMPORARY Uji A — run manually exactly once from the Apps Script editor.
 * Sends one standalone test email; does not call Supabase, use the webhook
 * secret, write to the database, or use the webhook idempotency mechanism.
 *
 * Replace TEST_EMAIL_A_TO and TEST_EMAIL_A_NAME before running.
 * Remove this function and its constants after Uji A.
 */
const TEST_EMAIL_A_TO = "ISI_ALAMAT_GMAIL_DI_SINI";
const TEST_EMAIL_A_NAME = "Nama Client";
const TEST_EMAIL_A_REQUEST_ID = "TEST-COMMISSION-001";

function testEmailA() {
  const to = String(TEST_EMAIL_A_TO || "").trim().toLowerCase();
  const name = String(TEST_EMAIL_A_NAME || "").trim();
  const requestId = String(TEST_EMAIL_A_REQUEST_ID || "").trim();

  if (
    !to ||
    to === "isi_alamat_gmail_di_sini" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)
  ) {
    throw new Error("Isi TEST_EMAIL_A_TO dengan satu alamat Gmail penerima yang valid.");
  }
  if (!name || !requestId) {
    throw new Error("TEST_EMAIL_A_NAME dan TEST_EMAIL_A_REQUEST_ID wajib diisi.");
  }

  const remainingQuota = MailApp.getRemainingDailyQuota();
  if (remainingQuota < 1) {
    throw new Error("Kuota penerima Gmail hari ini sudah habis.");
  }

  const subject = "Permintaan komisi telah diterima";
  const body = [
    "Malkiaa Studio",
    "",
    "Halo " + name + ",",
    "",
    "Terima kasih telah mengirim request komisi ke Malkiaa Studio.",
    "Request Anda sudah kami terima dan akan ditinjau.",
    "",
    "Request ID: " + requestId,
    "",
    "Untuk melihat perkembangan, buka halaman Track Order di website Malkiaa Studio, lalu masukkan Request ID dan email Anda.",
    "Kabar berikutnya akan tersedia melalui Track Order.",
    "",
    "Balas email ini jika ada pertanyaan.",
    "",
    "Jika email ini masuk ke Spam, tekan 'Bukan spam' dan simpan alamat ini ke kontak Anda.",
    "",
    "Malkiaa Studio",
    "mmaackia@gmail.com"
  ].join("\n");

  const safeName = escapeTestEmailHtml(name);
  const safeRequestId = escapeTestEmailHtml(requestId);
  const html = [
    "<!doctype html>",
    "<html><body>",
    "<p>Malkiaa Studio</p>",
    "<p>Halo " + safeName + ",</p>",
    "<p>Terima kasih telah mengirim request komisi ke Malkiaa Studio.</p>",
    "<p>Request Anda sudah kami terima dan akan ditinjau.</p>",
    "<p>Request ID: <strong>" + safeRequestId + "</strong></p>",
    "<p>Untuk melihat perkembangan, buka halaman Track Order di website Malkiaa Studio, lalu masukkan Request ID dan email Anda.</p>",
    "<p>Kabar berikutnya akan tersedia melalui Track Order.</p>",
    "<p>Balas email ini jika ada pertanyaan.</p>",
    "<p>Jika email ini masuk ke Spam, tekan 'Bukan spam' dan simpan alamat ini ke kontak Anda.</p>",
    "<p>Malkiaa Studio<br>mmaackia@gmail.com</p>",
    "</body></html>"
  ].join("");

  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: body,
    htmlBody: html,
    name: "Malkiaa Studio",
    replyTo: "mmaackia@gmail.com"
  });

  Logger.log("Uji A sent to " + maskEmail(to) + ". Remaining quota: " + MailApp.getRemainingDailyQuota());
}

function escapeTestEmailHtml(value) {
  return String(value).replace(/[&<>"']/g, function (char) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char];
  });
}

/**
 * Run manually from the Apps Script editor to verify the MailApp permission.
 * This does not send an email.
 */
function checkMailQuota() {
  const remaining = MailApp.getRemainingDailyQuota();
  Logger.log("Remaining recipient quota: " + remaining);
  return remaining;
}

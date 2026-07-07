/**
 * SMS sender for the "your bill review is ready" nudge. Provider-aware, driven by
 * env:
 *   SMS_PROVIDER   clickatell | twilio   (which integration to use)
 *   SMS_API_KEY    Clickatell One-API integration key (clickatell)
 *   SMS_FROM       optional sender id / number
 *   SMS_API_URL    optional endpoint override
 *   Twilio only:   SMS_ACCOUNT_SID, SMS_AUTH_TOKEN (+ SMS_FROM required)
 *
 * With no/partial config — or under NODE_ENV=test — it logs instead of sending, so
 * the whole notification flow stays testable offline (same contract as sendEmail).
 * Returns a provider message ref on success, or null when it only logged.
 */
export async function sendSms(to: string, body: string): Promise<string | null> {
  if (process.env.NODE_ENV === "test") {
    return null;
  }

  const provider = (process.env.SMS_PROVIDER || "").toLowerCase();
  if (!provider) {
    console.warn(`[sms] SMS_PROVIDER not set — logging instead of sending. to=${to}`);
    return null;
  }

  try {
    switch (provider) {
      case "clickatell":
        return await sendViaClickatell(to, body);
      case "twilio":
        return await sendViaTwilio(to, body);
      default:
        console.warn(`[sms] unsupported SMS_PROVIDER='${provider}' — logging instead. to=${to}`);
        return null;
    }
  } catch (err) {
    // Surface to the caller (the dispatcher records a failed delivery) but keep the
    // message readable.
    throw new Error(`[sms:${provider}] ${err instanceof Error ? err.message : String(err)}`);
  }
}

// International number without the leading '+', digits only (what Clickatell wants).
function intlDigits(to: string): string {
  return to.replace(/[^\d]/g, "");
}

/**
 * Clickatell One API (platform.clickatell.com). Auth is the integration API key in
 * the Authorization header (no "Bearer"). The sender is whatever the integration
 * is configured with unless SMS_FROM is given.
 */
async function sendViaClickatell(to: string, body: string): Promise<string | null> {
  const apiKey = process.env.SMS_API_KEY;
  if (!apiKey) {
    console.warn(`[sms:clickatell] SMS_API_KEY not set — logging instead of sending. to=${to}`);
    return null;
  }
  const url = process.env.SMS_API_URL || "https://platform.clickatell.com/messages";
  const message: Record<string, string> = { channel: "sms", to: intlDigits(to), content: body };
  if (process.env.SMS_FROM) message.from = process.env.SMS_FROM;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ messages: [message] }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`send failed (${res.status}): ${text}`);
  }
  // One API returns { messages: [{ apiMessageId, accepted, ... }] }.
  try {
    const json = JSON.parse(text) as {
      messages?: Array<{ apiMessageId?: string; messageId?: string; accepted?: boolean; error?: unknown }>;
    };
    const m = json.messages?.[0];
    if (m && m.accepted === false) {
      throw new Error(`message rejected: ${JSON.stringify(m.error ?? m)}`);
    }
    return m?.apiMessageId ?? m?.messageId ?? "sent";
  } catch (e) {
    // Non-JSON 2xx — treat as sent but note it.
    if (e instanceof SyntaxError) return "sent";
    throw e;
  }
}

/** Twilio Messages API (Basic auth SID:token). SMS_FROM is required. */
async function sendViaTwilio(to: string, body: string): Promise<string | null> {
  const sid = process.env.SMS_ACCOUNT_SID;
  const token = process.env.SMS_AUTH_TOKEN;
  const from = process.env.SMS_FROM;
  if (!sid || !token || !from) {
    console.warn(`[sms:twilio] SMS_ACCOUNT_SID/SMS_AUTH_TOKEN/SMS_FROM not all set — logging. to=${to}`);
    return null;
  }
  const url =
    process.env.SMS_API_URL || `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });
  if (!res.ok) {
    throw new Error(`send failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json().catch(() => ({}))) as { sid?: string };
  return json.sid ?? "sent";
}

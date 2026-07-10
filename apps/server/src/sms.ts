/**
 * SMS sender for the "your bill review is ready" nudge. Uses Clickatell's One API,
 * driven by env:
 *   SMS_PROVIDER   clickatell    (the only supported provider)
 *   SMS_API_KEY    Clickatell One-API integration key (Authorization header, no "Bearer")
 *   SMS_FROM       optional sender id / number
 *   SMS_API_URL    optional endpoint override
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
  if (provider !== "clickatell") {
    console.warn(`[sms] unsupported SMS_PROVIDER='${provider}' (only 'clickatell') — logging. to=${to}`);
    return null;
  }

  try {
    return await sendViaClickatell(to, body);
  } catch (err) {
    // Surface to the caller (the dispatcher records a failed delivery) but keep the
    // message readable.
    throw new Error(`[sms:clickatell] ${err instanceof Error ? err.message : String(err)}`);
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
  // Clickatell's /messages endpoint wants a TOP-LEVEL `to` array + `content` — NOT a
  // `messages:[{channel,to,content}]` wrapper (that shape is silently rejected as
  // "Empty message content"). `from` is the optional sender id.
  const payload: Record<string, unknown> = { to: [intlDigits(to)], content: body };
  if (process.env.SMS_FROM) payload.from = process.env.SMS_FROM;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`send failed (${res.status}): ${text}`);
  }
  // Success shape: { messages: [{ apiMessageId, accepted, to }], error: null }. A
  // request-level failure carries a top-level `error` with an empty `messages`.
  try {
    const json = JSON.parse(text) as {
      error?: unknown;
      messages?: Array<{ apiMessageId?: string; messageId?: string; accepted?: boolean; error?: unknown }>;
    };
    if (json.error) {
      throw new Error(`request rejected: ${JSON.stringify(json.error)}`);
    }
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

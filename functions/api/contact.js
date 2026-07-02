// ===========================
// TicketScout — Contact form handler
// Runs as a Cloudflare Pages Function at /api/contact
//
// Receives a JSON POST from contact.html, validates the fields,
// and forwards the message to ticketandeventscout@gmail.com
// via the Resend email API (free tier: 100 emails/day).
//
// Setup steps (one time only):
//   1. Sign up free at resend.com
//   2. Create an API key in the Resend dashboard
//   3. Add it to Cloudflare Pages → Settings → Variables and secrets
//      as: RESEND_API_KEY (mark as Secret)
//   4. In Resend, verify a sending domain OR use the shared
//      onboarding address: onboarding@resend.dev (works immediately,
//      but can only send to the email you signed up with on free tier)
//      — for production, verify ticketscout.co.uk as a sending domain
//
// Required env vars:
//   RESEND_API_KEY  — your Resend API key (Secret)
// ===========================

const DESTINATION_EMAIL = 'ticketandeventscout@gmail.com';
const FROM_ADDRESS = 'TicketScout Contact <contact@ticketscout.co.uk>';
const RESEND_API = 'https://api.resend.com/emails';

export async function onRequestPost({ request, env }) {
  const apiKey = env.RESEND_API_KEY;

  if (!apiKey) {
    console.error('RESEND_API_KEY is not set');
    return jsonResponse({ error: 'Server configuration error.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  const { name, email, subject, message, website } = body;

  // Server-side honeypot check (belt and braces on top of client-side check)
  if (website) {
    return jsonResponse({ ok: true }, 200); // silently accept but don't send
  }

  // Server-side validation
  if (!name?.trim() || !email?.trim() || !subject?.trim() || !message?.trim()) {
    return jsonResponse({ error: 'All fields are required.' }, 400);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'Invalid email address.' }, 400);
  }

  // Basic length limits to prevent abuse
  if (name.length > 100 || email.length > 200 || subject.length > 200 || message.length > 5000) {
    return jsonResponse({ error: 'One or more fields exceed the maximum length.' }, 400);
  }

  // Build the email
  const emailPayload = {
    from: FROM_ADDRESS,
    to: [DESTINATION_EMAIL],
    reply_to: email,          // so you can reply directly to the sender
    subject: `TicketScout contact: ${subject}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <h2 style="color:#0c2d5a;margin-bottom:20px;">New contact form submission</h2>
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:10px 0;font-weight:600;color:#555;width:100px;vertical-align:top;">Name</td>
            <td style="padding:10px 0;color:#1a1a1a;">${escapeHtml(name)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;font-weight:600;color:#555;vertical-align:top;">Email</td>
            <td style="padding:10px 0;color:#1a1a1a;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td>
          </tr>
          <tr>
            <td style="padding:10px 0;font-weight:600;color:#555;vertical-align:top;">Subject</td>
            <td style="padding:10px 0;color:#1a1a1a;">${escapeHtml(subject)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;font-weight:600;color:#555;vertical-align:top;">Message</td>
            <td style="padding:10px 0;color:#1a1a1a;white-space:pre-wrap;">${escapeHtml(message)}</td>
          </tr>
        </table>
        <hr style="margin:24px 0;border:none;border-top:1px solid #e0e0e0;" />
        <p style="font-size:12px;color:#999;">Sent via ticketscout.co.uk contact form</p>
      </div>
    `
  };

  try {
    const resendResponse = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(emailPayload)
    });

    if (!resendResponse.ok) {
      const err = await resendResponse.text();
      console.error('Resend error:', err);
      return jsonResponse({ error: 'Failed to send message.' }, 502);
    }

    return jsonResponse({ ok: true }, 200);

  } catch (err) {
    console.error('Contact form error:', err);
    return jsonResponse({ error: 'Unable to send message.' }, 502);
  }
}

// ===========================
// Helpers
// ===========================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

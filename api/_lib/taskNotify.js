import express from 'express';
import nodemailer from 'nodemailer';

// ─── Task-created email notifications ────────────────────────────────────────
// POST /api/notify/task-created — sent by the frontend (taskSync.createTask)
// after a task is fully created. Recipients are resolved per project below;
// sending failures never affect task creation (the frontend fires-and-forgets).

// Per-project recipients. Key = project id from src/config/projects.js.
// A project without an entry falls back to TASK_NOTIFY_TO (comma-separated).
// V1: every project goes to the default recipient — add overrides here later,
// e.g.  NSMG: ['pm@dynamicalabs.com', 'lead@dynamicalabs.com'],
const PROJECT_RECIPIENTS = {
  ABS: [
    'kateryna.romanenko@dynamicalabs.com',
    'roman.merkulov@dynamicalabs.com',
    'arthur.sokolov@dynamicalabs.com',
  ],
  NSMG: [
    'dima.shyshov@dynamicalabs.com',
    'roman.merkulov@dynamicalabs.com',
  ],
  // NSMG_MARKER: [],
  // NSMGCM: [],
  // HT: [],
};

function recipientsFor(projectId) {
  const perProject = PROJECT_RECIPIENTS[projectId];
  if (Array.isArray(perProject) && perProject.length) return perProject;
  return String(process.env.TASK_NOTIFY_TO || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

let transporter = null;
function getTransporter() {
  const user = process.env.SMTP_USER;
  // Google shows app passwords in groups of 4 ("abcd efgh …") — people paste
  // them with the spaces, and real app passwords never contain whitespace.
  const pass = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 465);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }
  return transporter;
}

export async function sendEmail({ to, subject, html, text }) {
  const mailer = getTransporter();
  if (!mailer) {
    const err = new Error('SMTP is not configured — set SMTP_USER / SMTP_PASS in .env');
    err.notConfigured = true;
    throw err;
  }
  await mailer.sendMail({
    from: process.env.MAIL_FROM || `DNL Tasks <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
  });
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Email-client-safe HTML: tables + inline styles only (no flexbox/grid/classes).
export function buildEmail({ projectId, projectName, title, epicId, epicUrl, jiraKey, jiraUrl, createdBy }) {
  const proj = projectName || projectId || 'Unknown project';
  const ref  = jiraKey ? jiraKey : (epicId ? `#${epicId}` : '');
  const subject = `[${projectId || 'DNL'}] New request${ref ? ` ${ref}` : ''}: ${title}`;

  const when = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  }).format(new Date());

  const btn = (href, label, bg) => `
    <td style="padding:0 12px 0 0">
      <a href="${esc(href)}" target="_blank"
         style="display:inline-block;padding:10px 18px;background:${bg};color:#ffffff;
                text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;
                font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(label)}</a>
    </td>`;

  const metaRow = (label, value) => `
    <tr>
      <td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap;
                 font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(label)}</td>
      <td style="padding:6px 0;color:#111827;font-size:13px;
                 font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${value}</td>
    </tr>`;

  const html = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 12px">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0"
           style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;
                  border:1px solid #e5e7eb">
      <!-- Header -->
      <tr>
        <td style="background:#111827;padding:18px 28px">
          <span style="color:#ffffff;font-size:15px;font-weight:700;letter-spacing:.4px;
                       font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">DNL&nbsp;Tasks</span>
          <span style="color:#9ca3af;font-size:13px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
            &nbsp;·&nbsp;New request created</span>
        </td>
      </tr>
      <!-- Body -->
      <tr>
        <td style="padding:28px">
          <p style="margin:0 0 6px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:.6px;
                    font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(proj)}</p>
          <p style="margin:0 0 20px;color:#111827;font-size:19px;font-weight:700;line-height:1.35;
                    font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(title)}</p>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px">
            <tr>
              ${epicUrl ? btn(epicUrl, `Azure DevOps ${epicId ? '#' + epicId : ''}`.trim(), '#0078d4') : ''}
              ${jiraUrl ? btn(jiraUrl, `Jira ${jiraKey || ''}`.trim(), '#2563eb') : ''}
            </tr>
          </table>

          <table role="presentation" cellpadding="0" cellspacing="0"
                 style="border-top:1px solid #e5e7eb;padding-top:8px;width:100%">
            ${createdBy ? metaRow('Created by', esc(createdBy)) : ''}
            ${epicId ? metaRow('Azure work item', `<a href="${esc(epicUrl)}" style="color:#2563eb;text-decoration:none">#${esc(epicId)}</a>`) : ''}
            ${jiraKey ? metaRow('Jira issue', `<a href="${esc(jiraUrl)}" style="color:#2563eb;text-decoration:none">${esc(jiraKey)}</a>`) : ''}
            ${metaRow('Created at', esc(when))}
          </table>
        </td>
      </tr>
      <!-- Footer -->
      <tr>
        <td style="padding:14px 28px;background:#f9fafb;border-top:1px solid #e5e7eb">
          <p style="margin:0;color:#9ca3af;font-size:12px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
            Automated notification from the DNL Tasks Creator platform.</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`;

  const text = [
    `New request created in ${proj}`,
    '',
    title,
    '',
    createdBy ? `Created by: ${createdBy}` : '',
    epicId ? `Azure DevOps #${epicId}: ${epicUrl}` : '',
    jiraKey ? `Jira ${jiraKey}: ${jiraUrl}` : '',
    `Created at: ${when}`,
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

export function registerTaskNotifyRoutes(app) {
  app.post('/api/notify/task-created', express.json({ limit: '20kb' }), async (req, res) => {
    const { projectId, projectName, title, epicId, epicUrl, jiraKey, jiraUrl } = req.body ?? {};
    if (!title) return res.status(400).json({ error: 'title is required' });

    const to = recipientsFor(projectId);
    if (!to.length) {
      return res.status(503).json({ error: 'No recipients configured — set TASK_NOTIFY_TO in .env' });
    }
    const { subject, html, text } = buildEmail({
      projectId, projectName, title, epicId, epicUrl, jiraKey, jiraUrl,
      createdBy: req.authEmail,
    });

    try {
      await sendEmail({ to, subject, html, text });
      console.log(`[Task notify] sent "${title}" (${projectId ?? '?'}) → ${to.join(', ')}`);
      res.json({ ok: true, to });
    } catch (err) {
      console.error('[Task notify] send failed:', err.message);
      res.status(err.notConfigured ? 503 : 502).json({ error: `Email send failed: ${err.message}` });
    }
  });
}

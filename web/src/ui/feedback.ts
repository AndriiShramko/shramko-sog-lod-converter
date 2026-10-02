// Feedback on every screen: Bug · Idea · Cooperation (→ the contact form), plus the lead form.

import { sendLead, sendReport, track } from './api';
import { browserInfo, getRelease, gpuInfo, recentErrors } from './diagnostics';
import { lang, listFormat, t } from './i18n';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MIN_MS = 3000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const initFeedback = (getLog: () => string[]) => {
    const dlg = $<HTMLDialogElement>('fb');
    const form = dlg.querySelector('form')!;
    const status = form.querySelector<HTMLElement>('.form-status')!;
    const msg = form.querySelector<HTMLTextAreaElement>('textarea[name=message]')!;
    const contact = form.querySelector<HTMLInputElement>('input[name=contact]')!;
    const diag = form.querySelector<HTMLInputElement>('input[name=diag]')!;
    const hp = form.querySelector<HTMLInputElement>('input[name=website]')!;
    const send = $<HTMLButtonElement>('fb-send');
    let openedAt = 0;

    const kind = () => (form.querySelector<HTMLInputElement>('input[name=kind]:checked')?.value ?? 'bug') as 'bug' | 'idea' | 'coop';
    const sync = () => {
        const k = kind();
        form.querySelector<HTMLElement>('.fb-msg')!.hidden = k === 'coop';
        form.querySelector<HTMLElement>('.fb-coop')!.hidden = k !== 'coop';
        form.querySelector<HTMLElement>('.fb-diag')!.hidden = k !== 'bug';
        status.textContent = '';
    };
    form.addEventListener('change', sync);

    $('fb-open').addEventListener('click', () => {
        openedAt = Date.now();
        sync();
        dlg.showModal();
        track('feedback_open');
        msg.focus();
    });
    $('fb-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => {
        if (e.target === dlg) dlg.close();
    });
    $('fb-to-contact').addEventListener('click', () => dlg.close());

    send.addEventListener('click', async () => {
        const text = msg.value.trim();
        if (!text) {
            status.textContent = t('ui.fbEmpty');
            msg.focus();
            return;
        }
        // too-fast sends wait instead of failing (bots are filtered server-side)
        const wait = MIN_MS - (Date.now() - openedAt);
        send.disabled = true;
        status.textContent = t('ui.fbSending');
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const k = kind() === 'idea' ? 'idea' : 'bug';
        const withDiag = k === 'bug' && diag.checked;
        try {
            const r = await sendReport({
                kind: k,
                message: text,
                contact: contact.value.trim() || undefined,
                locale: lang,
                page: 'site',
                release: getRelease(),
                diagnosticsConsent: withDiag,
                diagnostics: withDiag ? { browser: browserInfo(), gpu: await gpuInfo(), errors: recentErrors(), log: getLog().slice(-150) } : undefined,
                website: hp.value,
                t: Date.now() - openedAt
            });
            status.innerHTML = '';
            const p = document.createElement('span');
            p.textContent = t('ui.fbOk', { id: r.id });
            status.appendChild(p);
            msg.value = '';
        } catch {
            status.textContent = t('ui.fbFail');
        } finally {
            send.disabled = false;
        }
    });

    // --- cooperation / lead form
    const lead = $<HTMLFormElement>('lead');
    const leadBtn = lead.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const leadStatus = lead.querySelector<HTMLElement>('.form-status')!;
    const leadOpened = Date.now();
    const leadState = () => {
        const role = lead.querySelector<HTMLInputElement>('input[name=role]:checked')?.value ?? '';
        const email = lead.querySelector<HTMLInputElement>('input[name=email]')!.value.trim();
        const consent = lead.querySelector<HTMLInputElement>('input[name=consent]')!.checked;
        const missing: string[] = [];
        if (!role) missing.push(t('ui.leadNeedRole'));
        if (!EMAIL.test(email)) missing.push(t('ui.leadNeedEmail'));
        if (!consent) missing.push(t('ui.leadNeedConsent'));
        return { role, email, consent, missing };
    };
    const leadSync = () => {
        const s = leadState();
        leadBtn.disabled = s.missing.length > 0;
        leadStatus.textContent = s.missing.length ? t('ui.leadNeed', { missing: listFormat(s.missing) }) : '';
    };
    lead.addEventListener('input', leadSync);
    lead.addEventListener('change', leadSync);
    leadSync();
    lead.addEventListener('submit', async (e) => {
        e.preventDefault();
        const s = leadState();
        if (s.missing.length) return leadSync();
        const wait = MIN_MS - (Date.now() - leadOpened);
        leadBtn.disabled = true;
        leadStatus.textContent = t('ui.fbSending');
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try {
            await sendLead({
                role: s.role,
                email: s.email,
                message: lead.querySelector<HTMLTextAreaElement>('textarea[name=message]')!.value.trim(),
                consent: s.consent,
                locale: lang,
                page: 'cooperate',
                website: lead.querySelector<HTMLInputElement>('input[name=website]')!.value,
                t: Date.now() - leadOpened
            });
            leadStatus.textContent = t('ui.leadOk');
            track('lead_submit', undefined, { role: s.role });
            lead.reset();
            leadBtn.disabled = true;
        } catch {
            leadStatus.textContent = t('ui.fbFail');
            leadBtn.disabled = false;
        }
    });
};

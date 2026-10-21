// Feedback on every screen: Bug · Idea · Cooperation (→ the contact form), plus the lead form.

import { gaEvent } from './analytics';
import { sendLead, sendReport, track } from './api';
import { browserInfo, getRelease, gpuInfo, recentErrors } from './diagnostics';
import { lang, listFormat, t } from './i18n';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MIN_MS = 3000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// form_start comes from GA4 Enhanced Measurement (form interactions, ON in the stream) with form_id =
// the form's id ("lead", "feedback"); sending our own as well would count every start twice.

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
        gaEvent('form_submit', { form_id: 'feedback' });
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
            gaEvent('feedback_send', { kind: k }); // after the server stored it
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
    // form_step once per step reached: role picked, a valid e-mail, consent ticked (never the values)
    const stepsDone = new Set<string>();
    const step = (name: string, done: boolean) => {
        if (!done || stepsDone.has(name)) return;
        stepsDone.add(name);
        gaEvent('form_step', { form_id: 'lead', step: name });
    };
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
        step('role', !!s.role);
        step('email', EMAIL.test(s.email));
        step('consent', s.consent);
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
        gaEvent('form_submit', { form_id: 'lead' });
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
            track('lead_submit'); // server counter
            // sendLead() resolves only on a 2xx answer: the lead is stored on the server
            gaEvent('generate_lead', { form_id: 'lead', lead_type: s.role });
            lead.reset();
            leadBtn.disabled = true;
        } catch {
            leadStatus.textContent = t('ui.fbFail');
            leadBtn.disabled = false;
        }
    });
};

// taskcell.dev request page: shows the placeholder form, preselects the plan from ?plan= and answers it in place.
// The form ships hidden and has no action: without this script there is nothing to submit, so nothing can be sent.
// With CHECKOUT=live the Worker drops the form (it is data-planned), and only the notice after a payment is left.
import { localise } from './prices.js';

const form = document.getElementById('request');
const params = new URLSearchParams(location.search);
const plan = params.get('plan');
if (form) {
  localise(form.plan);
  if ([...form.plan.options].some((o) => o.value === plan)) form.plan.value = plan;

  // shortcut: no backend, the form sends nothing; wire it to a real endpoint before hosting opens
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const sent = document.getElementById('sent');
    sent.hidden = false;
    sent.focus();
  });
  document.getElementById('request-nojs').hidden = true;
  form.hidden = false;
}
// Back from a checkout (the Worker's /checkout sends people here): say what happened, and after a pass offer Solo
// with the pass credited. `session` is the pass's checkout session, which the Worker turns into the same customer.
if (params.has('paid')) {
  const paid = document.getElementById('paid');
  if (params.get('paid') === 'pass' && params.get('session')) {
    const next = document.getElementById('paid-pass');
    next.querySelector('a').href = `/checkout?plan=solo&lang=${document.documentElement.lang}&pass=${encodeURIComponent(params.get('session'))}${params.has('test') ? '&test=1' : ''}`;
    next.hidden = false;
  }
  paid.hidden = false;
  paid.focus();
}

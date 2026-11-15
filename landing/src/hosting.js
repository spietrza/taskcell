// taskcell.dev request page: shows the placeholder form, preselects the plan from ?plan= and answers it in place.
// The form ships hidden and has no action: without this script there is nothing to submit, so nothing can be sent.
const form = document.getElementById('request');
const plan = new URLSearchParams(location.search).get('plan');
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

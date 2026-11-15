// taskcell.dev request page: preselects the plan from ?plan= and answers the placeholder form in place.
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

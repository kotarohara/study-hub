// Import CSS files here for hot module reloading to work.
import "./assets/styles.css";

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  const message = form.dataset.confirm;
  if (message && !globalThis.confirm(message)) {
    event.preventDefault();
  }
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-print]")) {
    globalThis.print();
  }
});

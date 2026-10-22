(() => {
  const page = document.currentScript?.dataset.page;
  if (!page || !globalThis.crypto?.randomUUID) return;
  const event = {
    event_id: crypto.randomUUID(),
    version: "1.0.0",
    name: "visit",
    occurred_at: new Date().toISOString(),
    page,
  };
  fetch("/__funnel/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, js: true }),
    keepalive: true,
  }).catch(() => {});
})();
